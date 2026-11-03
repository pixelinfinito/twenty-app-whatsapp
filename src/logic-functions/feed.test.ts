import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The feed route (specs/08 §2, D-6).
 *
 * Every front component reads through this one handler, so a mistake here is a
 * mistake on five surfaces at once. Three properties are worth defending with
 * a fake that actually filters, orders and pages:
 *
 * 1. **`policy` is the server's answer, not a hint.** The composer renders
 *    whatever this says (AR-17); if the route computed it differently from the
 *    send route, the button would be enabled for a send that will be refused.
 * 2. **A delta never loses a row.** `nextSince` is the client's only memory of
 *    where it got to. Advancing it past rows that were not returned is the one
 *    bug in a polling transport that never self-corrects.
 * 3. **A filter means what it says.** `mine` must not silently become `all`.
 */

type Row = Record<string, unknown>;

const store: Record<string, Row[]> = {
  whatsappThreads: [],
  whatsappMessages: [],
  whatsappAccounts: [],
  whatsappTemplates: [],
  whatsappCampaigns: [],
  whatsappCampaignRecipients: [],
  people: [],
  workspaceMembers: [],
};

/** Every `__args.filter` the route sent, so a test can assert on the query itself. */
let filters: { collection: string; filter: Record<string, Row> }[] = [];

const matches = (row: Row, filter: Record<string, Row> | undefined): boolean => {
  if (filter === undefined) return true;

  return Object.entries(filter).every(([field, condition]) => {
    /**
     * `and` / `or` are filter combinators, not fields. A two-sided range has
     * to be written as an `and` of two one-sided filters (see the operator
     * rule below), so a fake that did not understand them could not exercise
     * the one filter that needs one.
     */
    if (field === 'and') {
      return (condition as unknown as Row[]).every((nested) =>
        matches(row, nested as Record<string, Row>),
      );
    }

    if (field === 'or') {
      return (condition as unknown as Row[]).some((nested) =>
        matches(row, nested as Record<string, Row>),
      );
    }

    const value = row[field] ?? null;

    /**
     * **One operator per field, exactly as the server insists.**
     *
     * This fake used to accept `{ gte, lte }` on a single field and filter by
     * both, which is not what the platform does — it answers
     * `INVALID_ARGS_FILTER` and fails the entire read. The inbox's
     * `window_expiring` filter was written that way and 500'd in production
     * while this test reported it working. A fake that is more permissive than
     * the thing it stands in for does not catch bugs, it hides them.
     */
    if (Object.keys(condition).length !== 1) {
      throw new Error(
        `fake client: filter for field "${field}" must have exactly one operator`,
      );
    }

    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        case 'eq':
          return value === operand;
        case 'neq':
          return value !== operand;
        case 'in':
          return (operand as unknown[]).includes(value);
        case 'is':
          return operand === 'NULL' ? value === null : value !== null;
        case 'gte':
          return value !== null && (value as string) >= (operand as string);
        case 'lte':
          return value !== null && (value as string) <= (operand as string);
        case 'gt':
          return value !== null && (value as string) > (operand as string);
        case 'lt':
          return value !== null && (value as string) < (operand as string);
        default:
          // A fake that quietly ignored an operator would let a broken filter
          // pass as a working one.
          throw new Error(`fake client: unsupported operator ${operator}`);
      }
    });
  });
};

const sorted = (rows: Row[], orderBy: Record<string, string>[] | undefined): Row[] => {
  if (orderBy === undefined || orderBy.length === 0) return rows;

  const [field, direction] = Object.entries(orderBy[0])[0];

  return [...rows].sort((left, right) => {
    const a = (left[field] ?? '') as string;
    const b = (right[field] ?? '') as string;
    const order = a < b ? -1 : a > b ? 1 : 0;

    return direction.startsWith('Desc') ? -order : order;
  });
};

