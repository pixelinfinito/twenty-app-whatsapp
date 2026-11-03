import type {
  Direction,
  Lane,
  MessageStatus,
  MessageType,
  SourceKind,
  TemplateCategory,
} from '../../domain/constants';
import { nodesOf, pageOf, query, type JsonObject } from './base';

/**
 * `whatsappMessage` — the high-volume table (NFR-S1: 50 000/day headroom).
 *
 * `wamid` carries a unique index and is the idempotency key for everything
 * downstream (AR-8): the same inbound message redelivered creates nothing, and
 * a status webhook finds its message by WAMID alone. Outbound records exist
 * with a null `wamid` only between `queued` and `accepted`.
 */

const MESSAGE_FIELDS = {
  id: true,
  wamid: true,
  direction: true,
  messageType: true,
  body: true,
  payload: true,
  status: true,
  statusTimestamps: true,
  errorCode: true,
  errorDetail: true,
  retryCount: true,
  templateParameters: true,
  templateName: true,
  templateLanguage: true,
  templateCategory: true,
  billableCostUsd: true,
  mediaMeta: true,
  contextWamid: true,
  reactionTargetWamid: true,
  waTimestamp: true,
  lane: true,
  sourceKind: true,
  threadId: true,
  templateId: true,
  sentById: true,
  clientToken: true,
  createdAt: true,
} as const;

export type WhatsappMessageRecord = {
  id: string;
  wamid?: string | null;
  direction?: string | null;
  messageType?: string | null;
  body?: string | null;
  payload?: JsonObject | null;
  status?: string | null;
  statusTimestamps?: JsonObject | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  retryCount?: number | null;
  templateParameters?: JsonObject | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateCategory?: string | null;
  billableCostUsd?: number | null;
  mediaMeta?: JsonObject | null;
  contextWamid?: string | null;
  reactionTargetWamid?: string | null;
  waTimestamp?: string | null;
  lane?: string | null;
  sourceKind?: string | null;
  threadId?: string | null;
  templateId?: string | null;
  sentById?: string | null;
  clientToken?: string | null;
  createdAt?: string | null;
};

export const findMessageByWamid = async (
  wamid: string,
): Promise<WhatsappMessageRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { wamid: { eq: wamid } }, first: 1 },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findByWamid',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages)[0] ?? null;
};

/**
 * One query for a batch of statuses.
 *
 * A status webhook can carry 50 WAMIDs; looking each up separately would make
 * one Meta delivery cost 50 Core API calls, which at campaign scale is the
 * whole budget (NFR-R2).
 */
export const findMessagesByWamids = async (
  wamids: string[],
): Promise<Map<string, WhatsappMessageRecord>> => {
  if (wamids.length === 0) return new Map();

  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { wamid: { in: wamids } }, first: wamids.length },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findByWamids',
  );

  return new Map(
    nodesOf<WhatsappMessageRecord>(result.whatsappMessages)
      .filter((message) => typeof message.wamid === 'string')
      .map((message) => [message.wamid!, message]),
  );
};

export const findMessageById = async (id: string): Promise<WhatsappMessageRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findById',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages)[0] ?? null;
};

/**
 * The newest inbound WAMID in a thread — what a read receipt marks.
 *
 * Meta marks that message *and everything before it* read, so one call clears
 * the whole conversation and sending one per unread message would be both
 * wasteful and wrong.
 */
export const findNewestInboundWamid = async (
  threadId: string,
): Promise<string | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: { threadId: { eq: threadId }, direction: { eq: 'INBOUND' } },
            orderBy: [{ waTimestamp: 'DescNullsLast' }],
            first: 1,
          },
          edges: { node: { id: true, wamid: true } },
        },
      }),
    'messages.findNewestInbound',
  );

  return nodesOf<{ wamid?: string | null }>(result.whatsappMessages)[0]?.wamid ?? null;
};

