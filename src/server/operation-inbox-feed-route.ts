import { Response, type LogicFunctionExecutionContext, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  MESSAGE_TYPE,
  QUALITY,
  type AccountStatus,
  type ConsentStatus,
  type Quality,
} from '../domain/constants';
import {
  DEFAULT_THREAD_PAGE,
  FEED_BY,
  FEED_SCOPE,
  INBOX_FILTER,
  parseFeedQuery,
  type FeedQuery,
} from '../domain/feed/query';
import {
  capabilitiesFor,
  type ThreadCapabilities,
} from '../domain/feed/capabilities';
import {
  attachSenderLabels,
  memberLabel,
  projectAccount,
  projectMessage,
  projectPerson,
  projectThread,
  type AccountProjection,
  type MessageProjection,
  type PersonProjection,
  type ThreadProjection,
  type ViewerContext,
} from '../domain/feed/projection';
import type { ContactCardProjection } from '../domain/feed/content';
import {
  attachContactMatches,
  contactPhoneCandidates,
} from '../domain/feed/contact-match';
import { attachQuotes, quotedWamids } from '../domain/feed/quote';
import { toE164, toWaId } from '../domain/phone/normalise';
import {
  evaluateSendPermission,
  type SendContext,
  type SendVerdict,
} from '../domain/policy/send-permission';
import { authErrorResponse, requireCaller, requireRole, type Caller } from '../server/auth';
import { config, forAccount } from '../server/config';
import { describeError, logger } from '../server/logger';
import { resolveFieldMetadataId } from '../server/metadata-ids';
import { OBJ_MESSAGE, OBJ_CAMPAIGN } from '../constants/universal-identifiers';
import { findAccountById, listAccounts } from '../server/repositories/accounts';
import { toDate } from '../server/repositories/base';
import { findCampaignById, listCampaigns } from '../server/repositories/campaigns';
import { listRecipients } from '../server/repositories/campaign-recipients';
import {
  findFeedMessagesByWamids,
  listThreadMessages,
  listThreadMessagesSince,
} from '../server/repositories/messages';
import {
  findPeopleByPrimaryPhone,
  findPersonById,
} from '../server/repositories/people';
import { listTemplatesForAccount } from '../server/repositories/templates';
import { reconcileCounters } from '../logic-functions/wa-stats-rollup';
import { findWorkspaceMembersByIds } from '../server/repositories/workspace-members';
import {
  countInboxThreads,
  findThreadById,
  findThreadsForPerson,
  listInboxThreads,
  type InboxFilterSpec,
} from '../server/repositories/threads';

/**
 * `GET /s/whatsapp/feed` — the single data path every front component reads
 * (specs/08 §2, D-6, FR-UI-4).
 *
 * Five surfaces polling five different endpoints would multiply the request
 * budget by five and give each of them its own idea of what the window rule is.
 * One route, one envelope, one refresh — and the two things the UI must never
 * decide for itself, `policy` and `permissions`, are computed here where the
 * send route computes them too (AR-17, SEC-5).
 *
 * The transport is polling, which is the seam FR-UI-4 asks for: the components
 * consume an envelope, not a socket, so replacing this with a subscription later
 * changes one hook.
 */

export const WINDOW_EXPIRING_HORIZON_MS = 2 * 60 * 60 * 1000;
/** Campaign counters are read from the record; this caps the recipient sample. */
export const RECIPIENT_SAMPLE = 50;

export type FeedPermissions = {
  canSend: boolean;
  canManageTemplates: boolean;
  canManageCampaigns: boolean;
  /**
   * Who the server decided the caller is (D-53).
   *
   * The browser never asserts this — it is told. It is here because the inbox
   * needs it to say "assigned to you" without a second round trip, and because
   * a null on a signed-in human is the visible symptom of an identity lookup
   * that failed, which is otherwise indistinguishable from having no roles.
   */
  workspaceMemberId: string | null;
};

export type FeedPolicy = {
  allowed: boolean;
  reason: string | null;
  warnings: string[];
};

