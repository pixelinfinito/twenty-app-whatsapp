import { createHash } from 'node:crypto';

import { defineLogicFunction } from 'twenty-sdk/define';
import { kv } from 'twenty-sdk/logic-function';

import { LF_OUTBOUND_SENDER } from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  CAMPAIGN_STATUS,
  DIRECTION,
  LANE,
  MESSAGE_STATUS,
  QUALITY,
  RECIPIENT_STATUS,
  THREAD_STATUS,
  type AccountStatus,
  type Lane,
  type Quality,
  type TemplateCategory,
} from '../domain/constants';
import { isBusinessInitiated } from '../domain/campaign/tier-budget';
import { STATUS_REASON } from '../domain/campaign/transitions';
import { mediaKindForHeaderFormat, validateOutboundMedia } from '../domain/media-limits';
import type { SendSpec } from '../domain/send-spec';
import { backoffDelayMs, recipientSpacingDelayMs } from '../domain/pacing';
import {
  DENIAL,
  evaluateSendPermission,
  type Denial,
  type SendContext,
  type SendIntent,
} from '../domain/policy/send-permission';
import { emptyParameters, type ResolvedParameters } from '../domain/template-render';
import type { VariableSpec } from '../domain/template-spec';
import { getProvider } from '../providers/whatsapp';
import {
  ERROR_CLASS,
  INTERNAL_ERROR,
  MetaApiError,
  classify,
  type Classification,
} from '../providers/whatsapp/errors';
import {
  buildContactsPayload,
  buildInteractiveButtonsPayload,
  buildInteractiveListPayload,
  buildLocationPayload,
  buildMediaPayload,
  buildReactionPayload,
  buildTemplatePayload,
  buildTextPayload,
  type MediaKind,
} from '../providers/whatsapp/payload';
import type { SendPayload } from '../providers/whatsapp/types';
import { config } from '../server/config';
import { retainedMediaUrl } from '../server/retained-media';
import { effectiveConsentStatus } from '../server/consent';
import { downloadWorkspaceFile, WorkspaceFileError } from '../server/files';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { noteCampaignChange } from '../server/campaign-deltas';
import { transitionCampaign } from '../server/campaign-state';
import { applyReaction } from '../server/reactions';
import { rescheduleSend } from '../server/schedule';
import { recordBusinessInitiated } from '../server/tier-ledger';
import { TIMELINE_EVENT, THREAD_OBJECT_UID, writeTimelineActivity } from '../server/timeline';
import {
  findAccountById,
  patchAccount,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';
import { asJson, toDate, type JsonObject } from '../server/repositories/base';
import { findCampaignById } from '../server/repositories/campaigns';
import {
  findRecipientByMessageId,
  patchRecipient,
} from '../server/repositories/campaign-recipients';
import {
  findMessageById,
  patchMessage,
  type MessagePatch,
  type WhatsappMessageRecord,
} from '../server/repositories/messages';
import { findPersonById } from '../server/repositories/people';
import { findTemplateById, patchTemplate } from '../server/repositories/templates';
import {
  findThreadById,
  patchThread,
  type WhatsappThreadRecord,
} from '../server/repositories/threads';

/**
 * The single send path (AR-11, specs/04 §5).
 *
 * Exactly one function in this app calls `POST /{phone_number_id}/messages`,
 * and this is it. Everything else — the composer route, the workflow action,
 * the campaign runner — creates a `whatsappMessage` in `QUEUED` and schedules a
 * job. An architecture test enforces that; the reason is that retry, pacing,
 * policy re-evaluation, media handling and error classification are one
 * inseparable piece of behaviour, and a second caller would have to reproduce
 * all five or quietly do without them.
 *
 * **The double-send hazard governs the design.** If Meta accepts a request and
 * the response is lost, a retry sends a second copy to a real person. So a
 * failure is only retried when it provably happened *before* acceptance —
 * connection refused, an HTTP 5xx we read, an explicit 429. A timeout after the
 * request was fully written is `UNKNOWN_ACCEPTANCE`: the message is failed and
 * flagged, and a human reads the thread. That trades a rare false failure for
 * never double-messaging a customer, which is the right way round.
 */

export type OutboundPayload = {
  messageId: string;
  /** Advisory only; the persisted `retryCount` is authoritative. */
  attempt?: number;
};

export type OutboundResult = {
  outcome: 'sent' | 'skipped' | 'denied' | 'deferred' | 'retrying' | 'failed';
  wamid?: string;
  reason?: string;
};

export const MAX_SEND_ATTEMPTS = 5;

/** 6 days: Meta keeps an uploaded media id for 7, and a cache that outlives it is worse than none. */
export const MEDIA_CACHE_TTL_MS = 6 * 24 * 3_600_000;

export const mediaCacheKey = (sha256: string): string => `wa:media-upload:${sha256}`;

/**
 * Step 2 and 3 of the pipeline, as one decision.
 *
 * Both guards make the sender idempotent, which matters because the queue can
 * deliver a job twice and a health check can re-enqueue a message that was
 * merely slow. A WAMID is the stronger signal: it means Meta has the message,
 * whatever our status column currently says.
 */
export const sendGuard = (
  message: Pick<WhatsappMessageRecord, 'status' | 'wamid' | 'direction'>,
): { proceed: boolean; reason?: string } => {
  if (typeof message.wamid === 'string' && message.wamid.length > 0) {
    return { proceed: false, reason: 'already accepted by Meta' };
  }

  if (message.direction !== DIRECTION.OUTBOUND) {
    return { proceed: false, reason: 'not an outbound message' };
  }

  if (message.status !== MESSAGE_STATUS.QUEUED) {
    return { proceed: false, reason: `status is ${message.status ?? 'unset'}, not QUEUED` };
  }

  return { proceed: true };
};

const DENIAL_CODES: Record<Denial, string> = {
  [DENIAL.ACCOUNT_NOT_CONNECTED]: INTERNAL_ERROR.POLICY_ACCOUNT_ERROR,
  [DENIAL.THREAD_BLOCKED]: 'POLICY_THREAD_BLOCKED',
  [DENIAL.OPTED_OUT]: INTERNAL_ERROR.POLICY_OPTED_OUT,
  [DENIAL.NO_CONSENT]: 'POLICY_NO_CONSENT',
  [DENIAL.WINDOW_CLOSED]: INTERNAL_ERROR.POLICY_WINDOW_CLOSED,
  [DENIAL.TEMPLATE_UNAVAILABLE]: INTERNAL_ERROR.POLICY_TEMPLATE_UNAVAILABLE,
  [DENIAL.QUALITY_RED]: 'POLICY_QUALITY_RED',
};

const DENIAL_METRICS: Record<Denial, string> = {
  [DENIAL.ACCOUNT_NOT_CONNECTED]: METRIC.POLICY_DENIED_ACCOUNT,
  [DENIAL.THREAD_BLOCKED]: METRIC.POLICY_DENIED_BLOCKED,
  [DENIAL.OPTED_OUT]: METRIC.POLICY_DENIED_CONSENT,
  [DENIAL.NO_CONSENT]: METRIC.POLICY_DENIED_CONSENT,
  [DENIAL.WINDOW_CLOSED]: METRIC.POLICY_DENIED_WINDOW,
  [DENIAL.TEMPLATE_UNAVAILABLE]: METRIC.POLICY_DENIED_TEMPLATE,
  [DENIAL.QUALITY_RED]: METRIC.POLICY_DENIED_QUALITY,
};

export const denialErrorCode = (reason: Denial): string => DENIAL_CODES[reason];

export type RetryDecision =
  | { action: 'retry'; delayMs: number; attempt: number }
  | { action: 'fail'; errorCode: string };

/**
 * Whether a failure earns another attempt.
 *
 * The ambiguous case is checked first and separately: `classify` folds it into
 * `terminal_unknown`, but the *reason* it is terminal is unique — not "we do
 * not know what this error means" but "we do not know whether it was an error"
 * — and it is the one outcome that needs a person to look.
 */
export const retryDecision = (
  error: MetaApiError,
  classification: Classification,
  retryCount: number,
  random: () => number = Math.random,
): RetryDecision => {
  if (error.ambiguous) {
    return { action: 'fail', errorCode: INTERNAL_ERROR.UNKNOWN_ACCEPTANCE };
  }

  if (classification.class !== ERROR_CLASS.RETRYABLE_BACKOFF) {
    return {
      action: 'fail',
      errorCode: classification.code === null ? 'META_ERROR' : String(classification.code),
    };
  }

  const delayMs = backoffDelayMs(retryCount, random, 2_000, MAX_SEND_ATTEMPTS);

  if (delayMs === null) {
    return {
      action: 'fail',
      errorCode: classification.code === null ? 'META_ERROR' : String(classification.code),
    };
  }

  return { action: 'retry', delayMs, attempt: retryCount + 1 };
};

export type TemplateContext = {
  name: string;
  languageCode: string;
  spec: VariableSpec;
  parameters: ResolvedParameters;
};

/**
 * Turns the stored spec into a Meta payload (specs/04 §6).
 *
 * Pure, and separated from everything around it so the golden-file tests can
 * assert the exact bytes without a database, a provider or a clock.
 *
 * `to` is the thread's `waId`, never `dialablePhone` (FR-CID-2) — for Argentina
 * and Mexico the two differ and the dialable form produces *silent*
 * non-delivery, an error with no error.
 */
export const buildOutboundPayload = ({
  spec,
  waId,
  template,
  mediaId,
}: {
  spec: SendSpec;
  waId: string;
  template?: TemplateContext | null;
  /** Resolved Meta media id, for the media and template-header paths. */
  mediaId?: string | null;
}): SendPayload => {
  switch (spec.kind) {
    case 'text':
      return buildTextPayload({
        to: waId,
        body: spec.body,
        previewUrl: spec.previewUrl ?? true,
        contextWamid: spec.contextWamid,
      });

    case 'media': {
      if (typeof mediaId !== 'string' || mediaId.length === 0) {
        throw new Error('A media send needs a resolved Meta media id');
      }

      return buildMediaPayload({
        to: waId,
        kind: spec.mediaKind,
        mediaId,
        caption: spec.caption,
        filename: spec.filename,
        voice: spec.voice === true,
        contextWamid: spec.contextWamid,
      });
    }

    case 'template': {
      if (template === null || template === undefined) {
        throw new Error('A template send needs the template and its variable spec');
      }

      const parameters =
        typeof mediaId === 'string' && template.parameters.header?.kind === 'media'
          ? {
              ...template.parameters,
              header: { ...template.parameters.header, mediaId },
            }
          : template.parameters;

      return buildTemplatePayload({
        to: waId,
        name: template.name,
        languageCode: template.languageCode,
        spec: template.spec,
        parameters,
        contextWamid: spec.contextWamid,
      });
    }

    case 'interactive': {
      const interactive = spec.interactive as {
        type?: string;
        body?: { text?: string };
        header?: { text?: string };
        footer?: { text?: string };
        action?: {
          button?: string;
          buttons?: { reply?: { id?: string; title?: string } }[];
          sections?: unknown[];
        };
      };

      const body = interactive.body?.text ?? '';
      const header = interactive.header?.text ?? null;
      const footer = interactive.footer?.text ?? null;

      if (interactive.type === 'list') {
        return buildInteractiveListPayload({
          to: waId,
          body,
          buttonText: interactive.action?.button ?? 'Ver opções',
          sections: (interactive.action?.sections ?? []) as never,
          header,
          footer,
          contextWamid: spec.contextWamid,
        });
      }

      return buildInteractiveButtonsPayload({
        to: waId,
        body,
        buttons: (interactive.action?.buttons ?? []).map((button) => ({
          id: button.reply?.id ?? '',
          title: button.reply?.title ?? '',
        })),
        header,
        footer,
        contextWamid: spec.contextWamid,
      });
    }

    case 'reaction':
      return buildReactionPayload({
        to: waId,
        targetWamid: spec.targetWamid,
        emoji: spec.emoji,
      });

    case 'location':
      return buildLocationPayload({
        to: waId,
        latitude: spec.latitude,
        longitude: spec.longitude,
        name: spec.name,
        address: spec.address,
        contextWamid: spec.contextWamid,
      });

    case 'contacts':
      return buildContactsPayload({
        to: waId,
        contacts: spec.contacts,
        contextWamid: spec.contextWamid,
      });

    default: {
      const exhaustive: never = spec;

      throw new Error(`Unsupported send kind: ${JSON.stringify(exhaustive)}`);
    }
  }
};

/** Whether this send needs a Meta media id before it can be built. */
export const mediaHandleFor = (
  spec: SendSpec,
  template: TemplateContext | null,
): { kind: MediaKind; fileId?: string | null; url?: string | null; path?: string | null; filename?: string | null } | null => {
  if (spec.kind === 'media') {
    return {
      kind: spec.mediaKind,
      fileId: spec.fileId,
      url: spec.fileUrl,
      path: spec.filePath,
      filename: spec.filename,
    };
  }

  if (spec.kind !== 'template' || template === null) return null;

  const header = template.parameters.header;
  if (header === undefined || header.kind !== 'media') return null;

  // Already resolved at snapshot time — a campaign uploads the header once for
  // the whole audience rather than once per recipient.
  if (typeof header.mediaId === 'string' && header.mediaId.length > 0) return null;

  const kind = mediaKindForHeaderFormat(template.spec.header?.format) ?? 'image';

  return { kind, fileId: header.fileId, url: header.fileUrl ?? null, path: header.filePath ?? null };
};

/**
 * Uploads the file to Meta, or reuses an id already uploaded for the same bytes.
 *
 * The cache is keyed by content digest rather than by file id on purpose: a
 * campaign header image attached to 5 000 recipients is one upload, and the
 * same image re-attached tomorrow from a different CRM record is still one.
 */
const resolveMediaId = async ({
  account,
  handle,
  message,
}: {
  account: WhatsappAccountRecord;
  message: WhatsappMessageRecord;
  handle: { kind: MediaKind; fileId?: string | null; url?: string | null; path?: string | null; filename?: string | null };
}): Promise<string> => {
  const url = handle.fileId ? await retainedMediaUrl(message.id, handle.fileId) : null;
  const file = await downloadWorkspaceFile(url ? { url } : { url: handle.url, path: handle.path });
  message.mediaMeta = { ...asJson<JsonObject>(message.mediaMeta, {}), mimeType: file.mimeType, fileSize: file.buffer.length };
  await patchMessage(message.id, { mediaMeta: message.mediaMeta });

  const validation = validateOutboundMedia({
    kind: handle.kind,
    mimeType: file.mimeType,
    sizeBytes: file.buffer.length,
  });

  if (!validation.ok) {
    throw new MetaApiError(validation.detail, { code: 131051, details: validation.detail });
  }

  const digest = createHash('sha256').update(file.buffer).digest('hex');
  const key = mediaCacheKey(digest);

  const cached = await kv.get<{ mediaId: string; expiresAt: number }>(key, {
    scope: 'WORKSPACE',
  });

  if (cached !== null && cached.expiresAt > Date.now()) {
    count(METRIC.SEND_MEDIA_CACHE_HIT);

    return cached.mediaId;
  }

  const { mediaId } = await getProvider().uploadMedia({
    phoneNumberId: account.phoneNumberId!,
    buffer: file.buffer,
    mimeType: file.mimeType,
    filename: handle.filename ?? `upload.${handle.kind}`,
  });

  await kv.set(
    key,
    { mediaId, expiresAt: Date.now() + MEDIA_CACHE_TTL_MS },
    { scope: 'WORKSPACE' },
  );

  count(METRIC.SEND_MEDIA_UPLOADED);

  return mediaId;
};

/**
 * The spec a template with no variables would have.
 *
 * Used as the parse fallback so that a template whose `variableSpec` column is
 * missing or malformed sends its *static* text rather than throwing: a template
 * with no placeholders is a perfectly ordinary thing, and the parameter arrays
 * being empty is exactly what makes it one.
 */
export const EMPTY_VARIABLE_SPEC: VariableSpec = {
  namedParameters: false,
  header: null,
  body: { variableCount: 0, indices: [], names: [], text: null, example: [] },
  footer: null,
  buttons: [],
  totalVariableCount: 0,
};

/**
 * Loads the template once and returns both things the send needs from it: the
 * wire context, and the three columns the policy gate re-checks.
 *
 * One read, because the alternative — a template context here and a policy
 * lookup there — was two reads of the same row that could disagree with each
 * other in the milliseconds between them.
 */
const templateContextFor = async (
  message: WhatsappMessageRecord,
): Promise<{
  context: TemplateContext;
  policy: NonNullable<SendContext['template']>;
} | null> => {
  if (typeof message.templateId !== 'string') return null;

  const record = await findTemplateById(message.templateId);
  if (record === null) return null;

  return {
    context: {
      name: record.name ?? '',
      languageCode: record.language ?? 'pt_PT',
      spec: asJson<VariableSpec>(record.variableSpec, EMPTY_VARIABLE_SPEC),
      parameters: asJson<ResolvedParameters>(message.templateParameters, emptyParameters()),
    },
    policy: {
      status: (record.status ?? '') as NonNullable<SendContext['template']>['status'],
      publishedToCrm: record.publishedToCrm === true,
      isUsableInCrm: record.isUsableInCrm === true,
    },
  };
};

/** Mirrors a terminal outcome onto the campaign recipient row (FR-CAM-9). */
const mirrorToRecipient = async (
  messageId: string,
  patch: { status: (typeof RECIPIENT_STATUS)[keyof typeof RECIPIENT_STATUS]; errorCode?: string | null; errorDetail?: string | null },
): Promise<string | null> => {
  const recipient = await findRecipientByMessageId(messageId);
  if (recipient === null) return null;

  await patchRecipient(recipient.id, patch);

  /**
   * The rollup only recounts campaigns something told it had changed, and a
   * send that never reached Meta produces no status webhook to do the telling.
   * Without this note a campaign whose whole batch was denied by policy would
   * report `failedCount: 0` indefinitely — observed live, and exactly the
   * number an operator would look at to decide nothing was wrong.
   */
  if (typeof recipient.campaignId === 'string') {
    await noteCampaignChange(recipient.campaignId, { [patch.status.toLowerCase()]: 1 });
  }

  return recipient.campaignId ?? null;
};

/**
 * Consequences beyond this one message (appendix B).
 *
 * Applied after the message has been written, and each independently guarded:
 * a failure to pause a campaign must not lose the record of why the send
 * failed, which is the thing an operator will actually read.
 */
const applyEffects = async ({
  classification,
  account,
  templateId,
  campaignId,
  detail,
}: {
  classification: Classification;
  account: WhatsappAccountRecord;
  templateId: string | null;
  campaignId: string | null;
  detail: string;
}): Promise<void> => {
  const { effect } = classification;

  if (effect.accountError === true) {
    await patchAccount(account.id, {
      status: ACCOUNT_STATUS.ERROR,
      statusDetail: detail.slice(0, 500),
    });
  }

  if (effect.unpublishTemplate === true && templateId !== null) {
    await patchTemplate(templateId, { publishedToCrm: false, isUsableInCrm: false });
  }

  /**
   * A `terminal_content` error means the mapping is wrong for *every*
   * recipient, so the run has to stop — but it stops through the state machine,
   * not by writing the column.
   *
   * Doing it directly was the original shape and it was wrong in a way only
   * timing reveals: a rejection arriving after the last message had been
   * accounted for would write `PAUSED` over `COMPLETED`, resurrecting a
   * finished campaign into a state an admin can resume.
   */
  if (effect.pauseCampaign === true && campaignId !== null) {
    const campaign = await findCampaignById(campaignId);

    if (campaign !== null) {
      await transitionCampaign({
        campaign,
        to: CAMPAIGN_STATUS.PAUSED,
        reason: STATUS_REASON.TEMPLATE_UNAVAILABLE,
        details: { detail: detail.slice(0, 500) },
      });
    }
  }

  if (effect.alertAdmin === true) {
    logger.error('wa.send.alert', {
      accountId: account.id,
      code: classification.code,
      meaning: classification.meaning,
    });
  }
};

const failMessage = async ({
  message,
  errorCode,
  errorDetail,
  thread,
  classification,
  account,
}: {
  message: WhatsappMessageRecord;
  errorCode: string;
  errorDetail: string;
  thread: WhatsappThreadRecord | null;
  classification: Classification | null;
  account: WhatsappAccountRecord | null;
}): Promise<void> => {
  await patchMessage(message.id, {
    status: MESSAGE_STATUS.FAILED,
    errorCode,
    errorDetail: errorDetail.slice(0, 500),
    statusTimestamps: {
      ...asJson<JsonObject>(message.statusTimestamps, {}),
      failed: Math.floor(Date.now() / 1000),
    },
  });

  const campaignSkip = classification?.effect.campaignSkip === true;

  /**
   * Only a campaign message has a recipient row. Looking one up for every
   * failed 1:1 send would double the Core API cost of the failure path for a
   * query that can only ever answer nothing.
   */
  const campaignId =
    message.lane === LANE.CAMPAIGN
      ? await mirrorToRecipient(message.id, {
          status: campaignSkip ? RECIPIENT_STATUS.SKIPPED : RECIPIENT_STATUS.FAILED,
          errorCode,
          errorDetail: errorDetail.slice(0, 500),
        })
      : null;

  if (classification !== null && account !== null) {
    await applyEffects({
      classification,
      account,
      templateId: message.templateId ?? null,
      campaignId,
      detail: errorDetail,
    });
  }

  await writeTimelineActivity({
    name: TIMELINE_EVENT.MESSAGE_FAILED,
    happensAt: new Date(),
    properties: { errorCode, errorDetail: errorDetail.slice(0, 200) },
    targetPersonId: thread?.personId ?? null,
    linkedRecordId: thread?.id ?? null,
    linkedObjectUniversalIdentifier: THREAD_OBJECT_UID,
  });
};

/**
 * The fallback record of an acceptance the database refused to take.
 *
 * `sendGuard` reads the message row, so a message Meta accepted but whose wamid
 * could not be written still looks sendable — and the stuck-message sweeper
 * re-queues exactly that shape. This marker is the second place the fact lives,
 * chosen because it is written through a different system than the one that
 * just failed. It is never cleaned up: a message id is used once, and an
 * outbound send is not worth risking twice to save a key.
 */
export const acceptanceKey = (messageId: string): string => `wa:accepted:${messageId}`;

type SendLog = ReturnType<typeof logger.child>;

const markAcceptedOutOfBand = async (messageId: string, wamid: string): Promise<void> => {
  try {
    await kv.set(acceptanceKey(messageId), { wamid, at: Date.now() }, { scope: 'WORKSPACE' });
  } catch (error) {
    /** Both records failed. The log line is all that is left of the send. */
    logger.error('wa.send.acceptance_unrecordable', {
      messageId,
      wamid,
      ...describeError(error),
    });
  }
};

export const readAcceptanceMarker = async (
  messageId: string,
): Promise<{ wamid: string } | null> => {
  try {
    return await kv.get<{ wamid: string }>(acceptanceKey(messageId), { scope: 'WORKSPACE' });
  } catch {
    /** A kv outage must not stop sending; the row's own wamid still guards. */
    return null;
  }
};

/**
 * Runs one piece of post-acceptance bookkeeping.
 *
 * None of these may throw out of the send. The message is already with Meta, so
 * a thrown error would only travel back to the queue and invite a retry of
 * something that must never be retried. Each failure is counted and logged with
 * the step that failed, which is what makes it repairable.
 */
const afterAcceptance = async (
  step: string,
  log: SendLog,
  effect: () => Promise<unknown>,
): Promise<void> => {
  try {
    await effect();
  } catch (error) {
    count(METRIC.SEND_POST_ACCEPT_FAILED);
    log.error('wa.send.post_accept_failed', { step, ...describeError(error) });
  }
};

export const sendOutbound = async (
  payload: OutboundPayload,
): Promise<OutboundResult> => {
  const log = logger.child({ fn: 'wa-outbound-sender', correlationId: payload.messageId });

  const message = await findMessageById(payload.messageId);

  if (message === null) {
    log.warn('wa.send.message_missing');

    return { outcome: 'skipped', reason: 'message not found' };
  }

  const guard = sendGuard(message);

  if (!guard.proceed) {
    count(METRIC.SEND_SKIP_NONQUEUED);
    log.info('wa.send.skip_nonqueued', { reason: guard.reason });

    return { outcome: 'skipped', reason: guard.reason };
  }

  /**
   * One extra read on the hot path, for the one case the row cannot report:
   * Meta accepted this message and the write of its wamid did not land.
   */
  const marker = await readAcceptanceMarker(message.id);

  if (marker !== null) {
    count(METRIC.SEND_SKIP_NONQUEUED);
    log.warn('wa.send.skip_accepted_marker', { wamid: marker.wamid });

    return { outcome: 'skipped', reason: 'already accepted by Meta', wamid: marker.wamid };
  }

  const thread =
    typeof message.threadId === 'string' ? await findThreadById(message.threadId) : null;

  if (thread === null || typeof thread.waId !== 'string') {
    await failMessage({
      message,
      errorCode: 'INTERNAL_NO_THREAD',
      errorDetail: 'The message has no thread, or the thread has no WhatsApp id',
      thread,
      classification: null,
      account: null,
    });

    return { outcome: 'failed', reason: 'no thread' };
  }

  const account =
    typeof thread.accountId === 'string' ? await findAccountById(thread.accountId) : null;

  if (account === null || typeof account.phoneNumberId !== 'string') {
    await failMessage({
      message,
      errorCode: INTERNAL_ERROR.CONFIG_MISSING,
      errorDetail: 'The thread has no connected WhatsApp number',
      thread,
      classification: null,
      account: null,
    });

    return { outcome: 'failed', reason: 'no account' };
  }

  const lane = (message.lane ?? LANE.INTERACTIVE) as Lane;
  const spec = asJson<SendSpec | null>(message.payload, null);

  if (spec === null || typeof spec.kind !== 'string') {
    await failMessage({
      message,
      errorCode: 'INTERNAL_NO_PAYLOAD',
      errorDetail: 'The message record carries no send specification',
      thread,
      classification: null,
      account,
    });

    return { outcome: 'failed', reason: 'no payload' };
  }

  const loaded = await templateContextFor(message);
  const template = loaded?.context ?? null;

  const person =
    typeof thread.personId === 'string' ? await findPersonById(thread.personId) : null;

  /**
   * Consent is bound to the destination number, not only to the thread's
   * (re-linkable) Person — detaching an opted-out contact must not turn their
   * opt-out into `UNKNOWN` (SEC-6).
   */
  const consentStatus = await effectiveConsentStatus({ person, waId: thread.waId });

  /**
   * Step 4: the policy gate runs again, on data read *now*.
   *
   * This is what stops the classic bulk-messaging defect — a campaign queued at
   * 09:00 sending a free-form message at 11:00 into a window that closed at
   * 10:00 — and it is also where an opt-out that arrived while the message sat
   * in the queue takes effect. The composer's earlier verdict is a UX
   * affordance; this one is the control.
   */
  const intent: SendIntent = {
    kind: spec.kind === 'template' ? 'TEMPLATE' : 'FREEFORM',
    lane,
    ...(message.templateCategory === null || message.templateCategory === undefined
      ? {}
      : { templateCategory: message.templateCategory as SendIntent['templateCategory'] }),
  };

  const context: SendContext = {
    now: new Date(),
    thread: {
      serviceWindowExpiresAt: toDate(thread.serviceWindowExpiresAt),
      isBlocked: thread.isBlocked === true,
    },
    person: { whatsappOptInStatus: consentStatus },
    account: {
      status: (account.status ?? ACCOUNT_STATUS.PENDING) as AccountStatus,
      qualityRating: (account.qualityRating ?? QUALITY.UNKNOWN) as Quality,
    },
    ...(loaded === null ? {} : { template: loaded.policy }),
  };

  const verdict = evaluateSendPermission(intent, context);

  if (!verdict.allowed) {
    const errorCode = denialErrorCode(verdict.reason);

    count(DENIAL_METRICS[verdict.reason]);
    log.info('wa.send.denied', { reason: verdict.reason });

    await failMessage({
      message,
      errorCode,
      errorDetail: `Blocked by policy: ${verdict.reason}`,
      thread,
      classification: null,
      account,
    });

    return { outcome: 'denied', reason: verdict.reason };
  }

  /**
   * Step 5: per-recipient spacing (Meta 131056).
   *
   * The pair rate limit is undocumented and enforced per (business, user), so
   * a burst of three messages to one contact trips it even well inside the
   * account throttle. Deferring rather than sending keeps the ordering the rep
   * typed.
   */
  const spacingDelay = recipientSpacingDelayMs({
    lastOutboundAt: toDate(thread.lastOutboundAt),
    now: Date.now(),
    minimumSpacingMs: config.recipientMinSpacingMs(),
  });

  if (spacingDelay > 0) {
    count(METRIC.SEND_SPACING_DEFERRED);
    log.debug('wa.send.spacing_deferred', { delayMs: spacingDelay });

    await rescheduleSend({ messageId: message.id, delayMs: spacingDelay });

    return { outcome: 'deferred', reason: 'recipient spacing' };
  }

  const retryCount = message.retryCount ?? 0;

  /**
   * The send, and *only* the send.
   *
   * Everything that happens after Meta accepts is deliberately outside this
   * block. When the bookkeeping lived inside it, a Core API blip while writing
   * the wamid fell into the catch below and was classified as a *Meta* failure:
   * the message a customer had just received was written down as FAILED, its
   * campaign recipient with it, and the wamid — the only handle on a message
   * that exists — was lost, so the delivery receipts arriving minutes later
   * matched nothing. A retry, and with it a second copy to a real person, was
   * one classification away: any post-acceptance error carrying an HTTP 429 or
   * 5xx would have been rescheduled onto a row that still looked unsent (D-25).
   */
  let accepted: { wamid: string; mediaId: string | null };

  try {
    const handle = mediaHandleFor(spec, template);

    const mediaId =
      handle === null
        ? asJson<{ metaMediaId?: string }>(message.mediaMeta, {}).metaMediaId ?? null
        : await resolveMediaId({ account, handle, message });

    const wirePayload = buildOutboundPayload({
      spec,
      waId: thread.waId,
      template,
      mediaId,
    });

    const result = await getProvider().sendMessage({
      phoneNumberId: account.phoneNumberId,
      payload: wirePayload,
    });

    accepted = { wamid: result.wamid, mediaId };
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      /**
       * `ATTACHMENT_UNREADABLE`, not `MEDIA_UNAVAILABLE`. Nothing reached Meta:
       * the file could not be read out of Twenty's own storage, and saying
       * "no longer available from Meta" sent every investigation of D-58
       * looking at the wrong system.
       */
      count(METRIC.SEND_ATTACHMENT_UNREADABLE);
      log.warn('wa.send.attachment_unreadable', { detail: error.message });

      await failMessage({
        message,
        errorCode: INTERNAL_ERROR.ATTACHMENT_UNREADABLE,
        errorDetail: error.message,
        thread,
        classification: null,
        account,
      });

      return { outcome: 'failed', reason: 'attachment unreadable' };
    }

    const metaError =
      error instanceof MetaApiError
        ? error
        : new MetaApiError(error instanceof Error ? error.message : String(error));

    const classification = classify(metaError);
    const decision = retryDecision(metaError, classification, retryCount);

    if (classification.unmapped) {
      count(METRIC.SEND_UNMAPPED_ERROR);
      log.error('wa.send.unmapped_error', {
        code: metaError.code,
        raw: metaError.raw,
        ...describeError(error),
      });
    }

    if (decision.action === 'retry') {
      count(METRIC.SEND_RETRY);
      log.warn('wa.send.retry', {
        attempt: decision.attempt,
        delayMs: decision.delayMs,
        code: metaError.code,
      });

      await patchMessage(message.id, {
        retryCount: decision.attempt,
        errorCode: classification.code === null ? null : String(classification.code),
        errorDetail: classification.meaning,
      });

      await rescheduleSend({
        messageId: message.id,
        delayMs: decision.delayMs,
        attempt: decision.attempt,
      });

      return { outcome: 'retrying', reason: classification.meaning };
    }

    if (metaError.ambiguous) {
      /**
       * The message may be on its way to a real person. It is failed rather
       * than retried, and counted separately so that "how often can we not
       * tell?" is a question with an answer.
       */
      count(METRIC.SEND_UNKNOWN_ACCEPTANCE);
      log.error('wa.send.unknown_acceptance', { threadId: thread.id });
    } else {
      count(METRIC.SEND_FAILED_TERMINAL);
    }

    await failMessage({
      message,
      errorCode: decision.errorCode,
      errorDetail: metaError.details ?? metaError.message,
      thread,
      classification,
      account,
    });

    return { outcome: 'failed', reason: classification.meaning };
  }

  /**
   * Meta has the message. From here the only question is bookkeeping, and the
   * answer to every failure is the same: record what can be recorded, shout
   * about what cannot, and never, ever send again.
   */
  const now = new Date();

  const patch: MessagePatch = {
    wamid: accepted.wamid,
    status: MESSAGE_STATUS.ACCEPTED,
    statusTimestamps: {
      ...asJson<JsonObject>(message.statusTimestamps, {}),
      accepted: Math.floor(now.getTime() / 1000),
    },
    errorCode: null,
    errorDetail: null,
    ...(accepted.mediaId === null
      ? {}
      : {
          mediaMeta: {
            ...asJson<JsonObject>(message.mediaMeta, {}),
            metaMediaId: accepted.mediaId,
          },
        }),
  };

  /**
   * The wamid write is the one that matters: it is what `sendGuard` reads, so
   * until it lands the record still looks sendable. If it fails after four
   * retries the message is marked accepted from the fallback marker instead,
   * and the wamid is logged at error level so the row can be repaired by hand.
   */
  try {
    await patchMessage(message.id, patch);
  } catch (error) {
    count(METRIC.SEND_WAMID_UNRECORDED);
    log.error('wa.send.wamid_unrecorded', {
      wamid: accepted.wamid,
      ...describeError(error),
    });

    await markAcceptedOutOfBand(message.id, accepted.wamid);
  }

  /**
   * A reaction has to land on the message it is about, or it is invisible.
   *
   * Meta accepted it and the customer can see it; without this patch our own
   * transcript shows nothing at all, because the only code that ever wrote a
   * reaction onto a target was the inbound webhook handler. The rep presses
   * 👍, the chip never appears, and the natural response is to press it again.
   *
   * `afterAcceptance` because the send already succeeded: a failure to
   * decorate a bubble must never look like a failure to send, and must never
   * cause a retry that would react twice.
   */
  if (spec.kind === 'reaction') {
    await afterAcceptance('reaction', log, () =>
      applyReaction({
        targetWamid: spec.targetWamid,
        actor: {
          kind: 'WORKSPACE_MEMBER',
          workspaceMemberId: message.sentById ?? '',
        },
        emoji: spec.emoji,
      }),
    );
  }

  /**
   * A reaction is not a conversation turn: it must not move the thread to
   * `AWAITING_REPLY` or rewrite the preview, or reacting 👍 to a customer's
   * message would make the inbox claim the rep had replied.
   */
  if (spec.kind !== 'reaction') {
    await afterAcceptance('thread', log, () =>
      patchThread(thread.id, {
        lastOutboundAt: now.toISOString(),
        lastMessageAt: now.toISOString(),
        lastMessageDirection: DIRECTION.OUTBOUND,
        lastMessagePreview: previewFor(spec, message),
        ...(thread.status === THREAD_STATUS.NEEDS_REVIEW
          ? {}
          : { status: THREAD_STATUS.AWAITING_REPLY }),
      }),
    );
  }

  if (lane === LANE.CAMPAIGN) {
    await afterAcceptance('recipient', log, () =>
      mirrorToRecipient(message.id, { status: RECIPIENT_STATUS.QUEUED }),
    );
  }

  /**
   * The tier ledger is written **after acceptance**, not before (AR-21).
   *
   * Meta counts conversations it actually opened, so counting at enqueue
   * time would charge the allowance for messages that were denied by policy,
   * failed on a bad number, or never sent at all — and a campaign would sit
   * in `tier_waiting` for an allowance nobody had spent.
   */
  if (
    isBusinessInitiated({
      isTemplate: spec.kind === 'template',
      templateCategory: (message.templateCategory ?? null) as TemplateCategory | null,
      windowOpen: (toDate(thread.serviceWindowExpiresAt)?.getTime() ?? 0) > now.getTime(),
    })
  ) {
    const waId = thread.waId;

    await afterAcceptance('tierLedger', log, () =>
      recordBusinessInitiated({ account, waId, now }),
    );
  }

  await afterAcceptance('timeline', log, () =>
    writeTimelineActivity({
      name:
        spec.kind === 'template' ? TIMELINE_EVENT.TEMPLATE_SENT : TIMELINE_EVENT.MESSAGE_SENT,
      happensAt: now,
      properties: {
        kind: spec.kind,
        wamid: accepted.wamid,
        ...(template === null ? {} : { template: template.name }),
      },
      targetPersonId: thread.personId ?? null,
      linkedRecordId: thread.id,
      linkedObjectUniversalIdentifier: THREAD_OBJECT_UID,
    }),
  );

  count(METRIC.SEND_ACCEPTED);
  log.info('wa.send.accepted', { wamid: accepted.wamid, kind: spec.kind });

  return { outcome: 'sent', wamid: accepted.wamid };
};

