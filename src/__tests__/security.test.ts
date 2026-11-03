import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SystemPermissionFlag } from 'twenty-sdk/define';
import agentRole from '../roles/whatsapp-agent.role';
import adminRole from '../roles/whatsapp-admin.role';
import { OBJ_MESSAGE, OBJ_THREAD } from '../constants/universal-identifiers';

import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  QUALITY,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
  type Lane,
  type Quality,
  type TemplateCategory,
} from '../domain/constants';
import {
  DENIAL,
  evaluateSendPermission,
  type SendContext,
} from '../domain/policy/send-permission';

/**
 * The security review, as tests (10.10, specs/12 §Security, specs/10).
 *
 * A review is a document that is true on the day it is signed. These are the
 * three parts of it that must stay true afterwards, so they are assertions
 * rather than paragraphs:
 *
 *  - **The role matrix** (SEC-5). Object permissions protect the Core API; they
 *    do not protect our HTTP routes, which run as the *app's* role. The only
 *    thing standing between a logged-in agent and connecting a phone number is
 *    a `requireRole` call at the top of a handler — so a route that forgets one
 *    is a hole with no symptom, and the check is static and exhaustive.
 *  - **The consent block** (SEC-6). An opt-out must be unoverridable by any
 *    role, category, lane or account state. Asserted as a full matrix rather
 *    than as examples, because "which combination did we not think of" is
 *    exactly the question a review is supposed to answer.
 *  - **The secret scan** (SEC-1, AR-3). Front components run in a browser
 *    sandbox. A secret that reaches one is public.
 */

const SRC = join(process.cwd(), 'src');

it.each([agentRole.config, adminRole.config])('grants $label file access while protecting message and thread writes', (role) => {
  expect(role.permissionFlagUniversalIdentifiers).toEqual(
    expect.arrayContaining([SystemPermissionFlag.UPLOAD_FILE, SystemPermissionFlag.DOWNLOAD_FILE]),
  );
  expect(role.canUpdateAllObjectRecords).toBe(false);
  expect(role.canAccessAllTools).toBe(false);
  expect(role.canBeAssignedToAgents).toBe(true);
  expect(role.canBeAssignedToApiKeys).toBe(true);
  expect(role.objectPermissions?.every((entry) => entry.canUpdateObjectRecords === false)).toBe(true);
  for (const objectUniversalIdentifier of [OBJ_MESSAGE, OBJ_THREAD]) {
    expect(role.objectPermissions?.find((entry) => entry.objectUniversalIdentifier === objectUniversalIdentifier)).toMatchObject({
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    });
  }
});
const LOGIC_FUNCTIONS = join(SRC, 'logic-functions');

const filesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return filesIn(path);

    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });

const isTestFile = (file: string): boolean =>
  /\.(test|integration-test)\.tsx?$/.test(file) || file.includes('__tests__');

const sourceOf = (file: string): string => {
  const source = readFileSync(file, 'utf8');
  const shared = source.match(/import \{ handler \} from '\.\.\/server\/(operation-[^']+)'/);
  return shared ? `${source}\n${readFileSync(join(SRC, 'server', `${shared[1]}.ts`), 'utf8')}` : source;
};

// ─── Role matrix ────────────────────────────────────────────────────────────

/**
 * The route table from specs/10 §3.4, written as data.
 *
 * `minimumRole` is what an unlisted action requires. `agentActions` is the
 * enumerated set of read-only actions on an otherwise admin route — enumerating
 * them is the control: a fourth one cannot join the list by being added to a
 * switch statement, only by being added here, where someone has to justify it.
 */
const ROUTES: Record<
  string,
  { file: string; minimumRole: 'admin' | 'agent'; agentActions?: string[] }