export type MessageCreateInput = {
  mediaFile?: FileItemInput[];
  threadId: string;
  wamid?: string | null;
  direction: Direction;
  messageType: MessageType;
  body?: string | null;
  payload?: JsonObject | null;
  status: MessageStatus;
  statusTimestamps?: JsonObject | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  templateId?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateCategory?: TemplateCategory | null;
  templateParameters?: JsonObject | null;
  mediaMeta?: JsonObject | null;
  contextWamid?: string | null;
  reactionTargetWamid?: string | null;
  waTimestamp: string;
  lane: Lane;
  sourceKind: SourceKind;
  sentById?: string | null;
  clientToken?: string | null;
};

/**
 * The idempotency read behind FR-OUT-1.
 *
 * A double-clicked send button, or the sandbox retrying on a network blip,
 * arrives as two identical POSTs. The browser's token is what tells them apart
 * from two deliberate identical messages — which people genuinely send, so
 * de-duplicating on body text would be wrong.
 */
export const findMessageByClientToken = async (
  clientToken: string,
): Promise<WhatsappMessageRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { clientToken: { eq: clientToken } }, first: 1 },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findByClientToken',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages)[0] ?? null;
};

/**
 * Outbound messages that never left (NFR-R3).
 *
 * A `QUEUED` row with no WAMID older than the grace period means its sender
 * job died between the record write and the Meta call — a worker restart, an
 * OOM, a deploy. Nothing else would ever move it, so the hourly health check
 * re-enqueues it once and then fails it explicitly rather than leaving it in a
 * limbo that looks like "sending…" forever.
 */
export const findStuckQueuedMessages = async (
  olderThan: Date,
  limit = 60,
): Promise<WhatsappMessageRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: {
              status: { eq: 'QUEUED' },
              direction: { eq: 'OUTBOUND' },
              createdAt: { lt: olderThan.toISOString() },
            },
            first: limit,
          },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findStuckQueued',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages);
};

/**
 * Outbound messages that were refused (D-65).
 *
 * A stuck `QUEUED` row is a message nothing moved; a `FAILED` one is a message
 * something decided about, and the decision is on the row. Diagnostics reported
 * the first and not the second, so every failed outbound attachment — the whole
 * of D-58 — was invisible to the one screen an operator opens to ask what is
 * wrong. `errorCode` and `errorDetail` are already on `MESSAGE_FIELDS`, so this
 * costs a query and nothing else.
 *
 * Newest first: an operator reading this is asking "what just broke", and the
 * answer is at the top or it is a list nobody scrolls.
 */
export const findFailedOutboundMessages = async (
  since: Date,
  limit = 60,
): Promise<WhatsappMessageRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: {
              status: { eq: 'FAILED' },
              direction: { eq: 'OUTBOUND' },
              createdAt: { gte: since.toISOString() },
            },
            orderBy: [{ createdAt: 'DescNullsLast' }],
            first: limit,
          },
          edges: { node: MESSAGE_FIELDS },
        },
      }),
    'messages.findFailedOutbound',
  );

  return nodesOf<WhatsappMessageRecord>(result.whatsappMessages);
};

/**
 * The chat feed's selection: everything the record carries, plus the stored
 * file.
 *
 * `mediaFile` is not in `MESSAGE_FIELDS` because nothing on the send path needs
 * it and a FILES column costs a signed-URL mint per row on every read. The chat
 * is the one caller that does need it — a bubble cannot render an image without
 * a URL — so it asks for it here rather than making every other query pay.
 */
const FEED_MESSAGE_FIELDS = {
  ...MESSAGE_FIELDS,
  // A FILES column is a composite: the signed `url` is minted per read, so it
  // has to be asked for by name like any other sub-field.
  mediaFile: { fileId: true, label: true, extension: true, url: true },
} as const;

export type FeedMessageRecord = WhatsappMessageRecord & { mediaFile?: unknown };