export type FeedEnvelope = {
  /** The clock when the read *started* — see `nextSince`. */
  serverTime: string;
  /** What to send back as `since` on the next poll. */
  nextSince: string;
  /** True when a burst did not fit in one delta; poll again immediately. */
  truncated?: boolean;
  scope: string;
  permissions: FeedPermissions;
  account?: AccountProjection | null;
  thread?: ThreadProjection | null;
  /** Only on the person scope when there is no conversation to carry it. */
  person?: PersonProjection | null;
  /** What `POST /whatsapp/send` needs to open a conversation from a contact. */
  start?: { accountId: string | null; waId: string | null };
  threads?: ThreadProjection[];
  /** Inbox scope with `counts=1`: one total per filter, keyed by filter name. */
  counts?: Record<string, number>;
  messages?: MessageProjection[];
  olderCursor?: string | null;
  nextCursor?: string | null;
  policy?: FeedPolicy;
  /**
   * One verdict per composer action (spec §"Capability matrix").
   *
   * `policy` stays beside it and keeps its meaning — "can a rep type and press
   * send" — because that is what the composer's primary state is driven by and
   * removing it would be a change to every surface for no gain. This is the
   * finer grain the ＋ menu needs.
   */
  capabilities?: ThreadCapabilities;
  /** Actual workspace metadata IDs, never universal identifiers. */
  uploadTargets?: { messageMediaFieldMetadataId: string | null; campaignHeaderMediaFieldMetadataId: string | null };
  templates?: unknown[];
  campaign?: unknown;
  campaigns?: unknown[];
  recipients?: unknown[];
  accounts?: AccountProjection[];
};

export const permissionsFor = (caller: Caller): FeedPermissions => ({
  canSend: caller.isAgent,
  canManageTemplates: caller.isAdmin,
  canManageCampaigns: caller.isAdmin,
  workspaceMemberId: caller.workspaceMemberId,
});

const asPolicy = (verdict: SendVerdict): FeedPolicy => ({
  allowed: verdict.allowed,
  reason: verdict.allowed ? null : verdict.reason,
  warnings: verdict.warnings,
});

/**
 * The composer's state, decided here rather than in the browser (AR-17).
 *
 * The intent is free-form: the question the composer is asking is "can I type a
 * message and press send". A closed window answers `WINDOW_CLOSED`, which is
 * exactly the state that swaps the primary button for **Escolher modelo**
 * (FR-OUT-2), so the denial is the instruction.
 */
export const sendContextFor = (
  thread: { serviceWindowExpiresAt?: string | null; isBlocked?: boolean | null },
  account: { status?: string | null; qualityRating?: string | null } | null,
  person: { whatsappOptInStatus?: string | null } | null,
  now: Date,
): SendContext => ({
  now,
  thread: {
    serviceWindowExpiresAt: toDate(thread.serviceWindowExpiresAt),
    isBlocked: thread.isBlocked === true,
  },
  person:
    person === null
      ? null
      : {
          whatsappOptInStatus: (person.whatsappOptInStatus ??
            CONSENT_STATUS.UNKNOWN) as ConsentStatus,
        },
  account: {
    status: (account?.status ?? ACCOUNT_STATUS.PENDING) as AccountStatus,
    qualityRating: (account?.qualityRating ?? QUALITY.UNKNOWN) as Quality,
  },
});

export const threadPolicy = (
  thread: { serviceWindowExpiresAt?: string | null; isBlocked?: boolean | null },
  account: { status?: string | null; qualityRating?: string | null } | null,
  person: { whatsappOptInStatus?: string | null } | null,
  now: Date,
): FeedPolicy =>
  asPolicy(
    evaluateSendPermission(
      { kind: 'FREEFORM', lane: LANE.INTERACTIVE },
      sendContextFor(thread, account, person, now),
    ),
  );

export const inboxSpecFor = (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): InboxFilterSpec | { error: string } => {
  switch (query.filter) {
    case INBOX_FILTER.MINE:
      return caller.workspaceMemberId === null
        ? { error: 'filter=mine needs a workspace member; this caller has none' }
        : { kind: 'mine', assigneeId: caller.workspaceMemberId };
    case INBOX_FILTER.UNASSIGNED:
      return { kind: 'unassigned' };
    case INBOX_FILTER.UNREAD:
      return { kind: 'unread' };
    case INBOX_FILTER.CAMPAIGN_REPLIES:
      return { kind: 'campaign_replies' };
    case INBOX_FILTER.WINDOW_EXPIRING:
      return {
        kind: 'window_expiring',
        now,
        horizon: new Date(now.getTime() + WINDOW_EXPIRING_HORIZON_MS),
      };
    case INBOX_FILTER.CLOSED:
      return { kind: 'closed' };
    default:
      return { kind: 'all' };
  }
};

