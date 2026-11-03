import { defineLogicFunction } from 'twenty-sdk/define';

import {
  LF_CONSENT_KEYWORD,
  LF_INBOUND_PROCESSOR,
  LF_MEDIA_WORKER,
  OBJ_MESSAGE,
} from '../constants/universal-identifiers';
import {
  DIRECTION,
  LANE,
  MESSAGE_STATUS,
  MESSAGE_TYPE,
  RECIPIENT_STATUS,
  SOURCE_KIND,
  THREAD_STATUS,
  WINDOW_KIND,
  WINDOW_STATE,
  type WindowKind,
} from '../domain/constants';
import { normaliseInboundMessage } from '../domain/inbound-normalise';
import { computeWindowExpiry } from '../domain/policy/service-window';
import type { MetaContact, MetaMessage } from '../domain/webhook/types';
import { noteCampaignChange } from '../server/campaign-deltas';
import { config } from '../server/config';
import { enqueue } from '../server/jobs';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { applyReaction } from '../server/reactions';
import { findAccountById } from '../server/repositories/accounts';
import {
  findRecipientByThreadId,
  patchRecipient,
} from '../server/repositories/campaign-recipients';
import { createMessage, findMessageByWamid } from '../server/repositories/messages';
import { markWebhookEvent, markWebhookEventFailed } from '../server/repositories/webhook-events';
import { patchThread, type WhatsappThreadRecord } from '../server/repositories/threads';
import { statusAfterInbound, upsertThread } from '../server/threads';
import { TIMELINE_EVENT, writeTimelineActivity } from '../server/timeline';
import { findPersonById } from '../server/repositories/people';

/**
 * One inbound message (FR-IN-1 … FR-IN-4, FR-IN-6).
 *
 * This is the function that makes a customer's message appear in the CRM, and
 * its guiding rule is that **nothing after the message record is allowed to
 * lose the message**. Media download, consent keywords, campaign attribution
 * and the timeline are all side effects with their own error handling; a
 * failure in any of them leaves the message stored and the thread correct.
 */

export type InboundPayload = {
  webhookEventId?: string;
  accountId: string;
  message: MetaMessage;
  contacts?: MetaContact[];
  metadata?: { phone_number_id?: string; display_phone_number?: string };
};

export type InboundResult = {
  outcome: 'processed' | 'duplicate' | 'skipped';
  messageId?: string;
  threadId?: string;
  reason?: string;
};

/** Consent keywords are matched exactly, after folding case and accents. */
export const foldForKeyword = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .toUpperCase();

/**
 * The message must consist *entirely* of keywords (FR-CON-3).
 *
 * "PARAR" opts out; "não vou parar de recomendar" does not. A token-set check
 * — does any word match? — passes both, and unsubscribing an enthusiastic
 * customer is a lost sale that nothing in the product can undo. So the rule is
 * deliberately conservative: every token must be a keyword.
 *
 * That accepts "STOP.", "sair!" and "stop stop", and rejects anything with
 * other words in it. A customer who meant to opt out and wrote a sentence will
 * be handled by a rep, which is the recoverable direction of the error.
 */
export const matchesKeyword = (body: string | null, keywords: string[]): boolean => {
  if (body === null) return false;

  const tokens = foldForKeyword(body).split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;

  const targets = new Set(keywords.map((keyword) => foldForKeyword(keyword)));

  return tokens.every((token) => targets.has(token));
};

/**
 * The window a message opens (FR-IN-3, FR-IN-6).
 *
 * A referral means a Click-to-WhatsApp ad or Page CTA, which Meta grants a 72h
 * free window. The grace is tied to the *referral conversation*, so an ordinary
 * later message resets both the kind and the 24h clock — carrying it forward
 * forever would let us message a contact for free long after the ad that
 * earned it.
 */
export const windowForMessage = (
  hasReferral: boolean,
): WindowKind =>
  hasReferral ? WINDOW_KIND.FREE_ENTRY_POINT : WINDOW_KIND.STANDARD;