/**
 * The messages a page of replies quotes, in one read (spec §"Reply UX").
 *
 * Separate from `findMessagesByWamids` because a quote strip may need a
 * thumbnail, and the media URL only exists on the FILES sub-selection the feed
 * field set asks for. Asking for it everywhere would mint a signed URL per row
 * on every status-webhook lookup, which is the cost `FEED_MESSAGE_FIELDS`
 * exists to keep out of the hot path.
 *
 * Capped, because the caller is a page of at most fifty messages and a hostile
 * or corrupt page must not turn one feed read into an unbounded `in:` filter.
 */
export const MAX_QUOTE_LOOKUPS = 50;

export const findFeedMessagesByWamids = async (
  wamids: string[],
): Promise<FeedMessageRecord[]> => {
  const wanted = wamids.slice(0, MAX_QUOTE_LOOKUPS);

  if (wanted.length === 0) return [];

  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { wamid: { in: wanted } }, first: wanted.length },
          edges: { node: FEED_MESSAGE_FIELDS },
        },
      }),
    'messages.findFeedByWamids',
  );

  return nodesOf<FeedMessageRecord>(result.whatsappMessages);
};

export type MessagePage = {
  messages: FeedMessageRecord[];
  /** Opaque; hand back as `before` to load the page above this one. */
  olderCursor: string | null;
};

/**
 * One page of a conversation, newest first (specs/08 §3.1, NFR-P4).
 *
 * Ordered by `createdAt`, not `waTimestamp`: an outbound message has no WhatsApp
 * timestamp until Meta accepts it, so ordering by it would put every message a
 * rep has just sent at the bottom of the list — under messages from last year —
 * for as long as the send takes. `createdAt` is always present and always
 * monotonic per thread.
 *
 * The cursor is Relay's, not a timestamp: two messages written in the same
 * millisecond are ordinary during a campaign burst, and a `createdAt < before`
 * cursor drops whichever of them the page boundary fell between.
 */
export const listThreadMessages = async (
  threadId: string,
  { limit = 50, before = null }: { limit?: number; before?: string | null } = {},
): Promise<MessagePage> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: { threadId: { eq: threadId } },
            orderBy: [{ createdAt: 'DescNullsLast' }],
            first: limit,
            ...(before === null ? {} : { after: before }),
          },
          edges: { node: FEED_MESSAGE_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    'messages.listThread',
  );

  const page = pageOf<FeedMessageRecord>(result.whatsappMessages);

  return { messages: page.items, olderCursor: page.nextCursor };
};

export type MessageDelta = {
  messages: FeedMessageRecord[];
  /**
   * Where the next poll must resume. Equal to the caller's clock when the whole
   * delta fitted; the last row's `updatedAt` when it did not, so a burst is
   * walked through rather than skipped.
   */
  nextSince: string;
  truncated: boolean;
};

export const MAX_DELTA_ROWS = 200;

/**
 * Everything in this conversation that changed since `since`.
 *
 * Filtered on `updatedAt` rather than `createdAt` because a delta has to carry
 * *status* changes too — a message delivered five minutes after it was sent is
 * not a new row, and a chat that only learned about new rows would show ticks
 * that never advance until the tab was reloaded.
 *
 * The comparison is inclusive, so the boundary row is re-sent on every poll.
 * That is deliberate: the client merges by message id, so a duplicate costs
 * nothing, while an exclusive comparison against a clock that is not the
 * database's would drop a row written in the same millisecond, permanently.
 */
export const listThreadMessagesSince = async (
  threadId: string,
  since: string,
  now: string,
): Promise<MessageDelta> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: { threadId: { eq: threadId }, updatedAt: { gte: since } },
            orderBy: [{ updatedAt: 'AscNullsFirst' }],
            first: MAX_DELTA_ROWS,
          },
          edges: { node: { ...FEED_MESSAGE_FIELDS, updatedAt: true } },
          pageInfo: { hasNextPage: true },
        },
      }),
    'messages.listThreadSince',
  );

  const messages = nodesOf<FeedMessageRecord & { updatedAt?: string | null }>(
    result.whatsappMessages,
  );
  const truncated = result.whatsappMessages?.pageInfo?.hasNextPage === true;
  const last = messages[messages.length - 1];

  return {
    messages,
    nextSince:
      truncated && typeof last?.updatedAt === 'string' ? last.updatedAt : now,
    truncated,
  };
};