/**
 * The account a surface should show.
 *
 * A thread names its own; everything else takes the first connected number,
 * falling back to the first of any status so a workspace mid-setup sees its
 * pending account rather than an empty banner.
 */
const resolveAccount = async (accountId: string | null | undefined) => {
  if (typeof accountId === 'string' && accountId.length > 0) {
    return findAccountById(accountId);
  }

  const accounts = await listAccounts();

  return (
    accounts.find((account) => account.status === ACCOUNT_STATUS.CONNECTED) ??
    accounts[0] ??
    null
  );
};

/**
 * Only templates a rep may actually pick (FR-TPL-2, FR-TPL-3).
 *
 * Publishing is the deliberate human act that makes a template selectable, and
 * `isUsableInCrm` is the app's own verdict on whether it can render one — a
 * template with an unsupported header is approved at Meta and still unusable
 * here. Sending both and letting the picker filter would put that rule in two
 * places.
 */
const publishedTemplates = async (accountId: string | null | undefined) => {
  if (typeof accountId !== 'string' || accountId.length === 0) return [];

  const templates = await listTemplatesForAccount(accountId);

  return templates
    .filter(
      (template) =>
        template.publishedToCrm === true &&
        template.isUsableInCrm === true &&
        template.status === 'APPROVED',
    )
    .map((template) => ({
      id: template.id,
      name: template.name ?? null,
      language: template.language ?? null,
      category: template.category ?? null,
      qualityScore: template.qualityScore ?? null,
      variableSpec: template.variableSpec ?? null,
      components: template.components ?? null,
    }));
};

/**
 * Matches every shared contact card on a page against the CRM, in one read.
 *
 * The comparison is on E.164, not on the string Meta sent: a card carries
 * `+244 923 000 000` and a `wa_id` of `244923000000`, and a Person is stored as
 * a national number beside its calling code. Three spellings of one number,
 * and a naive comparison finds none of them.
 *
 * A number that will not normalise is dropped rather than guessed at. The cost
 * of a wrong match here is a rep opening somebody else's record from a
 * stranger's contact card.
 */
const withContactMatches = async <T extends { content: { kind: string; contacts?: ContactCardProjection[] } }>(
  messages: T[],
  account: { defaultCountryCallingCode?: string | null } | null,
): Promise<T[]> => {
  const cards = messages.flatMap((message) =>
    message.content.kind === 'contacts' ? (message.content.contacts ?? []) : [],
  );

  if (cards.length === 0) return messages;

  const region = forAccount(account?.defaultCountryCallingCode, config.defaultCountryCallingCode);

  const normalise = (value: string): string | null => toE164(value, region);

  const wanted = contactPhoneCandidates(cards)
    .map(normalise)
    .filter((value): value is string => value !== null);

  if (wanted.length === 0) return messages;

  const people = await findPeopleByPrimaryPhone(wanted);

  const byPhone = new Map<string, string>();

  for (const person of people) {
    const e164 = normalise(
      `${person.phones?.primaryPhoneCallingCode ?? ''}${person.phones?.primaryPhoneNumber ?? ''}`,
    );

    if (e164 !== null) byPhone.set(e164, person.id);
  }

  return attachContactMatches(messages, (card) => {
    for (const phone of [...card.phones]) {
      for (const raw of [phone.waId, phone.phone]) {
        if (raw === null) continue;

        const e164 = normalise(raw);
        const match = e164 === null ? undefined : byPhone.get(e164);

        if (match !== undefined) return match;
      }
    }

    return null;
  });
};

