import { ERROR_CATALOG, ERROR_CLASS, INTERNAL_ERROR } from '../../providers/whatsapp/errors';
import { projectContent, type MessageContentProjection } from './content';
import type { MediaProjection } from './media';
import type { QuoteProjection } from './quote';

/**
 * The wire shapes the front components render (specs/08 §2).
 *
 * Two rules govern what goes over this seam.
 *
 * **The server decides, the component renders.** `isRetryable` is computed from
 * the error catalogue here rather than in the browser, for the same reason
 * `policy` is (AR-17): one implementation of a rule, and a retry button that
 * cannot disagree with what the retry route will actually do.
 *
 * **Machine codes, never prose.** Nothing in these shapes is a sentence a user
 * reads. Copy lives in the component's pt/en tables (specs/01 §7), so a wording
 * change is never a server deploy.
 */

export type { MediaProjection };

/**
 * One reaction, by one identifiable actor (spec §"Required model change").
 *
 * `{ waId, emoji }` was enough while only customers could react: one emoji
 * beside a bubble, nobody to attribute it to. It stops being enough the moment
 * a rep can react too — the chip has to know which reaction is *the viewer's*,
 * because tapping the active one removes it and tapping another replaces it,
 * and a rep's reaction has no `waId` at all.
 *
 * `isMine` is decided on the server, from the caller the feed route already
 * resolved (D-53). A browser comparing ids would be asserting an identity
 * instead of being told one.
 */
export type ReactionProjection = {
  /** A `waId` for a contact, a workspace member id for a rep. Stable, never displayed. */
  actorId: string;
  actorLabel: string | null;
  actorKind: 'CONTACT' | 'WORKSPACE_MEMBER';
  emoji: string;
  isMine: boolean;
};

/** Who is reading, so `isMine` and the customer's own name can be filled in. */
export type ViewerContext = {
  workspaceMemberId: string | null;
  /** The thread's contact: their `waId`, and what to call them in a quote strip. */
  contactWaId: string | null;
  contactLabel: string | null;
};

export const ANONYMOUS_VIEWER: ViewerContext = {
  workspaceMemberId: null,
  contactWaId: null,
  contactLabel: null,
};

export type MessageProjection = {
  id: string;
  wamid: string | null;
  direction: string | null;
  type: string | null;
  status: string | null;
  body: string | null;
  waTimestamp: string | null;
  createdAt: string | null;
  statusTimestamps: Record<string, unknown>;
  errorCode: string | null;
  errorDetail: string | null;
  retryCount: number;
  isRetryable: boolean;
  lane: string | null;
  sourceKind: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  templateCategory: string | null;
  contextWamid: string | null;
  reactionTargetWamid: string | null;
  media: MediaProjection | null;
  reactions: ReactionProjection[];
  /**
   * What this message *is*, as a product model the renderer registry switches
   * on. The one field a component should reach for before `payload` or `type`.
   */
  content: MessageContentProjection;
  /**
   * The message this one replies to, resolved by the feed route in one batched
   * read. Null when nothing was quoted, and also when the quoted message
   * predates the install — a quote we cannot describe is not shown as a stub.
   */
  quote: QuoteProjection | null;
  /** Location, contact cards, interactive structures — and the "Ver detalhes" fallback. */
  payload: Record<string, unknown> | null;
  clientToken: string | null;
  sentById: string | null;
  /**
   * The colleague who sent it, by name (FR-THR-3's companion on the transcript).
   *
   * `sentById` is a UUID, which answers "who" for an audit and for nobody
   * reading a conversation — two reps working the same thread saw an identical
   * column of blue bubbles with no way to tell whose was whose. Resolved by the
   * feed route in one batched read, like quotes; null for anything a person did
   * not send by hand (a campaign, a workflow, the consent keyword handler).
   */
  sentByLabel: string | null;
  threadId: string | null;
};

type MessageSource = {
  id: string;
  wamid?: string | null;
  direction?: string | null;
  messageType?: string | null;
  body?: string | null;
  payload?: unknown;
  status?: string | null;
  statusTimestamps?: unknown;
  errorCode?: string | null;
  errorDetail?: string | null;
  retryCount?: number | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateCategory?: string | null;
  mediaMeta?: unknown;
  mediaFile?: unknown;
  contextWamid?: string | null;
  reactionTargetWamid?: string | null;
  waTimestamp?: string | null;
  lane?: string | null;
  sourceKind?: string | null;
  threadId?: string | null;
  sentById?: string | null;
  clientToken?: string | null;
  createdAt?: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);

      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof value === 'object' ? (value as Record<string, unknown>) : null;
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Whether the **Repetir** action should appear (FR-OUT-4, FR-UI-6).
 *
 * Only `retryable_backoff` qualifies. A token problem is retryable for the
 * *system* once an admin fixes it, but offering a rep a button that will fail
 * again until someone else acts is worse than showing them the real reason —
 * and a terminal recipient error will never succeed no matter how many times
 * it is pressed. An unmapped or internal code answers false: no catalogue row
 * means no evidence that retrying is safe.
 */