const fakeClient = {
  query: async (selection: Record<string, { __args?: Record<string, unknown> }>) => {
    const answer: Record<string, unknown> = {};

    for (const [collection, node] of Object.entries(selection)) {
      const args = node.__args ?? {};
      const filter = args.filter as Record<string, Row> | undefined;

      filters.push({ collection, filter: filter ?? {} });

      const rows = sorted(
        (store[collection] ?? []).filter((row) => matches(row, filter)),
        args.orderBy as Record<string, string>[] | undefined,
      );

      const start = args.after === undefined ? 0 : Number(args.after);
      const first = (args.first as number | undefined) ?? 50;
      const slice = rows.slice(start, start + first);
      const end = start + slice.length;

      answer[collection] = {
        edges: slice.map((row) => ({ node: row })),
        totalCount: rows.length,
        pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) },
      };
    }

    return answer;
  },
};

vi.mock('../server/metadata-ids', () => ({ resolveFieldMetadataId: vi.fn(async (_object: string, field: string) => field === 'mediaFile' ? 'message-upload-field' : 'campaign-upload-field') }));

vi.mock('../server/repositories/base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/repositories/base')>()),
  query: async (build: (client: unknown) => Promise<unknown>) => build(fakeClient),
}));

let caller: import('../server/auth').Caller = {
  userWorkspaceId: 'uw-1',
  workspaceMemberId: 'wm-1',
  roleUniversalIdentifiers: [],
  isAdmin: false,
  isAgent: true,
  isMachine: false,
};

vi.mock('../server/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/auth')>()),
  requireCaller: async () => caller,
}));

const { handler } = await import('./wa-inbox-feed-route');

type Envelope = Record<string, any>;

const call = async (
  params: Record<string, string>,
): Promise<{ status: number; body: Envelope }> => {
  const response = (await handler({
    headers: {},
    queryStringParameters: params,
    pathParameters: {},
    body: null,
    isBase64Encoded: false,
    requestContext: { http: { method: 'GET', path: '/whatsapp/feed' } },
    userWorkspaceId: 'uw-1',
  } as never)) as unknown as { status?: number; body: Envelope };

  return { status: response.status ?? 200, body: response.body };
};

const HOUR = 60 * 60 * 1000;

const seedAccount = (overrides: Row = {}): Row => {
  const account = {
    id: 'acc-1',
    name: 'Main',
    status: 'CONNECTED',
    qualityRating: 'GREEN',
    isTestAccount: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };

  store.whatsappAccounts.push(account);

  return account;
};

const seedThread = (overrides: Row = {}): Row => {
  const thread = {
    id: 'thr-1',
    accountId: 'acc-1',
    waId: '244900000001',
    profileName: 'Ana',
    status: 'OPEN',
    windowState: 'OPEN',
    serviceWindowExpiresAt: new Date(Date.now() + 4 * HOUR).toISOString(),
    lastMessageAt: '2026-08-16T12:00:00.000Z',
    isBlocked: false,
    ...overrides,
  };

  store.whatsappThreads.push(thread);

  return thread;
};