> = {
  '/whatsapp/feed': { file: 'wa-inbox-feed-route.ts', minimumRole: 'agent' },
  '/whatsapp/send': { file: 'wa-send-message-route.ts', minimumRole: 'agent' },
  '/whatsapp/thread': { file: 'wa-thread-actions-route.ts', minimumRole: 'agent' },
  '/whatsapp/consent': { file: 'wa-consent-route.ts', minimumRole: 'agent' },
  '/whatsapp/account': { file: 'wa-account-admin-route.ts', minimumRole: 'admin' },
  '/whatsapp/template': { file: 'wa-template-submit.ts', minimumRole: 'admin' },
  '/whatsapp/replay': { file: 'wa-webhook-replay-route.ts', minimumRole: 'admin' },
  '/whatsapp/campaign': {
    file: 'wa-campaign-control.ts',
    minimumRole: 'admin',
    /**
     * Four reads, and nothing else. SEC-12's subject is *who launched a
     * campaign*: these change nothing, send nothing and return CRM data an
     * agent can already see in the record list, so requiring an administrator
     * to preview an audience — or search contacts for one — would only mean
     * campaigns get built by administrators.
     */
    agentActions: ['audienceOptions', 'personSearch', 'preview', 'preflight'],
  },
};

/** Routes that are deliberately unauthenticated, and why. */
const PUBLIC_ROUTES: Record<string, string> = {
  '/whatsapp/verify': 'Meta’s GET handshake, which carries no credential (AR-6)',
};

type RouteFacts = {
  path: string;
  isAuthRequired: boolean;
  forwardsAuthorization: boolean;
  callsRequireCaller: boolean;
  roles: Set<string>;
};

const routeFactsFor = (file: string): RouteFacts | null => {
  const source = sourceOf(file);

  if (!/httpRouteTriggerSettings\s*:/.test(source)) return null;

  const path = source.match(/path:\s*'([^']+)'/)?.[1] ?? '';

  return {
    path,
    isAuthRequired: /isAuthRequired:\s*true/.test(source),
    forwardsAuthorization: /forwardedRequestHeaders:\s*\[\s*'authorization'\s*\]/.test(source),
    callsRequireCaller: /requireCaller\s*\(/.test(source),
    roles: new Set(
      [...source.matchAll(/requireRole\(\s*caller\s*,\s*'(admin|agent)'\s*\)/g)].map(
        (match) => match[1]!,
      ),
    ),
  };
};

const routeFiles = filesIn(LOGIC_FUNCTIONS).filter((file) => !isTestFile(file));

const routes = routeFiles
  .map((file) => ({ file, facts: routeFactsFor(file) }))
  .filter((entry): entry is { file: string; facts: RouteFacts } => entry.facts !== null);