export const isRetryableError = (errorCode: string | null | undefined): boolean => {
  if (typeof errorCode !== 'string' || errorCode.length === 0) return false;

  /**
   * The one internal code worth pressing again. An attachment that could not be
   * read out of Twenty's storage never reached Meta, and the thing that fixes
   * it — a re-copied address, a file store that answers this time — is in the
   * rep's hands rather than an administrator's. Every other internal code is
   * either a policy refusal that will refuse again or a state only somebody
   * else can change (D-58).
   */
  if (errorCode === INTERNAL_ERROR.ATTACHMENT_UNREADABLE) return true;

  const numeric = Number(errorCode);

  if (!Number.isInteger(numeric)) return false;

  return ERROR_CATALOG.get(numeric)?.class === ERROR_CLASS.RETRYABLE_BACKOFF;
};

/**
 * The first stored file, if the media worker got one.
 *
 * `mediaFile` is a FILES column that arrives as `[{ fileId, label, url, … }]`
 * with a signed URL already attached, so the component needs no second call and
 * no knowledge of Twenty's file routes.
 */
const projectMedia = (source: MessageSource): MediaProjection | null => {
  const meta = asRecord(source.mediaMeta);
  const files = Array.isArray(source.mediaFile) ? source.mediaFile : [];
  const file = asRecord(files[0]);

  if (meta === null && file === null) return null;

  return {
    kind: stringOrNull(source.messageType),
    fileId: stringOrNull(file?.fileId),
    mimeType: stringOrNull(meta?.mimeType),
    /**
     * `filename`, not `fileName`. Meta spells it lowercase and so does
     * `MediaMeta`; reading the camel-cased name found nothing and silently fell
     * through to the storage label, so every document in the chat was titled
     * `wamid.HBgMMj….pdf` instead of the name the sender gave it — the exact
     * thing the media worker preserves the original for.
     */
    fileName: stringOrNull(meta?.filename) ?? stringOrNull(file?.label),
    sizeBytes: numberOrNull(meta?.fileSize),
    url: stringOrNull(file?.url),
    deferred: meta?.deferred === true,
    downloadFailed: meta?.downloadFailed === true,
    /**
     * `voice` and `animated` are set by the inbound normaliser from Meta's own
     * flags, and by the composer's voice path on the way out. Neither is
     * inferable from the MIME type: a voice note and an attached `.ogg` are
     * both `audio/ogg`.
     */
    isVoice: meta?.voice === true,
    isAnimated: meta?.animated === true,
    durationSeconds: numberOrNull(meta?.durationSeconds) ?? numberOrNull(meta?.duration),
    width: numberOrNull(meta?.width),
    height: numberOrNull(meta?.height),
  };
};

/**
 * The reactions stored on a message, attributed.
 *
 * Rows written before this projection existed carry only `{ waId, emoji }`, and
 * they still render: a missing `actorKind` means a contact, because a rep's
 * reaction could not have been written by the code that produced them. Reading
 * the old shape is cheaper and safer than a migration over every message row
 * that ever received a 👍.
 */
const projectReactions = (
  payload: Record<string, unknown> | null,
  viewer: ViewerContext,
): ReactionProjection[] => {
  const raw = payload?.reactions;

  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => asRecord(entry))
    .flatMap((entry): ReactionProjection[] => {
      const emoji = stringOrNull(entry?.emoji) ?? '';

      if (emoji.length === 0) return [];

      const memberId = stringOrNull(entry?.workspaceMemberId);
      const waId = stringOrNull(entry?.waId);

      if (memberId !== null) {
        return [
          {
            actorId: memberId,
            actorLabel: stringOrNull(entry?.actorLabel),
            actorKind: 'WORKSPACE_MEMBER',
            emoji,
            isMine: viewer.workspaceMemberId === memberId,
          },
        ];
      }

      return [
        {
          actorId: waId ?? '',
          actorLabel: stringOrNull(entry?.actorLabel) ?? viewer.contactLabel,
          actorKind: 'CONTACT',
          emoji,
          // A contact is never the viewer: the viewer is a signed-in rep.
          isMine: false,
        },
      ];
    });
};

