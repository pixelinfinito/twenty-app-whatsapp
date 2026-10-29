import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture guards (AR-11, AR-18, D-14).
 *
 * oxlint has no `no-restricted-syntax`, so the rule the spec asks for is
 * expressed here instead. That is not a downgrade: a lint rule warns, this
 * fails the build, and the failure message names the file that broke the seam.
 *
 * The invariant matters because "which code can talk to Meta?" must stay
 * answerable by reading one directory. A single convenient `fetch` elsewhere
 * would put an unretryable, unclassified, untokened call into production with
 * nothing to notice it.
 */

const SRC = join(process.cwd(), 'src');
const PROVIDER_DIR = join(SRC, 'providers', 'whatsapp');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });

const files = sourceFiles(SRC);

const outsideProvider = files.filter((file) => !file.startsWith(PROVIDER_DIR));

/**
 * Production modules only. Tests legitimately name Meta's hosts and stub
 * `fetch`; the rule is about what ships, and a guard that flagged its own
 * suite would be turned off within a week.
 *
 * `.integration-test.ts` counts as a test too — it ends in `-test.ts` rather
 * than `.test.ts`, which is exactly the kind of near-miss a suffix check gets
 * wrong, so the predicate is shared rather than repeated.
 */
const isTestFile = (file: string): boolean =>
  /\.(test|integration-test)\.tsx?$/.test(file) || file.includes('__tests__');
const productionOutsideProvider = outsideProvider.filter(
  (file) => !isTestFile(file),
);