const threadScope = async (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): Promise<FeedEnvelope | { status: number; error: string }> => {
  const id = query.id ?? '';

  const thread =
    query.by === FEED_BY.PERSON
      ? ((await findThreadsForPerson(id, 1))[0] ?? null)
      : await findThreadById(id);

  if (thread === null) {
    /**
     * A Person with no conversation is not an error — it is the side panel's
     * empty state, which offers "Iniciar conversa" (specs/08 §7). Answering 404
     * would make the component treat a normal contact as a failure.
     *
     * The empty state is only *actionable* if it knows why. It used to receive
     * the account and the templates and nothing else, so it could say no more
     * than "this contact has no conversation yet" — true, useless, and
     * identical whether the contact had unsubscribed, the number was down, or
     * one click would have started the conversation. Three things fix that,
     * and all three are the server's to decide (AR-17):
     *
     * - `policy`, evaluated against a conversation that does not exist yet:
     *   no window, not blocked, and the person's own consent. A first message
     *   therefore answers `WINDOW_CLOSED` — which is not a refusal but the
     *   instruction to use a template (FR-OUT-5) — or `OPTED_OUT`, or
     *   `ACCOUNT_NOT_CONNECTED`, each of which is a different screen.
     * - `person`, so the state can name the consent it is describing.
     * - `start`, the pair the send route needs to open a conversation from a
     *   contact. The browser must not assemble a `waId` by stripping
     *   punctuation from a display string: a contact stored without a calling
     *   code would resolve to a national number and the template would go to
     *   whoever owns it in the default country.
     */
    if (query.by === FEED_BY.PERSON) {
      const fallback = await resolveAccount(null);
      const person = await findPersonById(id);

      const e164 =
        person === null
          ? null
          : toE164(
              `${person.phones?.primaryPhoneCallingCode ?? ''}${person.phones?.primaryPhoneNumber ?? ''}`,
              forAccount(
                fallback?.defaultCountryCallingCode,
                config.defaultCountryCallingCode,
              ),
            );

      return {
        serverTime: now.toISOString(),
        nextSince: now.toISOString(),
        scope: FEED_SCOPE.THREAD,
        permissions: permissionsFor(caller),
        thread: null,
        person: projectPerson(person),
        messages: [],
        account: projectAccount(fallback),
        templates: await publishedTemplates(fallback?.id),
        policy: threadPolicy(
          { serviceWindowExpiresAt: null, isBlocked: false },
          fallback,
          person,
          now,
        ),
        capabilities: capabilitiesFor({
          context: sendContextFor(
            { serviceWindowExpiresAt: null, isBlocked: false },
            fallback,
            person,
            now,
          ),
          canSend: caller.isAgent,
        }),
        start: {
          accountId: fallback?.id ?? null,
          waId: e164 === null ? null : toWaId(e164),
        },
      };
    }

    return { status: 404, error: 'Unknown thread' };
  }

  const account = await resolveAccount(thread.accountId);
  const person =
    typeof thread.personId === 'string' ? await findPersonById(thread.personId) : null;

  const isDelta = query.since !== null;

  const page = isDelta
    ? await listThreadMessagesSince(thread.id, query.since!, now.toISOString())
    : await listThreadMessages(thread.id, { limit: query.limit, before: query.before });

  const projectedPerson = projectPerson(person);

  /**
   * Who is reading, so the server can say which reactions are the caller's own
   * and what to call the customer — neither of which the browser may assert
   * for itself (D-53).
   */
  const personName = [projectedPerson?.firstName, projectedPerson?.lastName]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');

  const viewer: ViewerContext = {
    workspaceMemberId: caller.workspaceMemberId,
    contactWaId: thread.waId ?? null,
    contactLabel:
      personName.length > 0 ? personName : (thread.profileName ?? null),
  };

  /**
   * A reaction is not a row in the transcript (spec §"Reaction UX").
   *
   * Every reaction already appears as a chip under the message it is about,
   * patched onto that message's payload by the inbound processor and by the
   * sender. Rendering the reaction *record* as well put a bubble saying "👍"
   * between two sentences, breaking the conversation in half to repeat
   * something shown two rows up. The records still exist and are still audited;
   * they are simply not part of the conversation the reader is following.
   *
   * The filter runs after paging rather than in the query so the page size and
   * cursors keep their meaning — a page that returned forty rows and rendered
   * thirty-one is normal.
   */
  const conversational = page.messages.filter(
    (message) => message.messageType !== MESSAGE_TYPE.REACTION,
  );

  const projected = conversational.map((message) => projectMessage(message, viewer));

  /**
   * The one extra read the whole reply feature costs (spec §"Reply UX").
   *
   * Only for quotes reaching outside the page, only on a page that has any, and
   * capped by the repository. A delta usually asks for nothing at all.
   */
  const missing = quotedWamids(projected);
  const resolved =
    missing.length === 0
      ? []
      : (await findFeedMessagesByWamids(missing)).map((message) =>
          projectMessage(message, viewer),
        );

  const quoted = attachQuotes(projected, resolved, viewer.contactLabel);

  /**
   * Who sent each outbound message, by name.
   *
   * One read for the whole page, and only when the page contains a message a
   * person sent by hand — a conversation of inbound messages and campaign sends
   * asks for nothing.
   */
  const senderIds = quoted
    .map((message) => message.sentById)
    .filter((id): id is string => id !== null);

  const senderLabels = new Map<string, string>();

  if (senderIds.length > 0) {
    for (const member of await findWorkspaceMembersByIds(senderIds)) {
      const label = memberLabel(member);

      if (label !== null) senderLabels.set(member.id, label);
    }
  }

  const named = attachSenderLabels(quoted, senderLabels);

  /**
   * Shared contact cards, matched against the CRM in one batched query.
   *
   * Skipped entirely when the page carries no contact card, which is nearly
   * every page — the cost is paid only by the conversations that share one.
   */
  const messages = await withContactMatches(named, account);

  return {
    serverTime: now.toISOString(),
    nextSince: 'nextSince' in page ? page.nextSince : now.toISOString(),
    ...('truncated' in page && page.truncated ? { truncated: true } : {}),
    scope: FEED_SCOPE.THREAD,
    permissions: permissionsFor(caller),
    account: projectAccount(account),
    thread: projectThread(thread, projectedPerson),
    messages,
    olderCursor: 'olderCursor' in page ? page.olderCursor : null,
    policy: threadPolicy(thread, account, person, now),
    capabilities: capabilitiesFor({
      context: sendContextFor(thread, account, person, now),
      canSend: caller.isAgent,
    }),
    /**
     * The catalogue rides along on a full load and never on a delta. The picker
     * needs it the moment the window is closed, and re-sending sixty templates
     * every three seconds to say nothing changed is exactly the polling cost
     * D-6 exists to control.
     */
    ...(isDelta ? {} : { templates: await publishedTemplates(account?.id) }),
  };
};