export const processInbound = async (
  payload: InboundPayload,
): Promise<InboundResult> => {
  const message = payload.message;
  const wamid = message.id;
  const log = logger.child({
    fn: 'wa-inbound-processor',
    correlationId: wamid ?? payload.webhookEventId ?? null,
    accountId: payload.accountId,
  });

  if (typeof wamid !== 'string' || wamid.length === 0) {
    log.warn('wa.inbound.no_wamid');

    return { outcome: 'skipped', reason: 'missing wamid' };
  }

  /**
   * WAMID dedup (AR-8). The unique index would catch a duplicate at create
   * time too, but checking first avoids doing the thread work — and, more
   * importantly, avoids the thread's unread count and preview being updated
   * twice for one message.
   */
  const existing = await findMessageByWamid(wamid);

  if (existing !== null) {
    count(METRIC.INBOUND_DEDUP_HIT);
    log.debug('wa.inbound.dedup_hit');

    if (payload.webhookEventId !== undefined) {
      await markWebhookEvent(payload.webhookEventId, 'SKIPPED_DUPLICATE');
    }

    return { outcome: 'duplicate', messageId: existing.id };
  }

  const account = await findAccountById(payload.accountId);

  if (account === null) {
    log.error('wa.inbound.unknown_account');

    return { outcome: 'skipped', reason: 'unknown account' };
  }

  const waId = message.from;

  if (typeof waId !== 'string' || waId.length === 0) {
    log.warn('wa.inbound.no_sender');

    return { outcome: 'skipped', reason: 'missing sender' };
  }

  const profileName = payload.contacts?.[0]?.profile?.name ?? null;

  const { thread, created: threadCreated } = await upsertThread({
    account,
    waId,
    profileName,
    resolveIdentity: true,
  });

  const normalised = normaliseInboundMessage(message);

  if (normalised.messageType === MESSAGE_TYPE.UNSUPPORTED) {
    count(METRIC.INBOUND_UNSUPPORTED_TYPE);
  }

  /**
   * A reaction is stored as its own row *and* patched onto the target's
   * payload (FR-IN-4). The row keeps the raw event auditable; the patch is what
   * the chat renders, because a reaction is not a thread entry — it belongs on
   * the bubble it reacts to.
   */
  if (normalised.messageType === MESSAGE_TYPE.REACTION) {
    return processReaction({ payload, thread, normalised, wamid, waId, log });
  }

  const record = await createMessage({
    threadId: thread.id,
    wamid,
    direction: DIRECTION.INBOUND,
    messageType: normalised.messageType,
    body: normalised.body,
    payload: normalised.payload,
    /**
     * Inbound messages are created at `DELIVERED`: we have it, which is the
     * strongest statement the model can make about an inbound message. There
     * is no `sent` for something we received.
     */
    status: MESSAGE_STATUS.DELIVERED,
    statusTimestamps: { delivered: message.timestamp ?? null },
    errorCode: normalised.errorCode,
    errorDetail: normalised.errorDetail,
    mediaMeta:
      normalised.mediaMeta === null
        ? null
        : {
            ...normalised.mediaMeta,
            inlineUrlExpiresAt: normalised.mediaMeta.inlineUrlExpiresAt?.toISOString() ?? null,
          },
    contextWamid: normalised.contextWamid,
    waTimestamp: normalised.waTimestamp.toISOString(),
    lane: LANE.INTERACTIVE,
    sourceKind: SOURCE_KIND.SYSTEM,
  });

  const occurredAt = normalised.waTimestamp;
  const windowKind = windowForMessage(normalised.referral !== null);
  const windowHours =
    windowKind === WINDOW_KIND.FREE_ENTRY_POINT
      ? config.fepWindowHours()
      : config.serviceWindowHours();

  // One write, seven columns: see the note on `patchThread`.
  await patchThread(thread.id, {
    lastInboundAt: occurredAt.toISOString(),
    lastMessageAt: occurredAt.toISOString(),
    lastMessagePreview: normalised.preview,
    lastMessageDirection: DIRECTION.INBOUND,
    unreadCount: (thread.unreadCount ?? 0) + 1,
    status: statusAfterInbound(thread.status) as typeof THREAD_STATUS.OPEN,
    serviceWindowExpiresAt: computeWindowExpiry(occurredAt, windowKind, {
      serviceWindowHours: config.serviceWindowHours(),
      fepWindowHours: config.fepWindowHours(),
    }).toISOString(),
    windowState: WINDOW_STATE.OPEN,
    windowKind,
    ...(normalised.referral === null
      ? {}
      : { referral: normalised.referral as Record<string, unknown> }),
  });

  log.info('wa.inbound.processed', {
    threadId: thread.id,
    messageId: record.id,
    messageType: normalised.messageType,
    windowHours,
    threadCreated,
  });
  count(METRIC.INBOUND_PROCESSED);

  await runSideEffects({
    payload,
    thread,
    threadCreated,
    messageId: record.id,
    wamid,
    normalised,
    accountId: account.id,
  });

  if (payload.webhookEventId !== undefined) {
    await markWebhookEvent(payload.webhookEventId, 'PROCESSED');
  }

  return { outcome: 'processed', messageId: record.id, threadId: thread.id };
};