export const projectMessage = (
  source: MessageSource,
  viewer: ViewerContext = ANONYMOUS_VIEWER,
): MessageProjection => {
  const payload = asRecord(source.payload);
  const media = projectMedia(source);

  return {
    id: source.id,
    wamid: stringOrNull(source.wamid),
    direction: stringOrNull(source.direction),
    type: stringOrNull(source.messageType),
    status: stringOrNull(source.status),
    body: typeof source.body === 'string' ? source.body : null,
    waTimestamp: stringOrNull(source.waTimestamp),
    createdAt: stringOrNull(source.createdAt),
    statusTimestamps: asRecord(source.statusTimestamps) ?? {},
    errorCode: stringOrNull(source.errorCode),
    errorDetail: stringOrNull(source.errorDetail),
    retryCount: numberOrNull(source.retryCount) ?? 0,
    isRetryable: isRetryableError(source.errorCode),
    lane: stringOrNull(source.lane),
    sourceKind: stringOrNull(source.sourceKind),
    templateName: stringOrNull(source.templateName),
    templateLanguage: stringOrNull(source.templateLanguage),
    templateCategory: stringOrNull(source.templateCategory),
    contextWamid: stringOrNull(source.contextWamid),
    reactionTargetWamid: stringOrNull(source.reactionTargetWamid),
    media,
    reactions: projectReactions(payload, viewer),
    content: projectContent({
      type: stringOrNull(source.messageType),
      direction: stringOrNull(source.direction),
      body: typeof source.body === 'string' ? source.body : null,
      payload,
      media,
      templateName: stringOrNull(source.templateName),
      templateLanguage: stringOrNull(source.templateLanguage),
      templateCategory: stringOrNull(source.templateCategory),
      reactionTargetWamid: stringOrNull(source.reactionTargetWamid),
    }),
    // Filled in by the feed route's batched resolution; a bare projection has
    // no way to read another row and must not pretend otherwise.
    quote: null,
    payload,
    clientToken: stringOrNull(source.clientToken),
    sentById: stringOrNull(source.sentById),
    // Filled in by the feed route's batched lookup; a bare projection has no
    // way to read another table and must not pretend otherwise.
    sentByLabel: null,
    threadId: stringOrNull(source.threadId),
  };
};

export type ThreadProjection = {
  id: string;
  waId: string | null;
  profileName: string | null;
  dialablePhone: string | null;
  status: string | null;
  windowState: string | null;
  windowKind: string | null;
  serviceWindowExpiresAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  unreadCount: number;
  isBlocked: boolean;
  originCampaignId: string | null;
  accountId: string | null;
  personId: string | null;
  assigneeId: string | null;
  /** Present only when the thread needs a human to choose (FR-CID-5). */
  linkCandidates: Record<string, unknown> | null;
  referral: Record<string, unknown> | null;
  person: PersonProjection | null;
};

export type PersonProjection = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  city: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  whatsappOptInStatus: string | null;
  whatsappOptInUpdatedAt: string | null;
  companyId: string | null;
};

type PersonSource = {
  id: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  jobTitle?: string | null;
  city?: string | null;
  emails?: { primaryEmail?: string | null } | null;
  phones?: {
    primaryPhoneNumber?: string | null;
    primaryPhoneCallingCode?: string | null;
  } | null;
  whatsappOptInStatus?: string | null;
  whatsappOptInUpdatedAt?: string | null;
  companyId?: string | null;
};

/**
 * A workspace member's display name, or nothing.
 *
 * Nothing rather than a placeholder: a member whose name has not been filled in
 * should leave the line absent, not print "Unknown" under every message they
 * send. The transcript reads better with one fewer line than with a label that
 * says less than silence.
 */