/**
 * How many conversations each filter holds (review §"strengthen list navigation").
 *
 * Six reads, run together, and only when `counts=1` asked for them. A filter
 * the caller cannot use answers zero rather than erroring: `mine` needs a
 * workspace member, and a badge is not the place to report that a caller has
 * no identity — the list itself already says so when they select it.
 */
const inboxCounts = async (
  caller: Caller,
  now: Date,
): Promise<Record<string, number>> => {
  const specs = Object.values(INBOX_FILTER).map(
    (filter) => [filter, inboxSpecFor({ ...EMPTY_QUERY, filter }, caller, now)] as const,
  );

  const counted = await Promise.all(
    specs.map(async ([filter, spec]) =>
      'error' in spec ? ([filter, 0] as const) : ([filter, await countInboxThreads(spec)] as const),
    ),
  );

  return Object.fromEntries(counted);
};

/** The fields `inboxSpecFor` ignores, so a filter can be counted on its own. */
const EMPTY_QUERY: FeedQuery = {
  scope: FEED_SCOPE.INBOX,
  id: null,
  by: FEED_BY.THREAD,
  since: null,
  filter: INBOX_FILTER.ALL,
  before: null,
  limit: DEFAULT_THREAD_PAGE,
  counts: false,
  archived: false,
};

const inboxScope = async (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): Promise<FeedEnvelope | { status: number; error: string }> => {
  const spec = inboxSpecFor(query, caller, now);

  if ('error' in spec) return { status: 400, error: spec.error };

  const page = await listInboxThreads(spec, {
    limit: Math.min(query.limit, DEFAULT_THREAD_PAGE),
    after: query.before,
  });

  const account = await resolveAccount(null);

  return {
    serverTime: now.toISOString(),
    nextSince: now.toISOString(),
    scope: FEED_SCOPE.INBOX,
    permissions: permissionsFor(caller),
    account: projectAccount(account),
    threads: page.threads.map((thread) => projectThread(thread)),
    nextCursor: page.nextCursor,
    ...(query.counts ? { counts: await inboxCounts(caller, now) } : {}),
  };
};

