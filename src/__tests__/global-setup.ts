import * as path from 'path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { APPLICATION_UNIVERSAL_IDENTIFIER } from '../constants/universal-identifiers';

const APP_PATH = process.cwd();
const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, [path.join(APP_PATH, 'node_modules/twenty/dist/cli.cjs'), ...args, '--no-input', '--json'], { env: process.env, maxBuffer: 10 * 1024 * 1024 });

function validateEnv(): { apiUrl: string; apiKey: string } {
  const apiUrl = process.env.TWENTY_API_URL;
  const apiKey = process.env.TWENTY_API_KEY;

  if (!apiUrl || !apiKey) {
    throw new Error(
      'TWENTY_API_URL and TWENTY_API_KEY must be set.\n' +
        'Start the disposable Twenty 2.54 server\n' +
        'Or set them in vitest env config.',
    );
  }

  return { apiUrl, apiKey };
}

async function checkServer(apiUrl: string) {
  let response: Response;

  try {
    response = await fetch(`${apiUrl}/healthz`);
  } catch {
    throw new Error(
      `Twenty server is not reachable at ${apiUrl}. ` +
        'Make sure the server is running before executing integration tests.',
    );
  }

  if (!response.ok) {
    throw new Error(`Server at ${apiUrl} returned ${response.status}`);
  }
}

/**
 * Refuses to run against a workspace that holds real WhatsApp data.
 *
 * This setup **uninstalls the app after every run**, which deletes
 * every record its objects own — conversations, messages, media, campaign
 * history, the connected number and its routing claim. That is correct for a
 * scratch workspace and catastrophic for the one an operator has connected a
 * live number to, and nothing about typing `yarn test` suggests the difference.
 *
 * A count of zero means there is nothing to lose. Any other answer stops, and
 * says how to override deliberately.
 */
async function assertWorkspaceIsDisposable(apiUrl: string, apiKey: string) {
  if (process.env.WA_ALLOW_DESTRUCTIVE_TESTS === 'true') return;

  const count = async (collection: string): Promise<number> => {
    try {
      const response = await fetch(`${apiUrl}/graphql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query { ${collection}(first: 1) { totalCount } }`,
        }),
      });

      const body = (await response.json()) as {
        data?: Record<string, { totalCount?: number } | null>;
      };

      return body.data?.[collection]?.totalCount ?? 0;
    } catch {
      // The object does not exist, so the app is not installed: nothing to lose.
      return 0;
    }
  };

  const populated: string[] = [];

  for (const collection of ['whatsappAccounts', 'whatsappThreads', 'whatsappMessages']) {
    const total = await count(collection);

    if (total > 0) populated.push(`${collection}: ${total}`);
  }

  if (populated.length === 0) return;

  throw new Error(
    [
      'Refusing to run integration tests: this workspace holds WhatsApp data.',
      `Found ${populated.join(', ')}.`,
      '',
      'These tests uninstall the app after the run, which deletes every',
      'one of those records — including a connected number and its routing claim.',
      '',
      'Point TWENTY_API_URL at a scratch workspace, or set',
      'WA_ALLOW_DESTRUCTIVE_TESTS=true if you genuinely mean to erase this one.',
    ].join('\n'),
  );
}

/**
 * The routes refuse machine callers unless `WA_ALLOW_API_KEY_ADMIN` is on
 * (SEC-5) — and this suite *is* a machine caller: every request it makes
 * carries the API key. So the flag is switched on for the scratch workspace,
 * explicitly, the same way a real automation operator would.
 */
async function enableApiKeyRoutes(apiUrl: string, apiKey: string) {
  const call = async (query: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${apiUrl}/metadata`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    const body = (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: { message?: string }[];
    };

    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message).join('; '));
    }

    return body.data ?? {};
  };

  const found = (await call(
    `query { findOneApplication(universalIdentifier: "${APPLICATION_UNIVERSAL_IDENTIFIER}") { id } }`,
  )) as { findOneApplication?: { id?: string } };

  const applicationId = found.findOneApplication?.id;

  if (typeof applicationId !== 'string') {
    throw new Error('Could not find the installed application to enable WA_ALLOW_API_KEY_ADMIN');
  }

  await call(
    `mutation { updateOneApplicationVariable(key: "WA_ALLOW_API_KEY_ADMIN", value: "true", applicationId: "${applicationId}") }`,
  );
}

let installedBySuite = false;

export async function setup() {
  const { apiUrl, apiKey } = validateEnv();

  await checkServer(apiUrl);
  await assertWorkspaceIsDisposable(apiUrl, apiKey);

  await cli('app', 'apply', '--create');
  installedBySuite = true;

  await enableApiKeyRoutes(apiUrl, apiKey);
}

export async function teardown() {
  if (installedBySuite) await cli('app', 'uninstall', '--yes');
}