/** The inbox preview for an outbound message, mirroring the inbound labels. */
export const previewFor = (
  spec: SendSpec,
  message: Pick<WhatsappMessageRecord, 'body' | 'templateName'>,
): string => {
  const labels: Record<string, string> = {
    image: '📷 Imagem',
    video: '🎥 Vídeo',
    audio: '🎵 Áudio',
    document: '📄 Documento',
    sticker: '🌟 Autocolante',
  };

  const raw = ((): string => {
    switch (spec.kind) {
      case 'text':
        return spec.body;
      case 'media':
        return spec.caption === null || spec.caption === undefined || spec.caption.length === 0
          ? (labels[spec.mediaKind] ?? '📎 Anexo')
          : `${labels[spec.mediaKind] ?? '📎 Anexo'} · ${spec.caption}`;
      case 'template':
        return message.templateName ?? message.body ?? '📋 Modelo';
      case 'location':
        return `📍 ${spec.name ?? 'Localização'}`;
      case 'contacts':
        return '👤 Contacto';
      case 'reaction':
        return spec.emoji;
      case 'interactive':
        return message.body ?? '💬 Mensagem interativa';
      default:
        return message.body ?? '';
    }
  })();

  const collapsed = raw.replace(/\s+/g, ' ').trim();

  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 119)}…`;
};

export const handler = async (payload: OutboundPayload): Promise<OutboundResult> =>
  sendOutbound(payload);

export default defineLogicFunction({
  universalIdentifier: LF_OUTBOUND_SENDER,
  name: 'wa-outbound-sender',
  description:
    'The only function that calls Meta’s send endpoint: re-checks policy, paces, uploads media and classifies failures.',
  timeoutSeconds: 60,
  handler,
});