export const createMessage = async (
  input: MessageCreateInput,
): Promise<WhatsappMessageRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createWhatsappMessage: {
          __args: {
            /**
             * The generated client reflects the currently installed workspace,
             * while this app revision adds `AI_AGENT` to the select manifest.
             * After apply/regeneration the types converge; keep the cast at this
             * single manifest boundary instead of weakening SourceKind globally.
             */
            data: input as never,
          },
          ...MESSAGE_FIELDS,
        },
      }),
    'messages.create',
  );

  return result.createWhatsappMessage as WhatsappMessageRecord;
};

/**
 * A FILES column takes `{ fileId, label }`, not the object `uploadFile`
 * returns. Passing the upload result straight through is accepted by the type
 * checker only if the field is typed loosely, and rejected by the server at
 * runtime — so the shape is named here.
 */
export type FileItemInput = { fileId: string; label: string };

export type MessagePatch = {
  wamid?: string | null;
  mediaFile?: FileItemInput[];
  status?: MessageStatus;
  statusTimestamps?: JsonObject | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  retryCount?: number;
  billableCostUsd?: number | null;
  mediaMeta?: JsonObject | null;
  payload?: JsonObject | null;
  body?: string | null;
};

export const patchMessage = async (id: string, data: MessagePatch): Promise<void> => {
  await query(
    (client) => client.mutation({ updateWhatsappMessage: { __args: { id, data }, id: true } }),
    'messages.patch',
  );
};

/**
 * Messages past the retention window that still hold content (SEC-9).
 *
 * The `or` is what makes the purge idempotent, and it is not an optimisation.
 * Without it every run would re-blank every old message for ever — at the
 * design volume that is 50 000 pointless writes a day, growing, against a
 * cron that would still report "purged 200" and look healthy.
 *
 * `mediaMeta` is one of the three predicates because a media message with no
 * caption can reach the table with a null body, and a stored filename
 * (`contrato-joao-silva.pdf`) is content by any reading that matters.
 *
 * Ordered by id: the purge deletes what it reads, and without a total order the
 * API may skip a row across pages — a row skipped here is content that survives
 * every future run.
 */
export const findPurgeableMessages = async (
  before: Date,
  limit: number,
): Promise<{ id: string }[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: {
            filter: {
              waTimestamp: { lt: before.toISOString() },
              or: [
                { body: { is: 'NOT_NULL' } },
                { payload: { is: 'NOT_NULL' } },
                { mediaMeta: { is: 'NOT_NULL' } },
              ],
            },
            orderBy: [{ id: 'AscNullsFirst' }],
            first: limit,
          },
          edges: { node: { id: true } },
        },
      }),
    'messages.findPurgeable',
  );

  return nodesOf<{ id: string }>(result.whatsappMessages);
};

/**
 * Removes the content and keeps the record.
 *
 * `wamid`, `direction`, `status`, `statusTimestamps`, `billableCostUsd` and the
 * template columns all survive, which is the whole design of SEC-9: delivery
 * reporting and cost attribution have to remain answerable after a content
 * purge, so the row is emptied rather than deleted.
 *
 * `mediaFile: []` drops the workspace file association. Reclaiming the stored
 * bytes is Twenty's own business — the app has no file-delete API — and that
 * limitation is stated in the runbook rather than hidden behind a count.
 */
export const blankMessageContent = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;

  await query(
    (client) =>
      client.mutation({
        updateWhatsappMessages: {
          __args: {
            filter: { id: { in: ids } },
            data: { body: null, payload: null, mediaMeta: null, mediaFile: [] },
          },
          id: true,
        },
      }),
    'messages.blankContent',
  );
};