const campaignScope = async (
  query: FeedQuery,
  caller: Caller,
  now: Date,
): Promise<FeedEnvelope | { status: number; error: string }> => {
  const base = {
    serverTime: now.toISOString(),
    nextSince: now.toISOString(),
    scope: FEED_SCOPE.CAMPAIGN,
    permissions: permissionsFor(caller),
  };

  /**
   * The list, or the archive — never both. `archived` is a *different page* of
   * the same 50-row budget rather than a filter over one page, which is what
   * keeps the live list from being crowded out by however many campaigns have
   * been filed away (specs/07 §9).
   */
  if (query.id === null) {
    return {
      ...base,
      campaigns: await listCampaigns(DEFAULT_THREAD_PAGE, { archived: query.archived }),
    };
  }

  const found = await findCampaignById(query.id);

  if (found === null) return { status: 404, error: 'Unknown campaign' };

  /**
   * The counters are recounted here, on the way to the screen that shows them
   * (D-62).
   *
   * They are stored on the campaign and rebuilt from the recipient rows by a
   * once-a-minute cron, while this screen polls every five seconds — so for up
   * to a minute the detail showed a recipient marked DELIVERED beside a
   * campaign header reading "Running · 0 delivered". Two numbers describing the
   * same event, disagreeing, on one screen: the reader has no way to tell which
   * is the stale one, and the honest-looking answer is the wrong one.
   *
   * The recount is the *same* function the cron runs — not a second way of
   * counting, which would eventually disagree with the first — and it is
   * skipped entirely unless something actually changed, so an idle campaign
   * still costs one `kv` read per poll. Failures are swallowed: stale numbers
   * are worse than fresh ones and better than no screen at all.
   */
  const campaign = await reconcileCounters(found, now);

  /**
   * The recipient sample is a *sample*, and says so. The detail view's table is
   * paged by status; loading a 100 000-row snapshot into a widget to count it
   * would spend the whole request budget on a number the campaign record
   * already carries.
   */
  const recipients = await listRecipients({
    campaignId: campaign.id,
    limit: RECIPIENT_SAMPLE,
  });

  return {
    ...base,
    campaign,
    recipients,
    account: projectAccount(await resolveAccount(campaign.accountId)),
  };
};

const bootstrapScope = async (caller: Caller, now: Date): Promise<FeedEnvelope> => {
  const accounts = await listAccounts();
  const account =
    accounts.find((candidate) => candidate.status === ACCOUNT_STATUS.CONNECTED) ??
    accounts[0] ??
    null;

  return {
    serverTime: now.toISOString(),
    nextSince: now.toISOString(),
    scope: FEED_SCOPE.BOOTSTRAP,
    permissions: permissionsFor(caller),
    account: projectAccount(account),
    accounts: accounts
      .map((candidate) => projectAccount(candidate))
      .filter((candidate): candidate is AccountProjection => candidate !== null),
    templates: await publishedTemplates(account?.id),
  };
};

export const handler = async (event: RoutePayload, executionContext?: LogicFunctionExecutionContext): Promise<Response> => {
  const log = logger.child({ fn: 'wa-inbox-feed-route' });

  try {
    const caller = await requireCaller(event, executionContext);

    requireRole(caller, 'agent');

    const parsed = parseFeedQuery(event.queryStringParameters ?? {});

    if (!parsed.ok) return new Response({ error: parsed.error }, { status: 400 });

    /**
     * Captured before the first read, and returned as `nextSince`.
     *
     * Taking the clock *after* the queries would silently skip every row
     * written while they ran: the client would ask for changes since a moment
     * that had already passed, and a message that arrived mid-read would never
     * appear until something else in the thread changed.
     */
    const now = new Date();
    const query = parsed.query;

    const result =
      query.scope === FEED_SCOPE.THREAD
        ? await threadScope(query, caller, now)
        : query.scope === FEED_SCOPE.INBOX
          ? await inboxScope(query, caller, now)
          : query.scope === FEED_SCOPE.CAMPAIGN
            ? await campaignScope(query, caller, now)
            : await bootstrapScope(caller, now);

    if ('error' in result) {
      return new Response({ error: result.error }, { status: result.status });
    }

    if (query.since === null && query.scope !== FEED_SCOPE.INBOX) {
      const [messageMediaFieldMetadataId, campaignHeaderMediaFieldMetadataId] = await Promise.all([
        resolveFieldMetadataId(OBJ_MESSAGE, 'mediaFile'),
        caller.isAdmin ? resolveFieldMetadataId(OBJ_CAMPAIGN, 'headerMediaFile') : Promise.resolve(null),
      ]);
      result.uploadTargets = { messageMediaFieldMetadataId, campaignHeaderMediaFieldMetadataId };
    }
    return new Response(result, { status: 200 });
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.feed.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