export const memberLabel = (
  member: { name?: { firstName?: string | null; lastName?: string | null } | null } | null,
): string | null => {
  const joined = [member?.name?.firstName, member?.name?.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();

  return joined.length === 0 ? null : joined;
};

/**
 * Writes each message's sender name onto it, from one already-resolved map.
 *
 * Pure, and separate from the lookup, because "which name goes on which
 * message" is the part with a wrong answer — attributing one rep's message to
 * another is worse than showing no name at all.
 */
export const attachSenderLabels = <T extends { sentById: string | null; sentByLabel: string | null }>(
  messages: T[],
  labels: ReadonlyMap<string, string>,
): T[] =>
  messages.map((message) => {
    if (message.sentById === null) return message;

    const label = labels.get(message.sentById);

    return label === undefined ? message : { ...message, sentByLabel: label };
  });

export const projectPerson = (source: PersonSource | null): PersonProjection | null => {
  if (source === null) return null;

  const callingCode = stringOrNull(source.phones?.primaryPhoneCallingCode) ?? '';
  const national = stringOrNull(source.phones?.primaryPhoneNumber) ?? '';

  return {
    id: source.id,
    firstName: stringOrNull(source.name?.firstName),
    lastName: stringOrNull(source.name?.lastName),
    jobTitle: stringOrNull(source.jobTitle),
    city: stringOrNull(source.city),
    primaryEmail: stringOrNull(source.emails?.primaryEmail),
    primaryPhone: national.length === 0 ? null : `${callingCode}${national}`,
    whatsappOptInStatus: stringOrNull(source.whatsappOptInStatus),
    whatsappOptInUpdatedAt: stringOrNull(source.whatsappOptInUpdatedAt),
    companyId: stringOrNull(source.companyId),
  };
};

type ThreadSource = {
  id: string;
  waId?: string | null;
  profileName?: string | null;
  dialablePhone?: string | null;
  status?: string | null;
  windowState?: string | null;
  windowKind?: string | null;
  serviceWindowExpiresAt?: string | null;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  lastMessageDirection?: string | null;
  unreadCount?: number | null;
  isBlocked?: boolean | null;
  originCampaignId?: string | null;
  accountId?: string | null;
  personId?: string | null;
  assigneeId?: string | null;
  linkCandidates?: unknown;
  referral?: unknown;
};

export const projectThread = (
  source: ThreadSource,
  person: PersonProjection | null = null,
): ThreadProjection => ({
  id: source.id,
  waId: stringOrNull(source.waId),
  profileName: stringOrNull(source.profileName),
  dialablePhone: stringOrNull(source.dialablePhone),
  status: stringOrNull(source.status),
  windowState: stringOrNull(source.windowState),
  windowKind: stringOrNull(source.windowKind),
  serviceWindowExpiresAt: stringOrNull(source.serviceWindowExpiresAt),
  lastInboundAt: stringOrNull(source.lastInboundAt),
  lastOutboundAt: stringOrNull(source.lastOutboundAt),
  lastMessageAt: stringOrNull(source.lastMessageAt),
  lastMessagePreview: stringOrNull(source.lastMessagePreview),
  lastMessageDirection: stringOrNull(source.lastMessageDirection),
  unreadCount: numberOrNull(source.unreadCount) ?? 0,
  isBlocked: source.isBlocked === true,
  originCampaignId: stringOrNull(source.originCampaignId),
  accountId: stringOrNull(source.accountId),
  personId: stringOrNull(source.personId),
  assigneeId: stringOrNull(source.assigneeId),
  linkCandidates: asRecord(source.linkCandidates),
  referral: asRecord(source.referral),
  person,
});

export type AccountProjection = {
  id: string;
  name: string | null;
  status: string | null;
  statusDetail: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  tierUniqueUsersUsed: number;
  displayPhoneNumber: string | null;
  displayName: string | null;
  isTestAccount: boolean;
  webhookLastEventAt: string | null;
  webhookLastVerifiedAt: string | null;
  tokenLastCheckedAt: string | null;
};

type AccountSource = {
  id: string;
  name?: string | null;
  status?: string | null;
  statusDetail?: string | null;
  qualityRating?: string | null;
  messagingLimitTier?: string | null;
  tierUniqueUsersUsed?: number | null;
  displayPhoneNumber?: string | null;
  displayName?: string | null;
  isTestAccount?: boolean | null;
  webhookLastEventAt?: string | null;
  webhookLastVerifiedAt?: string | null;
  tokenLastCheckedAt?: string | null;
};

/**
 * The account block never carries `phoneNumberId` or `wabaId`.
 *
 * They are not secrets, but they are the routing identity of the number and the
 * front end has no use for either — the banner needs quality, status and the
 * test-account flag (FR-UI-6, FR-ACC-5). Settings asks for the rest through its
 * own admin route, which checks the admin role first.
 */
export const projectAccount = (source: AccountSource | null): AccountProjection | null =>
  source === null
    ? null
    : {
        id: source.id,
        name: stringOrNull(source.name),
        status: stringOrNull(source.status),
        statusDetail: stringOrNull(source.statusDetail),
        qualityRating: stringOrNull(source.qualityRating),
        messagingLimitTier: stringOrNull(source.messagingLimitTier),
        tierUniqueUsersUsed: numberOrNull(source.tierUniqueUsersUsed) ?? 0,
        displayPhoneNumber: stringOrNull(source.displayPhoneNumber),
        displayName: stringOrNull(source.displayName),
        isTestAccount: source.isTestAccount === true,
        webhookLastEventAt: stringOrNull(source.webhookLastEventAt),
        webhookLastVerifiedAt: stringOrNull(source.webhookLastVerifiedAt),
        tokenLastCheckedAt: stringOrNull(source.tokenLastCheckedAt),
      };