const seedMessage = (overrides: Row = {}): Row => {
  const index = store.whatsappMessages.length;
  const message = {
    id: `msg-${index}`,
    threadId: 'thr-1',
    direction: 'INBOUND',
    messageType: 'TEXT',
    status: 'DELIVERED',
    body: `message ${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 16, 10, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 16, 10, index)).toISOString(),
    ...overrides,
  };

  store.whatsappMessages.push(message);

  return message;
};

beforeEach(() => {
  for (const key of Object.keys(store)) store[key] = [];
  filters = [];
  caller = {
    userWorkspaceId: 'uw-1',
    workspaceMemberId: 'wm-1',
    roleUniversalIdentifiers: [],
    isAdmin: false,
    isAgent: true,
    isMachine: false,
  };
});

describe('scope=thread', () => {
  it('returns the newest messages first, with the account and the person', async () => {
    seedAccount();
    seedThread({ personId: 'p-1' });
    store.people.push({
      id: 'p-1',
      name: { firstName: 'Ana', lastName: 'Silva' },
      phones: { primaryPhoneNumber: '900000001', primaryPhoneCallingCode: '+244' },
      whatsappOptInStatus: 'OPTED_IN',
    });
    for (let i = 0; i < 3; i += 1) seedMessage();

    const { status, body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(status).toBe(200);
    expect(body.messages.map((message: Envelope) => message.body)).toEqual([
      'message 2',
      'message 1',
      'message 0',
    ]);
    expect(body.account.name).toBe('Main');
    expect(body.thread.person).toMatchObject({
      firstName: 'Ana',
      primaryPhone: '+244900000001',
    });
  });

  it('computes the composer state server-side — open window', async () => {
    seedAccount();
    seedThread();

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.policy).toEqual({ allowed: true, reason: null, warnings: [] });
  });

  it('answers WINDOW_CLOSED, which is what swaps in the template button', async () => {
    seedAccount();
    seedThread({ serviceWindowExpiresAt: new Date(Date.now() - HOUR).toISOString() });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.policy).toMatchObject({ allowed: false, reason: 'WINDOW_CLOSED' });
  });

  it('reports the window closing as a warning without disabling the composer', async () => {
    seedAccount();
    seedThread({ serviceWindowExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.policy.allowed).toBe(true);
    expect(body.policy.warnings).toContain('WINDOW_EXPIRING_SOON');
  });

  it('sends the template catalogue on a full load and never on a delta', async () => {
    seedAccount();
    seedThread();
    store.whatsappTemplates.push(
      {
        id: 'tpl-1',
        accountId: 'acc-1',
        name: 'boas_vindas',
        status: 'APPROVED',
        publishedToCrm: true,
        isUsableInCrm: true,
      },
      {
        id: 'tpl-2',
        accountId: 'acc-1',
        name: 'rascunho',
        status: 'APPROVED',
        publishedToCrm: false,
        isUsableInCrm: true,
      },
    );

    const full = await call({ scope: 'thread', id: 'thr-1' });

    // Only the published, usable one — the picker is not asked to re-derive
    // FR-TPL-2 in the browser.
    expect(full.body.templates.map((template: Envelope) => template.id)).toEqual(['tpl-1']);

    const delta = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T00:00:00.000Z',
    });

    expect(delta.body.templates).toBeUndefined();
  });

  it('returns only what changed since the cursor', async () => {
    seedAccount();
    seedThread();
    seedMessage({ updatedAt: '2026-08-16T09:00:00.000Z' });
    seedMessage({ updatedAt: '2026-08-16T11:00:00.000Z' });

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T10:00:00.000Z',
    });

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].body).toBe('message 1');
  });

  it('re-sends the boundary row rather than risking a gap', async () => {
    seedAccount();
    seedThread();
    seedMessage({ updatedAt: '2026-08-16T10:00:00.000Z' });

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T10:00:00.000Z',
    });

    expect(body.messages).toHaveLength(1);
  });

  it('walks a burst through instead of skipping past it', async () => {
    seedAccount();
    seedThread();
    // One more than a delta page: the honest answer is "here is as far as I
    // got", not "you are up to date".
    for (let i = 0; i < 201; i += 1) {
      seedMessage({ updatedAt: new Date(Date.UTC(2026, 7, 16, 10, 0, i)).toISOString() });
    }

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T00:00:00.000Z',
    });

    expect(body.messages).toHaveLength(200);
    expect(body.truncated).toBe(true);
    // The 200th row's timestamp, not the wall clock — the 201st must still be
    // reachable on the next poll.
    expect(body.nextSince).toBe(new Date(Date.UTC(2026, 7, 16, 10, 0, 199)).toISOString());
    expect(new Date(body.nextSince).getTime()).toBeLessThan(
      new Date(body.serverTime).getTime(),
    );
  });

  it('advances the cursor to the clock when the delta fitted', async () => {
    seedAccount();
    seedThread();
    seedMessage();

    const { body } = await call({
      scope: 'thread',
      id: 'thr-1',
      since: '2026-08-16T00:00:00.000Z',
    });

    expect(body.truncated).toBeUndefined();
    expect(body.nextSince).toBe(body.serverTime);
  });

  it('404s an unknown thread', async () => {
    seedAccount();

    expect(await call({ scope: 'thread', id: 'nope' })).toMatchObject({ status: 404 });
  });

  it('treats a Person with no conversation as an empty state, not a failure', async () => {
    seedAccount();

    const { status, body } = await call({ scope: 'thread', id: 'p-9', by: 'person' });

    expect(status).toBe(200);
    expect(body.thread).toBeNull();
    expect(body.messages).toEqual([]);
    // The picker still arrives, because "Iniciar conversa" is a template send.
    expect(body.templates).toEqual([]);
  });

  /**
   * The empty state can only be actionable if it knows *why* it is empty, and
   * every one of those reasons is the server's to decide (AR-17). A contact
   * with no conversation is outside a window that never opened, so the policy
   * says `WINDOW_CLOSED` — which is the instruction to open with a template,
   * not a refusal.
   */
  it('sends a policy for a Person with no conversation, not just an empty shell', async () => {
    seedAccount();
    store.people.push({
      id: 'p-9',
      name: { firstName: 'Ana', lastName: 'Paula' },
      phones: { primaryPhoneCallingCode: '+244', primaryPhoneNumber: '923456789' },
      whatsappOptInStatus: 'OPTED_IN',
    });

    const { body } = await call({ scope: 'thread', id: 'p-9', by: 'person' });

    expect(body.policy).toMatchObject({ allowed: false, reason: 'WINDOW_CLOSED' });
    expect(body.person).toMatchObject({ id: 'p-9', firstName: 'Ana' });
  });

  it('reports an opted-out contact as opted out rather than as a closed window', async () => {
    seedAccount();
    store.people.push({
      id: 'p-9',
      name: { firstName: 'Ana' },
      phones: { primaryPhoneCallingCode: '+244', primaryPhoneNumber: '923456789' },
      whatsappOptInStatus: 'OPTED_OUT',
    });

    const { body } = await call({ scope: 'thread', id: 'p-9', by: 'person' });

    expect(body.policy.reason).toBe('OPTED_OUT');
  });

  /**
   * The browser must never assemble this itself. Stripping punctuation from a
   * display string turns a contact stored without a calling code into a
   * national number, and the template goes to whoever owns it in the default
   * country.
   */
  it('resolves the waId a first send needs, in E.164 digits', async () => {
    seedAccount();
    store.people.push({
      id: 'p-9',
      name: { firstName: 'Ana' },
      phones: { primaryPhoneCallingCode: '+244', primaryPhoneNumber: '923 456 789' },
    });

    const { body } = await call({ scope: 'thread', id: 'p-9', by: 'person' });

    expect(body.start).toEqual({ accountId: 'acc-1', waId: '244923456789' });
  });

  it('answers a null waId for a contact with no usable phone', async () => {
    seedAccount();
    store.people.push({ id: 'p-9', name: { firstName: 'Ana' } });

    const { body } = await call({ scope: 'thread', id: 'p-9', by: 'person' });

    expect(body.start.waId).toBeNull();
  });

  it('resolves the Person’s most recent conversation when there are two', async () => {
    seedAccount();
    seedThread({ id: 'old', personId: 'p-1', lastMessageAt: '2026-01-01T00:00:00.000Z' });
    seedThread({ id: 'new', personId: 'p-1', lastMessageAt: '2026-08-16T00:00:00.000Z' });

    const { body } = await call({ scope: 'thread', id: 'p-1', by: 'person' });

    expect(body.thread.id).toBe('new');
  });
});

/**
 * The three things the thread scope learned for the advanced ThreadView. All
 * three are decisions the browser is not allowed to make for itself (AR-17,
 * D-53), so all three have to be right *here*.
 */
describe('scope=thread, for the rich transcript', () => {
  it('answers a capability per composer action, not one blanket verdict', async () => {
    seedAccount();
    seedThread();

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.capabilities.text.allowed).toBe(true);
    expect(body.capabilities.reaction.allowed).toBe(true);
    expect(body.capabilities.interactive.allowed).toBe(true);
  });

  it('leaves only the template path open once the window has closed', async () => {
    seedAccount();
    seedThread({ serviceWindowExpiresAt: new Date(Date.now() - HOUR).toISOString() });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.capabilities.template.allowed).toBe(true);
    expect(body.capabilities.media.reason).toBe('WINDOW_CLOSED');
    expect(body.capabilities.reaction.reason).toBe('WINDOW_CLOSED');
  });

  /**
   * A reaction belongs on the bubble it is about. Rendering the reaction
   * *record* as well put a bubble saying "👍" between two sentences, breaking
   * the conversation in half to repeat something shown two rows up.
   */
  it('keeps reaction rows out of the transcript', async () => {
    seedAccount();
    seedThread();
    seedMessage({ id: 'm-text', wamid: 'wamid.1', body: 'Bom dia' });
    seedMessage({
      id: 'm-reaction',
      messageType: 'REACTION',
      body: '👍',
      reactionTargetWamid: 'wamid.1',
    });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.messages.map((message: Envelope) => message.id)).toEqual(['m-text']);
  });

  it('says which reactions belong to the rep who is reading', async () => {
    seedAccount();
    seedThread();
    seedMessage({
      wamid: 'wamid.1',
      payload: {
        reactions: [
          { workspaceMemberId: 'wm-1', emoji: '🙏' },
          { waId: '244900000001', emoji: '👍' },
        ],
      },
    });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.messages[0].reactions).toEqual([
      {
        actorId: 'wm-1',
        actorLabel: null,
        actorKind: 'WORKSPACE_MEMBER',
        emoji: '🙏',
        isMine: true,
      },
      {
        actorId: '244900000001',
        actorLabel: 'Ana',
        actorKind: 'CONTACT',
        emoji: '👍',
        isMine: false,
      },
    ]);
  });

  it('resolves a quote from the same page without a second read', async () => {
    seedAccount();
    seedThread();
    seedMessage({ id: 'm-quoted', wamid: 'wamid.1', body: 'A morada é ali' });
    seedMessage({
      id: 'm-reply',
      direction: 'OUTBOUND',
      body: 'Chego às 10:00',
      contextWamid: 'wamid.1',
    });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });
    const reply = body.messages.find((message: Envelope) => message.id === 'm-reply');

    expect(reply.quote).toMatchObject({
      wamid: 'wamid.1',
      direction: 'INBOUND',
      senderLabel: 'Ana',
      preview: 'A morada é ali',
    });
  });

  /**
   * The case a per-bubble lookup could never handle: the quoted message sits
   * outside the loaded window, so the route asks for it once for the whole page.
   */
  it('resolves a quote that reaches outside the loaded page', async () => {
    seedAccount();
    seedThread();
    seedMessage({
      id: 'm-old',
      wamid: 'wamid.old',
      body: 'Combinado',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedMessage({ id: 'm-reply', contextWamid: 'wamid.old' });

    const { body } = await call({ scope: 'thread', id: 'thr-1', limit: '1' });
    const reply = body.messages.find((message: Envelope) => message.id === 'm-reply');

    expect(body.messages).toHaveLength(1);
    expect(reply.quote?.preview).toBe('Combinado');
  });

  /**
   * A quote we cannot describe stays null rather than becoming a stub. "In
   * reply to a message" told the reader nothing they could act on — which is
   * the finding the whole quote projection exists to answer.
   */
  it('leaves an unresolvable quote null', async () => {
    seedAccount();
    seedThread();
    seedMessage({ id: 'm-reply', contextWamid: 'wamid.gone' });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.messages[0].quote).toBeNull();
  });

  /**
   * Two reps working the same conversation saw an identical column of blue
   * bubbles with nothing to tell them apart.
   */
  it('names the colleague who sent each outbound message, in one read', async () => {
    seedAccount();
    seedThread();
    store.workspaceMembers.push(
      { id: 'wm-1', name: { firstName: 'Ana', lastName: 'Silva' } },
      { id: 'wm-2', name: { firstName: 'Marcos', lastName: 'Lisboa' } },
    );
    seedMessage({ id: 'm-in', direction: 'INBOUND' });
    seedMessage({ id: 'm-ana', direction: 'OUTBOUND', sentById: 'wm-1' });
    seedMessage({ id: 'm-marcos', direction: 'OUTBOUND', sentById: 'wm-2' });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });
    const byId = Object.fromEntries(
      body.messages.map((message: Envelope) => [message.id, message.sentByLabel]),
    );

    expect(byId).toEqual({
      'm-in': null,
      'm-ana': 'Ana Silva',
      'm-marcos': 'Marcos Lisboa',
    });

    // One query for the page, not one per message.
    expect(filters.filter((entry) => entry.collection === 'workspaceMembers')).toHaveLength(
      1,
    );
  });

  it('asks for no members at all when nobody sent anything by hand', async () => {
    seedAccount();
    seedThread();
    seedMessage({ direction: 'INBOUND' });

    await call({ scope: 'thread', id: 'thr-1' });

    expect(filters.filter((entry) => entry.collection === 'workspaceMembers')).toEqual([]);
  });

  it('projects each message as a content union the renderer switches on', async () => {
    seedAccount();
    seedThread();
    seedMessage({
      messageType: 'LOCATION',
      body: 'Talatona',
      payload: {
        latitude: -8.9126,
        longitude: 13.2334,
        name: 'Talatona',
        address: 'Rua Centro',
      },
    });

    const { body } = await call({ scope: 'thread', id: 'thr-1' });

    expect(body.messages[0].content).toEqual({
      kind: 'location',
      name: 'Talatona',
      address: 'Rua Centro',
      latitude: -8.9126,
      longitude: 13.2334,
    });
  });
});

describe('scope=inbox', () => {
  const seedFour = () => {
    seedAccount();
    seedThread({ id: 'mine', assigneeId: 'wm-1' });
    seedThread({ id: 'theirs', assigneeId: 'wm-2' });
    seedThread({ id: 'nobody', assigneeId: null });
    seedThread({ id: 'done', assigneeId: 'wm-1', status: 'CLOSED' });
  };

  it('mine means mine', async () => {
    seedFour();

    const { body } = await call({ scope: 'inbox', filter: 'mine' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['mine']);
  });

  it('unassigned means unassigned', async () => {
    seedFour();

    const { body } = await call({ scope: 'inbox', filter: 'unassigned' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['nobody']);
  });

  /** The explicit unread filter the UX review asked for. */
  it('unread means conversations with something still to read', async () => {
    seedAccount();
    seedThread({ id: 'fresh', unreadCount: 2 });
    seedThread({ id: 'seen', unreadCount: 0 });
    seedThread({ id: 'finished', unreadCount: 3, status: 'CLOSED' });

    const { body } = await call({ scope: 'inbox', filter: 'unread' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['fresh']);
  });

  it('hides closed conversations from every filter but one', async () => {
    seedFour();

    const all = await call({ scope: 'inbox', filter: 'all' });

    expect(all.body.threads.map((thread: Envelope) => thread.id)).not.toContain('done');

    const closed = await call({ scope: 'inbox', filter: 'closed' });

    expect(closed.body.threads.map((thread: Envelope) => thread.id)).toEqual(['done']);
  });

  it('window_expiring excludes windows that already closed', async () => {
    seedAccount();
    seedThread({
      id: 'soon',
      serviceWindowExpiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    seedThread({
      id: 'gone',
      serviceWindowExpiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    seedThread({
      id: 'plenty',
      serviceWindowExpiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
    });

    const { body } = await call({ scope: 'inbox', filter: 'window_expiring' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['soon']);
  });

  it('orders by last activity, newest first', async () => {
    seedAccount();
    seedThread({ id: 'stale', lastMessageAt: '2026-08-01T00:00:00.000Z' });
    seedThread({ id: 'fresh', lastMessageAt: '2026-08-16T00:00:00.000Z' });

    const { body } = await call({ scope: 'inbox', filter: 'all' });

    expect(body.threads.map((thread: Envelope) => thread.id)).toEqual(['fresh', 'stale']);
  });

  it('refuses filter=mine for a caller with no workspace member', async () => {
    seedFour();
    caller = { ...caller, workspaceMemberId: null, isMachine: true };

    const { status } = await call({ scope: 'inbox', filter: 'mine' });

    // Answering "here is everything" to "show me mine" is the wrong answer to
    // a question about ownership.
    expect(status).toBe(400);
  });

  /**
   * The badges beside the filter names. Opt-in because they cost six reads,
   * and the inbox polls every eight seconds — see `FeedQuery.counts`.
   */
  it('counts nothing unless asked', async () => {
    seedFour();

    const { body } = await call({ scope: 'inbox', filter: 'all' });

    expect(body.counts).toBeUndefined();
  });

  it('counts every filter when asked, including the ones not being shown', async () => {
    seedFour();

    const { body } = await call({ scope: 'inbox', filter: 'all', counts: '1' });

    expect(body.counts).toMatchObject({
      mine: 1,
      unassigned: 1,
      all: 3,
      closed: 1,
    });
  });

  /**
   * A count is a badge, and a badge is not the place to report that a caller
   * has no workspace member — the list itself already says so when they select
   * the filter. Answering zero keeps the other five usable.
   */
  it('answers zero for a filter this caller cannot use, rather than failing the read', async () => {
    seedFour();

    const previous = caller;
    caller = { ...previous, workspaceMemberId: null };

    const { status, body } = await call({ scope: 'inbox', filter: 'all', counts: '1' });

    caller = previous;

    expect(status).toBe(200);
    expect(body.counts.mine).toBe(0);
    expect(body.counts.all).toBe(3);
  });

  it('refuses an unknown filter', async () => {
    seedFour();

    expect(await call({ scope: 'inbox', filter: 'urgent' })).toMatchObject({ status: 400 });
  });
});

describe('permissions', () => {
  it('an agent may send but not manage templates or campaigns', async () => {
    seedAccount();

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.permissions).toEqual({
      canSend: true,
      canManageTemplates: false,
      canManageCampaigns: false,
      workspaceMemberId: 'wm-1',
    });
  });

  it('an admin may do all three', async () => {
    seedAccount();
    caller = { ...caller, isAdmin: true };

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.permissions).toEqual({
      canSend: true,
      canManageTemplates: true,
      canManageCampaigns: true,
      workspaceMemberId: 'wm-1',
    });
  });
});

describe('the account block', () => {
  it('never carries the routing identity of the number', async () => {
    seedAccount({ phoneNumberId: '123456789012345', wabaId: '987654321' });

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.account.phoneNumberId).toBeUndefined();
    expect(body.account.wabaId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('123456789012345');
  });

  it('prefers a connected number over a pending one', async () => {
    seedAccount({ id: 'pending', status: 'PENDING', createdAt: '2026-01-01T00:00:00.000Z' });
    seedAccount({ id: 'live', status: 'CONNECTED', createdAt: '2026-02-01T00:00:00.000Z' });

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.account.id).toBe('live');
  });

  it('still shows a pending number rather than nothing at all', async () => {
    seedAccount({ id: 'pending', status: 'PENDING' });

    const { body } = await call({ scope: 'bootstrap' });

    expect(body.account.id).toBe('pending');
  });
});

describe('scope=campaign', () => {
  it('lists campaigns when no id is given', async () => {
    seedAccount();
    store.whatsappCampaigns.push(
      { id: 'c-1', name: 'Old', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c-2', name: 'New', status: 'RUNNING', createdAt: '2026-08-01T00:00:00.000Z' },
    );

    const { body } = await call({ scope: 'campaign' });

    expect(body.campaigns.map((campaign: Envelope) => campaign.id)).toEqual(['c-2', 'c-1']);
  });

  it('returns one campaign with a recipient sample', async () => {
    seedAccount();
    store.whatsappCampaigns.push({ id: 'c-1', name: 'Promo', accountId: 'acc-1' });
    store.whatsappCampaignRecipients.push(
      { id: 'r-1', campaignId: 'c-1', status: 'SENT' },
      { id: 'r-2', campaignId: 'c-2', status: 'SENT' },
    );

    const { body } = await call({ scope: 'campaign', id: 'c-1' });

    expect(body.campaign.name).toBe('Promo');
    expect(body.recipients.map((recipient: Envelope) => recipient.id)).toEqual(['r-1']);
  });

  it('404s an unknown campaign', async () => {
    seedAccount();

    expect(await call({ scope: 'campaign', id: 'nope' })).toMatchObject({ status: 404 });
  });
});

describe('native upload targets', () => {
  it('returns message upload metadata IDs to agents and campaign targets only to admins', async () => {
    const agent = await call({ scope: 'bootstrap' });
    expect(agent.body.uploadTargets).toEqual({ messageMediaFieldMetadataId: 'message-upload-field', campaignHeaderMediaFieldMetadataId: null });
    caller = { ...caller, isAdmin: true };
    const admin = await call({ scope: 'bootstrap' });
    expect(admin.body.uploadTargets.campaignHeaderMediaFieldMetadataId).toBe('campaign-upload-field');
  });
});