const processReaction = async ({
  payload,
  thread,
  normalised,
  wamid,
  log,
}: {
  payload: InboundPayload;
  thread: WhatsappThreadRecord;
  normalised: ReturnType<typeof normaliseInboundMessage>;
  wamid: string;
  waId: string;
  log: ReturnType<typeof logger.child>;
}): Promise<InboundResult> => {
  const record = await createMessage({
    threadId: thread.id,
    wamid,
    direction: DIRECTION.INBOUND,
    messageType: MESSAGE_TYPE.REACTION,
    body: normalised.body,
    payload: normalised.payload,
    status: MESSAGE_STATUS.DELIVERED,
    reactionTargetWamid: normalised.reactionTargetWamid,
    waTimestamp: normalised.waTimestamp.toISOString(),
    lane: LANE.INTERACTIVE,
    sourceKind: SOURCE_KIND.SYSTEM,
  });

  const targetWamid = normalised.reactionTargetWamid;

  if (targetWamid !== null) {
    /**
     * The same helper the outbound sender calls. Two implementations of
     * "replace this actor's reaction" is how a rep's 👍 and a customer's 👍
     * end up stored differently and rendered differently.
     */
    const outcome = await applyReaction({
      targetWamid,
      actor: {
        kind: 'CONTACT',
        waId: payload.message.from ?? '',
        label: thread.profileName ?? null,
      },
      emoji: normalised.body ?? '',
    });

    if (outcome === 'target_missing') log.debug('wa.inbound.reaction_target_missing');
  }

  /**
   * A reaction does not touch `unreadCount`, the preview or the service
   * window. It is not a message a rep has to answer, and counting it as unread
   * would make the inbox lie about what needs attention.
   */
  if (payload.webhookEventId !== undefined) {
    await markWebhookEvent(payload.webhookEventId, 'PROCESSED');
  }

  count(METRIC.INBOUND_PROCESSED);
  log.info('wa.inbound.reaction', { threadId: thread.id, messageId: record.id });

  return { outcome: 'processed', messageId: record.id, threadId: thread.id };
};

/**
 * Every side effect is independently failure-tolerant (specs/03 §4 step 9): a
 * timeline write that fails must never lose the message that provoked it.
 */
const runSideEffects = async ({
  payload,
  thread,
  threadCreated,
  messageId,
  wamid,
  normalised,
  accountId,
}: {
  payload: InboundPayload;
  thread: WhatsappThreadRecord;
  threadCreated: boolean;
  messageId: string;
  wamid: string;
  normalised: ReturnType<typeof normaliseInboundMessage>;
  accountId: string;
}): Promise<void> => {
  const log = logger.child({ fn: 'wa-inbound-processor', correlationId: wamid });

  if (normalised.isMedia) {
    await enqueue({
      logicFunctionUniversalIdentifier: LF_MEDIA_WORKER,
      payload: { messageId },
      correlationId: wamid,
    });
  }

  if (
    matchesKeyword(normalised.body, config.optOutKeywords()) ||
    matchesKeyword(normalised.body, config.optInKeywords())
  ) {
    await enqueue({
      logicFunctionUniversalIdentifier: LF_CONSENT_KEYWORD,
      payload: { messageId, threadId: thread.id, accountId, wamid },
      correlationId: wamid,
    });
  }

  /**
   * A campaign recipient who replies is the outcome the campaign existed for
   * (FR-CAM-13), and it is recorded once — a chatty conversation must not
   * inflate `respondedCount` with every turn.
   */
  if (typeof thread.originCampaignId === 'string' && thread.originCampaignId.length > 0) {
    try {
      const recipient = await findRecipientByThreadId(thread.originCampaignId, thread.id);

      if (recipient !== null && recipient.status !== RECIPIENT_STATUS.RESPONDED) {
        await patchRecipient(recipient.id, { status: RECIPIENT_STATUS.RESPONDED });

        /**
         * Without this the reply would not reach `respondedCount` until some
         * *other* recipient's delivery status happened to wake the rollup —
         * so the last campaign to finish sending would under-report its
         * responses indefinitely, which is the number the whole campaign was
         * run to produce.
         */
        await noteCampaignChange(thread.originCampaignId, { responded: 1 });
      }
    } catch (error) {
      log.warn('wa.inbound.campaign_attribution_failed', describeError(error));
    }
  }

  try {
    const person =
      typeof thread.personId === 'string' ? await findPersonById(thread.personId) : null;

    await writeTimelineActivity({
      name: TIMELINE_EVENT.MESSAGE_RECEIVED,
      happensAt: normalised.waTimestamp,
      properties: {
        type: normalised.messageType,
        preview: normalised.preview,
        threadId: thread.id,
        hasMedia: normalised.isMedia,
      },
      targetPersonId: thread.personId ?? null,
      targetCompanyId: person?.companyId ?? null,
      linkedRecordId: messageId,
      linkedObjectUniversalIdentifier: OBJ_MESSAGE,
      linkedRecordCachedName: normalised.preview,
      isFirstOfThread: threadCreated,
    });
  } catch (error) {
    log.warn('wa.inbound.timeline_failed', describeError(error));
  }

  void payload;
};

export const handler = async (payload: InboundPayload): Promise<InboundResult> => {
  try {
    return await processInbound(payload);
  } catch (error) {
    /**
     * Marking the raw row `FAILED` is what makes NFR-R1 true: the message is
     * still in `whatsappWebhookEvent.payload`, replayable from the settings UI,
     * rather than lost with the job.
     */
    if (payload.webhookEventId !== undefined) {
      await markWebhookEventFailed(
        payload.webhookEventId,
        0,
        error instanceof Error ? error.message : String(error),
      );
    }

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_INBOUND_PROCESSOR,
  name: 'wa-inbound-processor',
  description:
    'Turns one inbound Meta message into a thread, a message record and its side effects.',
  timeoutSeconds: 30,
  handler,
});