describe('the route role matrix (SEC-5)', () => {
  it('found every HTTP route the app declares', () => {
    const declared = new Set(routes.map((route) => route.facts.path));

    expect([...declared].sort()).toEqual(
      [...Object.keys(ROUTES), ...Object.keys(PUBLIC_ROUTES)].sort(),
    );
  });

  /**
   * A route that is not in the table above is a route nobody reviewed. Failing
   * here is the point: adding one should require a line in this file.
   */
  it('has a reviewed entry for every route', () => {
    const unreviewed = routes
      .filter(
        (route) =>
          ROUTES[route.facts.path] === undefined &&
          PUBLIC_ROUTES[route.facts.path] === undefined,
      )
      .map((route) => route.facts.path);

    expect(unreviewed).toEqual([]);
  });

  it.each(Object.entries(ROUTES))('%s authenticates and identifies its caller', (path, spec) => {
    const route = routes.find((entry) => entry.facts.path === path);

    expect(route, `no route declares ${path}`).toBeDefined();
    expect(route!.file.endsWith(spec.file)).toBe(true);

    expect(route!.facts.isAuthRequired).toBe(true);
    expect(route!.facts.callsRequireCaller).toBe(true);

    // Twenty 2.54 forbids forwarding credentials; identity is provided in execution context.
    expect(route!.facts.forwardsAuthorization).toBe(false);
    expect(sourceOf(route!.file)).toMatch(/requireCaller\(event, executionContext\)/);
  });

  it.each(Object.entries(ROUTES))('%s gates at the reviewed role', (_path, spec) => {
    const route = routes.find((entry) => entry.file.endsWith(spec.file))!;

    expect(route.facts.roles.has(spec.minimumRole)).toBe(true);

    /**
     * An admin route that also contains an `agent` gate is only acceptable when
     * the actions behind it are named above. Anything else is a privilege
     * downgrade hiding in a switch statement.
     */
    if (spec.minimumRole === 'admin' && route.facts.roles.has('agent')) {
      expect(spec.agentActions ?? []).not.toEqual([]);
    }
  });

  /**
   * The enumerated exceptions, checked against the source rather than trusted.
   * Every `requireRole(caller, 'agent')` on the campaign route must sit under
   * one of the three reviewed actions.
   */
  it('lets only the reviewed campaign actions run as an agent', () => {
    const source = sourceOf(join(LOGIC_FUNCTIONS, 'wa-campaign-control.ts'));
    const allowed = new Set(ROUTES['/whatsapp/campaign']!.agentActions);

    /** Every `case 'x':` / `action === 'x'` that precedes an agent gate. */
    const guarded = [
      ...source.matchAll(
        /(?:case\s*'([a-zA-Z]+)'|action\s*===\s*'([a-zA-Z]+)')[\s\S]{0,400}?requireRole\(\s*caller\s*,\s*'agent'\s*\)/g,
      ),
    ].map((match) => match[1] ?? match[2]!);

    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.filter((action) => !allowed.has(action))).toEqual([]);
  });

  it('documents a reason for every unauthenticated route', () => {
    for (const [path, reason] of Object.entries(PUBLIC_ROUTES)) {
      const route = routes.find((entry) => entry.facts.path === path)!;

      expect(route.facts.isAuthRequired).toBe(false);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

// ─── Consent block ──────────────────────────────────────────────────────────

const context = (overrides: Partial<SendContext> = {}): SendContext => ({
  now: new Date('2026-08-17T09:00:00.000Z'),
  thread: { serviceWindowExpiresAt: null, isBlocked: false },
  person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_OUT },
  account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.GREEN },
  template: {
    status: TEMPLATE_STATUS.APPROVED,
    publishedToCrm: true,
    isUsableInCrm: true,
  },
  ...overrides,
});

const OPEN_WINDOW = new Date('2026-08-17T20:00:00.000Z');

describe('an opt-out cannot be overridden (SEC-6)', () => {
  const lanes: Lane[] = [LANE.INTERACTIVE, LANE.CAMPAIGN];
  const categories: TemplateCategory[] = [
    TEMPLATE_CATEGORY.MARKETING,
    TEMPLATE_CATEGORY.UTILITY,
    TEMPLATE_CATEGORY.AUTHENTICATION,
  ];
  const qualities: Quality[] = [QUALITY.GREEN, QUALITY.YELLOW, QUALITY.UNKNOWN];

  /**
   * The whole matrix, not three examples. A utility template to an opted-out
   * contact inside an open window is the combination that reads as "surely
   * that's fine" and is not: opting out means business-initiated messages stop,
   * and a utility template is business-initiated.
   */
  it('denies every business-initiated send to an opted-out contact', () => {
    const allowed: string[] = [];

    for (const lane of lanes) {
      for (const templateCategory of categories) {
        for (const qualityRating of qualities) {
          for (const windowOpen of [true, false]) {
            const verdict = evaluateSendPermission(
              { kind: 'TEMPLATE', lane, templateCategory },
              context({
                thread: {
                  serviceWindowExpiresAt: windowOpen ? OPEN_WINDOW : null,
                  isBlocked: false,
                },
                account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating },
              }),
            );

            if (verdict.allowed) {
              allowed.push(`${lane}/${templateCategory}/${qualityRating}/${windowOpen}`);
            } else {
              expect(verdict.reason).toBe(DENIAL.OPTED_OUT);
            }
          }
        }
      }
    }

    expect(allowed).toEqual([]);
  });

  it('denies a free-form send once the window has closed', () => {
    const verdict = evaluateSendPermission(
      { kind: 'FREEFORM', lane: LANE.INTERACTIVE },
      context(),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe(DENIAL.OPTED_OUT);
  });

  /**
   * The single, deliberate exception. The customer wrote to us inside the
   * window; refusing to answer them is neither helpful nor what opting out of
   * *marketing* means.
   */
  it('still lets a rep answer a customer who just wrote in', () => {
    const verdict = evaluateSendPermission(
      { kind: 'FREEFORM', lane: LANE.INTERACTIVE },
      context({
        thread: { serviceWindowExpiresAt: OPEN_WINDOW, isBlocked: false },
      }),
    );

    expect(verdict.allowed).toBe(true);
  });

  /** A blocked thread outranks even that exception. */
  it('honours a manual block regardless of the window', () => {
    const verdict = evaluateSendPermission(
      { kind: 'FREEFORM', lane: LANE.INTERACTIVE },
      context({
        person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_IN },
        thread: { serviceWindowExpiresAt: OPEN_WINDOW, isBlocked: true },
      }),
    );

    expect(verdict.allowed === false && verdict.reason).toBe(DENIAL.THREAD_BLOCKED);
  });

  /**
   * Marketing to someone who never opted in is denied for a *campaign* — the
   * volume case, where a mistake is thousands of people — and only warned for a
   * 1:1 send, which is a rep exercising judgement about one conversation.
   */
  it('refuses a marketing campaign to a contact who never opted in', () => {
    const verdict = evaluateSendPermission(
      {
        kind: 'TEMPLATE',
        lane: LANE.CAMPAIGN,
        templateCategory: TEMPLATE_CATEGORY.MARKETING,
      },
      context({ person: { whatsappOptInStatus: CONSENT_STATUS.UNKNOWN } }),
    );

    expect(verdict.allowed === false && verdict.reason).toBe(DENIAL.NO_CONSENT);
  });
});

// ─── Secret scan ────────────────────────────────────────────────────────────

const SECRET_NAMES = [
  'META_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'TWENTY_API_KEY',
];

/**
 * Everything a front-component bundle is built from.
 *
 * The bundler pulls `src/front-components` and everything it imports, which in
 * this app is `src/components` and the pure `src/domain`. `src/server` is not
 * reachable from a component and is where the secrets legitimately live.
 */
const BROWSER_DIRS = [join(SRC, 'front-components'), join(SRC, 'components')];

const browserFiles = BROWSER_DIRS.flatMap((dir) => filesIn(dir)).filter(
  (file) => !isTestFile(file),
);

describe('the secret scan (SEC-1, AR-3)', () => {
  it('scanned the browser-reachable tree', () => {
    expect(browserFiles.length).toBeGreaterThan(20);
  });

  /**
   * The check is for a *read*, not for a name.
   *
   * The settings panel names `META_VERIFY_TOKEN` on screen on purpose — telling
   * an operator which variable to set is the whole job of that card — so a scan
   * for the string would fail on the one file that is doing the right thing, and
   * would be deleted within a week. What must never appear is code that reads
   * the value, because that is the only way a value gets into a bundle.
   */
  it.each(SECRET_NAMES)('never reads %s from browser-reachable source', (name) => {
    const offenders = browserFiles
      .filter((file) => new RegExp(String.raw`process\.env(\.|\[['"\`])\s*` + name).test(sourceOf(file)))
      .map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  /**
   * `process.env` does not exist in the sandbox, so a reference to it is either
   * dead code or — worse — an author who believes a server value is available
   * in the browser and has designed around that belief.
   */
  it('reads no environment variable from the browser', () => {
    const offenders = browserFiles
      .filter((file) => /process\.env/.test(sourceOf(file)))
      .map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  it('never calls Meta from the browser', () => {
    const offenders = browserFiles
      .filter((file) => /graph\.facebook\.com/.test(sourceOf(file)))
      .map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  /**
   * The same check against the *built* output, which is what actually ships.
   *
   * Skipped when there is no build in the working tree — the source checks above
   * are the standing guard, and this one is the belt to their braces whenever a
   * build is present.
   */
  const OUTPUT = join(process.cwd(), '.twenty', 'output', 'src', 'front-components');
  const built = existsSync(OUTPUT)
    ? readdirSync(OUTPUT).filter((entry) => entry.endsWith('.mjs'))
    : [];

  it.runIf(built.length > 0)('finds no secret read in the built bundles', () => {
    const offenders: string[] = [];

    for (const file of built) {
      const bundle = readFileSync(join(OUTPUT, file), 'utf8');

      for (const name of SECRET_NAMES) {
        if (new RegExp(String.raw`process\.env(\.|\[['"\`])\s*` + name).test(bundle)) {
          offenders.push(`${file}: reads ${name}`);
        }
      }

      if (bundle.includes('graph.facebook.com')) offenders.push(`${file}: graph.facebook.com`);
    }

    expect(offenders).toEqual([]);
  });
});