/**
 * Comments are prose about the rule, not violations of it — this file's own
 * doc comments would otherwise fail it, and `// worker has something to fetch`
 * genuinely did.
 *
 * Only block comments and whole comment lines are removed. Stripping trailing
 * `//` would eat the `//` in a URL literal and hide exactly the violation the
 * first assertion looks for.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

const contentsOf = (file: string) => stripComments(readFileSync(file, 'utf8'));

const offenders = (pattern: RegExp, candidates: string[]): string[] =>
  candidates.filter((file) => pattern.test(contentsOf(file))).map((file) => relative(SRC, file));

describe('the Meta seam', () => {
  it('confines the Graph API host to src/providers/whatsapp', () => {
    expect(offenders(/graph\.facebook\.com/, productionOutsideProvider)).toEqual([]);
  });

  /**
   * The rule AR-11 actually wants. Confining the hostname is not enough: the
   * media CDN URL arrives *inside* Meta's payload, so a module could download
   * from it without ever naming a host. One HTTP layer means one `fetch`.
   *
   * `server/files.ts` is the single exception, and it exists because an
   * outbound attachment's bytes live in Twenty's own storage — not Meta's — and
   * the SDK's REST client reads every response with `.text()`, which corrupts
   * binary content silently. The exception is narrowed by the next test rather
   * than by trust.
   */
  const HTTP_CALLERS = ['server/files.ts'];

  const withoutHttpCallers = productionOutsideProvider.filter(
    (file) => !HTTP_CALLERS.some((allowed) => file.endsWith(allowed)),
  );

  it('keeps every outbound HTTP call inside the provider', () => {
    expect(offenders(/\bfetch\s*\(/, withoutHttpCallers)).toEqual([]);
  });

  /**
   * What keeps the exception an exception.
   *
   * A file reader that would fetch any URL handed to it is a general HTTP
   * client wearing a different name — and the URL it would most plausibly be
   * handed is Meta's media CDN, which is precisely what AR-11 exists to route
   * through one place.
   *
   * The rule used to be "compare origins and refuse a mismatch". D-58 replaced
   * it with a stronger one: the first request's origin is *built* from
   * `TWENTY_API_URL`, so no input can name the host, and the path must be
   * inside the file store. `files.test.ts` asserts the behaviour; this asserts
   * the construction is still the one that produces it, since an origin
   * assembled from the supplied URL instead would reintroduce the hole
   * silently.
   */
  it('lets the one HTTP exception fetch only the workspace origin', () => {
    const source = contentsOf(join(SRC, 'server', 'files.ts'));

    expect(source).toMatch(/new URL\(expected\.origin\)/);
    expect(source).toMatch(/supplied\.pathname\.startsWith\(mount\)/);
    expect(source).toMatch(/resolveFileUrl\(/);
    expect(source).not.toMatch(/startsWith\s*\(\s*base/);
  });

  /**
   * Redirects are the other way out of the guard, and the module follows them
   * — an object-storage backend answers a file read with a 302 to a pre-signed
   * URL, so refusing them refused every attachment on such a deployment. What
   * must never happen is the app's workspace token travelling to whatever host
   * the redirect named, so `redirect: 'follow'` is banned outright: it would
   * hand the header off without anyone deciding to.
   */
  it('never lets fetch follow a redirect on the app’s behalf', () => {
    const source = contentsOf(join(SRC, 'server', 'files.ts'));

    expect(source).toMatch(/redirect:\s*'manual'/);
    expect(source).not.toMatch(/redirect:\s*'follow'/);
    expect(source).toMatch(/new URL\(url\)\.origin === origin/);
  });

  /**
   * Three exceptions, all narrow and all necessary:
   *
   *  - `application-config.ts` *declares* the variables. Declaring a secret is
   *    not reading one.
   *  - `logger.ts` reads their values to redact them. To replace a secret in a
   *    log line you must know what it looks like, so the redactor is the one
   *    module that has to see all of them — which is exactly why it is also the
   *    only module allowed to write to the console.
   *  - `copy.ts` *names* one in a remedy sentence. "Set META_APP_SECRET" is
   *    the entire value of that sentence — an operator told only that "the
   *    signature was rejected" has to go looking for which of four variables
   *    is wrong. Naming a variable is not reading it, and the test below holds
   *    the catalog to that: it may say the name and may not read the value.
   */
  const SECRET_READERS = [
    'application-config.ts',
    'server/logger.ts',
    'components/common/copy.ts',
  ];

  /**
   * The licence granted to `copy.ts` above, bounded. It is a string table with
   * no environment access, and it must stay one — the moment it reads
   * `process.env` it stops being a catalog that mentions a secret and becomes
   * a module that handles one.
   */
  it('keeps the copy catalog free of environment access', () => {
    const source = contentsOf(join(SRC, 'components', 'common', 'copy.ts'));

    expect(source).not.toMatch(/process\.env/);
  });

  const withoutSecretReaders = productionOutsideProvider.filter(
    (file) => !SECRET_READERS.some((allowed) => file.endsWith(allowed)),
  );

  it('keeps the access token out of every module but the provider', () => {
    expect(offenders(/META_ACCESS_TOKEN/, withoutSecretReaders)).toEqual([]);
  });

  it('keeps the app secret to the provider and the config declaration', () => {
    expect(offenders(/META_APP_SECRET/, withoutSecretReaders)).toEqual([]);
  });

  /**
   * The corollary rule. The redactor's licence to read secrets is only safe
   * while it is the sole writer to the console — anything else logging directly
   * would bypass it entirely.
   */
  it('keeps console output to the logger', () => {
    const candidates = files.filter(
      (file) =>
        !isTestFile(file) && !file.endsWith('server/logger.ts'),
    );

    expect(offenders(/\bconsole\.(log|warn|error|info|debug)\s*\(/, candidates)).toEqual([]);
  });
});

describe('the single send path', () => {
  /**
   * AR-11's actual claim: exactly one function may call
   * `POST /{phone_number_id}/messages`. Everything else creates a queued
   * message and schedules a job.
   *
   * The invariant is not about tidiness. Retry, lane pacing, the policy
   * re-check, media resolution and error classification are one inseparable
   * piece of behaviour; a second caller would have to reproduce all five, and
   * the one it would omit is the re-check — which is exactly the defect that
   * sends a campaign message into a window that closed while it was queued.
   */
  const logicFunctions = files.filter(
    (file) =>
      file.startsWith(join(SRC, 'logic-functions')) &&
      !isTestFile(file),
  );

  it('lets exactly one logic function call sendMessage', () => {
    const callers = logicFunctions
      .filter((file) => /\.sendMessage\s*\(/.test(contentsOf(file)))
      .map((file) => relative(SRC, file));

    expect(callers).toEqual(['logic-functions/wa-outbound-sender.ts']);
  });

  /**
   * `markAsRead` is the deliberate second provider call from elsewhere
   * (specs/04 §8) — a read receipt is not a message, is not billed, and must
   * not consume send capacity, which is why it bypasses the scheduler. Named
   * here so the exception is visible rather than merely absent from the rule
   * above.
   */
  it('confines the read-receipt call to the thread actions route', () => {
    const callers = logicFunctions
      .filter((file) => /\.markAsRead\s*\(/.test(contentsOf(file)))
      .map((file) => relative(SRC, file));

    expect(callers).toEqual(['logic-functions/wa-thread-actions-route.ts']);
  });
});

describe('provider construction', () => {
  /**
   * Constructing the Cloud API provider directly bypasses `WA_PROVIDER`, so a
   * caller that did it would ignore the seam without any import error.
   */
  it('routes every construction through getProvider()', () => {
    expect(offenders(/createCloudApiProvider/, productionOutsideProvider)).toEqual([]);
  });
});

describe('destructive writes', () => {
  /**
   * Every hard delete goes through `server/erasure.ts`.
   *
   * The app role holds `canDestroyAllObjectRecords`, and it has to: SEC-8's
   * subject erasure must remove content rather than flag it, since a
   * soft-deleted row still holds the message it was supposed to erase. With the
   * flag off the erasure route answered `500` while its dry run reported
   * correctly — a role setting meant to prevent accidental deletion preventing
   * the deliberate one instead.
   *
   * A role cannot tell one handler from another, so the control lives here
   * instead, where it names the module and fails the build. Anything else that
   * needs to destroy records is a deliberate addition to this list with its own
   * reason, not an accident.
   *
   * The second entry is the retention purge's (SEC-9), and it is confined to
   * `whatsappWebhookEvent`. It has to hard-delete because `dedupKey` carries a
   * unique index: a soft-deleted row keeps its indexed value, so a Meta
   * redelivery of a purged change would collide, be counted as a duplicate, and
   * be discarded — permanently, with nothing left to replay it from. Probe P-4
   * has not run, so this assumes the unfavourable answer.
   *
   * Message *content* is purged by blanking columns, never by deleting rows —
   * counts, delivery reporting and cost attribution have to survive a content
   * purge (specs/10 §4.2), which is why no destroy call appears in
   * `wa-retention-purge.ts` itself.
   */
  const DESTROY_CALLERS = ['server/erasure.ts', 'server/repositories/webhook-events.ts'];

  it('confines hard deletes to the erasure routine', () => {
    const candidates = files.filter(
      (file) =>
        !isTestFile(file) &&
        !DESTROY_CALLERS.some((allowed) => file.endsWith(allowed)),
    );

    expect(offenders(/\bdestroy[A-Z]\w*\s*:/, candidates)).toEqual([]);
  });
});

describe('the campaign state machine', () => {
  /**
   * Every campaign status change goes through `transitionCampaign`.
   *
   * Two functions move campaigns and they run concurrently by design: an admin
   * can press pause while a runner tick is claiming a batch. Writing the column
   * directly skips the edge validation, and the edges are what make "cancel is
   * final" and "a completed campaign cannot resume" true rather than merely
   * intended.
   *
   * This was not hypothetical. The sender paused a campaign on a
   * `terminal_content` rejection by patching the column, so a rejection
   * arriving after the last message had been accounted for would write `PAUSED`
   * over `COMPLETED` — resurrecting a finished campaign into a state an admin
   * can resume.
   */
  const STATUS_WRITERS = ['server/campaign-state.ts'];

  it('writes campaign status only through the transition helper', () => {
    const candidates = files.filter(
      (file) =>
        !isTestFile(file) && !STATUS_WRITERS.some((allowed) => file.endsWith(allowed)),
    );

    const offending = candidates.filter((file) =>
      /patchCampaign\s*\([^)]*,\s*\{[^}]*\bstatus\s*:/s.test(contentsOf(file)),
    );

    expect(offending.map((file) => relative(SRC, file))).toEqual([]);
  });
});

describe('command menu availability', () => {
  /**
   * D-63. `conditionalAvailabilityExpression` is compiled from the *source* of
   * a real comparison against the SDK's context bindings, and
   * `'numberOfSelectedRecords === 1'` — the same thing in quotes — type-checks,
   * builds, installs, and then never matches. The People command was absent
   * from the command menu in every situation, including the single-selection
   * one it was written for, and nothing anywhere reported a problem.
   *
   * A string is the only wrong shape that looks right, so it is the one thing
   * checked.
   */
  const commandMenuFiles = files.filter(
    (file) => file.startsWith(join(SRC, 'command-menu-items')) && !isTestFile(file),
  );

  it('has command menu items to check', () => {
    expect(commandMenuFiles.length).toBeGreaterThan(0);
  });

  it('never writes an availability expression as a string', () => {
    const offending = commandMenuFiles.filter((file) =>
      /conditionalAvailabilityExpression:\s*['"`]/.test(contentsOf(file)),
    );

    expect(offending.map((file) => relative(SRC, file))).toEqual([]);
  });
});

describe('logic function discovery', () => {
  /**
   * One function per file, declared on the **default** export.
   *
   * The SDK discovers logic functions by reading each file's default export.
   * A second `defineLogicFunction` assigned to a named export type-checks,
   * builds, and is then silently absent from the manifest — the route 404s and
   * nothing anywhere says why. `wa-template-submit` was written that way
   * because the spec suggested folding it in beside `wa-template-sync`; it was
   * caught by noticing a plan that was missing a function, which is not a thing
   * anyone should have to notice twice.
   */
  const logicFunctionFiles = files.filter(
    (file) => file.startsWith(join(SRC, 'logic-functions')) && !isTestFile(file),
  );

  it('declares every logic function on the default export', () => {
    const offending: string[] = [];

    for (const file of logicFunctionFiles) {
      const source = contentsOf(file);
      const declarations = source.match(/defineLogicFunction\s*\(/g)?.length ?? 0;

      if (declarations === 0) continue;

      const isDefault = /export\s+default\s+defineLogicFunction\s*\(/.test(source);

      if (declarations > 1 || !isDefault) {
        offending.push(`${relative(SRC, file)}: ${declarations} declaration(s)`);
      }
    }

    expect(offending).toEqual([]);
  });

  /**
   * MCP gets two deliberately narrow surfaces: catalogue discovery and one
   * idempotent template send. Accidentally exposing the workflow action as a
   * tool would bypass the exact-id/request-id contract and misattribute sends.
   */
  it('exposes only the two dedicated WhatsApp MCP tools', () => {
    const tools = logicFunctionFiles
      .filter((file) => /\btoolTriggerSettings\s*:/.test(contentsOf(file)))
      .map((file) => relative(SRC, file))
      .sort();

    expect(tools).toEqual([
      'logic-functions/wa-list-sendable-templates-tool.ts',
      'logic-functions/wa-send-template-tool.ts',
    ]);

    for (const file of tools) {
      const source = contentsOf(join(SRC, file));

      expect(source).toMatch(/toolTriggerSettings\s*:\s*\{\s*inputSchema\s*:/);
      expect(source).toMatch(/additionalProperties\s*:\s*false/);
    }
  });
});

describe('repository reads', () => {
  /**
   * Twenty's *singular* record query answers a missing record with a GraphQL
   * error (`RECORD_NOT_FOUND`), not with `null`. genql raises it, so a finder
   * written the obvious way throws where its signature promises `null` — the
   * caller's not-found branch is dead code, a deleted record becomes a 500
   * rather than a 404, and inside a queued job it becomes a lost job.
   *
   * Live-only defect: it typechecks, and every unit test that stubs the client
   * passes. The plural query with an id filter answers an empty connection
   * instead, which is what every finder now uses.
   */
  const repositoryFiles = files.filter(
    (file) =>
      file.startsWith(join(SRC, 'server', 'repositories')) && !isTestFile(file),
  );

  const SINGULAR_QUERIES = [
    'whatsappAccount',
    'whatsappThread',
    'whatsappMessage',
    'whatsappTemplate',
    'whatsappCampaign',
    'whatsappCampaignRecipient',
    'whatsappConsentEvent',
    'whatsappWebhookEvent',
    'person',
  ];

  it('scanned the repositories', () => {
    expect(repositoryFiles.length).toBeGreaterThan(5);
  });

  it('never selects a record through the singular query', () => {
    const offending: string[] = [];

    for (const file of repositoryFiles) {
      const source = contentsOf(file);

      for (const name of SINGULAR_QUERIES) {
        // `client.query({ whatsappThread: {` — the plural `whatsappThreads:`
        // must not match, hence the explicit colon after the exact name.
        if (new RegExp(`\\{\\s*${name}:\\s*\\{`).test(source)) {
          offending.push(`${relative(SRC, file)}: ${name}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });
});

describe('the source tree itself', () => {
  it('was actually scanned', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(productionOutsideProvider.length).toBeGreaterThan(40);
  });
});

describe('build-time versus runtime modules', () => {
  /**
   * The logic-function bundler replaces every value imported from
   * `twenty-sdk/define` with `__anyStub` — it is the module that *builds the
   * manifest*, not one that runs inside a function. A derived constant like
   * `getFieldUniversalIdentifier(...)` therefore evaluates to nothing at
   * runtime, and nothing warns: the type checker still sees a `string`, the
   * bundle builds, the app applies, and the first real call fails with a
   * GraphQL error naming neither the constant nor the cause.
   *
   * That cost an afternoon once. Runtime code asks the server for metadata
   * identifiers instead (`server/metadata-ids.ts`).
   */
  const runtimeDirs = [join(SRC, 'logic-functions'), join(SRC, 'server')];

  const runtimeFiles = files.filter(
    (file) =>
      runtimeDirs.some((dir) => file.startsWith(dir)) && !isTestFile(file),
  );

  it('scanned the runtime tree', () => {
    expect(runtimeFiles.length).toBeGreaterThan(15);
  });

  /**
   * The `define*` factories are the exception, and the only one: their whole
   * purpose is to be read at build time, and their return value is never used
   * at runtime, so a stub is harmless. Everything else from that module —
   * `getFieldUniversalIdentifier`, `STANDARD_OBJECT`, `FieldType` — produces a
   * value some line of running code will read, and there the stub is the bug.
   */
  it('imports only the define* factories from twenty-sdk/define', () => {
    const offending: string[] = [];

    for (const file of runtimeFiles) {
      for (const match of contentsOf(file).matchAll(
        /import\s+\{([^}]*)\}\s+from\s+'twenty-sdk\/define'/g,
      )) {
        const imported = match[1]!
          .split(',')
          .map((name) => name.trim().split(/\s+as\s+/)[0]!.trim())
          .filter((name) => name.length > 0 && !name.startsWith('type '));

        if (imported.some((name) => !/^define[A-Z]/.test(name))) {
          offending.push(`${relative(SRC, file)}: ${imported.join(', ')}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });

  /**
   * The same trap one step removed: a module that derives identifiers is safe
   * to import for its types, but importing its *values* into runtime code
   * re-introduces the stub.
   */
  it('imports no derived field identifiers into runtime code', () => {
    const offending = runtimeFiles.filter((file) =>
      /from\s+'[^']*constants\/field-identifiers'/.test(contentsOf(file)),
    );

    expect(offending.map((file) => relative(SRC, file))).toEqual([]);
  });
});

/**
 * Copy keys (FR-UI-5).
 *
 * A `t('campaign.col.nmae')` renders as `campaign.col.nmae` on screen — chosen
 * deliberately over rendering nothing, because a blank denial reads as "you may
 * send". But visible is not the same as noticed, and a large mechanical sweep
 * of inline strings onto a catalog is exactly where a typo hides.
 *
 * Only literal keys can be checked. `t(`campaign.counter.${key}`)` and
 * `t(`policy.${reason}`)` are resolved from server values at runtime, and the
 * catalog carries a row for every value those can take.
 */
describe('copy catalog', () => {
  const componentFiles = files.filter(
    (file) => file.startsWith(join(SRC, 'components')) && !isTestFile(file),
  );

  it('scanned the component tree', () => {
    expect(componentFiles.length).toBeGreaterThan(8);
  });

  it('uses no copy key that the catalog does not define', async () => {
    const { TABLES } = await import('../components/common/copy');
    const known = new Set(Object.keys(TABLES.pt));
    const missing: string[] = [];

    for (const file of componentFiles) {
      for (const match of contentsOf(file).matchAll(/\bt\('([^']+)'/g)) {
        const key = match[1]!;

        if (!known.has(key)) missing.push(`${relative(SRC, file)}: ${key}`);
      }
    }

    expect(missing).toEqual([]);
  });

  /**
   * The other direction is a warning, not a failure: a key can legitimately be
   * reached only through interpolation, and deleting one because a scanner
   * could not see it used would remove the copy for a Meta error code that
   * appears twice a year.
   */
  it('was able to resolve the catalog', async () => {
    const { TABLES } = await import('../components/common/copy');

    expect(Object.keys(TABLES.pt).length).toBeGreaterThan(100);
  });
});
