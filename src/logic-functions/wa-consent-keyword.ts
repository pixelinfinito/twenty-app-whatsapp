import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_CONSENT_KEYWORD } from '../constants/universal-identifiers';
import {
  CONSENT_METHOD,
  CONSENT_STATUS,
  LANE,
  SOURCE_KIND,
  type ConsentStatus,
} from '../domain/constants';
import { DEFAULTS, config } from '../server/config';
import { setConsent } from '../server/consent';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { queueOutbound } from '../server/outbound';
import { findAccountById } from '../server/repositories/accounts';
import { findMessageById } from '../server/repositories/messages';
import { findThreadById, patchThread } from '../server/repositories/threads';
import { foldForKeyword, matchesKeyword } from './wa-inbound-processor';

/**
 * STOP and START (FR-CON-3, specs/06 §10).
 *
 * Enqueued by the inbound processor when a message consists entirely of opt-out
 * or opt-in keywords. Two properties make this correct rather than merely
 * working:
 *
 * **Exactly one confirmation.** `setConsent` is idempotent and reports whether
 * anything changed; the reply is sent only when it did. A contact who sends
 * "STOP" three times gets one answer, not three, and the suppression lives in
 * one place rather than in every caller. Sending three would be both annoying
 * and, to someone who has just asked to be left alone, exactly the wrong
 * message.
 *
 * **The reply is free-form, and legal.** The inbound message just opened a
 * 24-hour service window, so a plain text reply needs no template and costs
 * nothing. It goes through the normal outbound path with `sourceKind: SYSTEM`,
 * which means it is paced, retried, policy-checked and recorded like any other
 * message — including the policy gate's own rule that a free-form reply inside
 * an open window is allowed even to someone who has just opted out.
 */

export type ConsentKeywordPayload = {
  messageId: string;
  threadId: string;
  accountId: string;
  wamid: string;
};

export type ConsentKeywordResult = {
  outcome: 'opted_out' | 'opted_in' | 'unchanged' | 'skipped';
  confirmationSent: boolean;
  reason?: string;
};

/**
 * Which way the keyword points.
 *
 * Opt-out is tested first and wins a tie. The lists are operator-editable, so
 * nothing stops a word appearing in both; if that happens, treating it as an
 * opt-out is the only safe reading — a missed opt-in is a message not sent, a
 * missed opt-out is a message sent to someone who asked us to stop.
 */
export const consentIntent = (
  body: string | null,
  { optOut, optIn }: { optOut: string[]; optIn: string[] },
): Exclude<ConsentStatus, 'UNKNOWN'> | null => {
  if (matchesKeyword(body, optOut)) return CONSENT_STATUS.OPTED_OUT;
  if (matchesKeyword(body, optIn)) return CONSENT_STATUS.OPTED_IN;

  return null;
};

/**
 * The confirmation wording, by locale.
 *
 * Wording is an application variable because counsel reviews it (Q-4) and a
 * legal review must never require a deploy — the defaults live in
 * `server/config.ts` beside every other one, so there is a single place the
 * drift test can compare against the declaration.
 *
 * The locale is a variable too, rather than inferred from the keyword the
 * customer typed: keyword lists are operator-editable, so "STOP" is as likely
 * to come from a Portuguese speaker as an English one, and guessing wrong sends
 * a compliance message in a language the recipient may not read.
 */
/**
 * `{optOutKeyword}` / `{optInKeyword}` resolved against the live lists.
 *
 * Opt-in wording: a confirmation written with these cannot drift out of step
 * with the keyword lists, because it *is* the keyword list. The cost is that
 * the head of the list wins — `['STOP', 'SAIR', …]` always yields `STOP` — and
 * the lists carry no language tag, so this suits an instance running one
 * language and not one advertising a different word per locale. That is why
 * the shipped defaults spell the word out (see `DEFAULTS`).
 *
 * An empty list falls back to the shipped default rather than interpolating
 * nothing: "Para parar, responda ." is worse than naming a word, and a list
 * emptied by accident is exactly when the confirmation still needs to say
 * something a human can act on.
 */
export const resolveConfirmationKeywords = (
  text: string,
  { optOut, optIn }: { optOut: string[]; optIn: string[] },
): string =>
  text
    .replace(/\{optOutKeyword\}/g, optOut[0] ?? DEFAULTS.optOutKeywords[0])
    .replace(/\{optInKeyword\}/g, optIn[0] ?? DEFAULTS.optInKeywords[0]);

export const confirmationText = (status: Exclude<ConsentStatus, 'UNKNOWN'>): string => {
  const locale = config.confirmationLocale();

  const raw =
    status === CONSENT_STATUS.OPTED_OUT
      ? locale === 'en'
        ? config.optOutConfirmationEn()
        : config.optOutConfirmationPt()
      : locale === 'en'
        ? config.optInConfirmationEn()
        : config.optInConfirmationPt();

  return resolveConfirmationKeywords(raw, {
    optOut: config.optOutKeywords(),
    optIn: config.optInKeywords(),
  });
};

/**
 * Confirmations that name a keyword the matcher would no longer accept.
 *
 * Only **known consent words** are candidates — the words currently in either
 * list, plus the shipped defaults. That is what keeps a company name or an
 * acronym in the wording from raising a false alarm, which matters: this is a
 * health row, and a health row that cries wolf is a health row people stop
 * reading.
 *
 * Wording that uses the placeholders cannot drift and never appears here.
 */
export const consentWordingDrift = (
  wording: { optOutConfirmation: string; optInConfirmation: string },
  lists: { optOut: string[]; optIn: string[] },
): { text: 'optOutConfirmation' | 'optInConfirmation'; word: string; expectedIn: 'optOut' | 'optIn' }[] => {
  const fold = (value: string): string => foldForKeyword(value);
  const known = new Set(
    [
      ...lists.optOut,
      ...lists.optIn,
      ...DEFAULTS.optOutKeywords,
      ...DEFAULTS.optInKeywords,
    ].map(fold),
  );

  const drift: {
    text: 'optOutConfirmation' | 'optInConfirmation';
    word: string;
    expectedIn: 'optOut' | 'optIn';
  }[] = [];

  /**
   * An opt-*out* confirmation tells the customer how to come back, so the word
   * it names has to be an opt-*in* keyword — and vice versa. Getting this pair
   * the wrong way round would report every correct install as broken.
   */
  const checks = [
    {
      text: 'optOutConfirmation' as const,
      body: wording.optOutConfirmation,
      expectedIn: 'optIn' as const,
      accepted: new Set(lists.optIn.map(fold)),
    },
    {
      text: 'optInConfirmation' as const,
      body: wording.optInConfirmation,
      expectedIn: 'optOut' as const,
      accepted: new Set(lists.optOut.map(fold)),
    },
  ];

  for (const check of checks) {
    /**
     * Capitalised tokens only. Every confirmation that names a keyword shouts
     * it — `responda SAIR`, `Reply STOP` — because it is a literal the
     * customer has to type back, and the shout is what separates the
     * instruction from the same word used as ordinary prose ("para parar").
     */
    for (const token of check.body.split(/\s+/)) {
      const bare = token.replace(/[^\p{L}\p{N}]/gu, '');

      if (bare.length < 2 || bare !== bare.toUpperCase()) continue;

      const folded = fold(bare);

      if (!known.has(folded) || check.accepted.has(folded)) continue;

      drift.push({ text: check.text, word: bare, expectedIn: check.expectedIn });
    }
  }

  return drift;
};

export const processConsentKeyword = async (
  payload: ConsentKeywordPayload,
): Promise<ConsentKeywordResult> => {
  const log = logger.child({ fn: 'wa-consent-keyword', correlationId: payload.wamid });

  const message = await findMessageById(payload.messageId);

  if (message === null) {
    return { outcome: 'skipped', confirmationSent: false, reason: 'message not found' };
  }

  const intent = consentIntent(message.body ?? null, {
    optOut: config.optOutKeywords(),
    optIn: config.optInKeywords(),
  });

  if (intent === null) {
    /**
     * The processor decided this was a keyword and the handler disagrees, which
     * means the two read different configuration — a variable changed between
     * the enqueue and the run. Worth a line, not worth an error.
     */
    log.debug('wa.consent.no_keyword_on_recheck');

    return { outcome: 'skipped', confirmationSent: false, reason: 'no keyword' };
  }

  const thread = await findThreadById(payload.threadId);

  if (thread === null) {
    return { outcome: 'skipped', confirmationSent: false, reason: 'thread not found' };
  }

  /**
   * An unlinked conversation has no Person to record consent against. The
   * request is still honoured — the thread is blocked, which suppresses every
   * send through the policy gate's second rule — but it cannot become part of
   * the evidence trail until someone links the contact.
   *
   * Blocking rather than ignoring matters: the alternative is a contact who
   * asked to stop and keeps receiving messages because nobody had matched them
   * to a record yet.
   */
  if (typeof thread.personId !== 'string' || thread.personId.length === 0) {
    if (intent === CONSENT_STATUS.OPTED_OUT) {
      await patchThread(thread.id, { isBlocked: true });

      log.warn('wa.consent.opt_out_without_person', { threadId: thread.id });
    }

    return {
      outcome: intent === CONSENT_STATUS.OPTED_OUT ? 'opted_out' : 'skipped',
      confirmationSent: false,
      reason: 'thread has no linked person',
    };
  }

  const result = await setConsent({
    personId: thread.personId,
    newStatus: intent,
    method: CONSENT_METHOD.KEYWORD,
    sourceReference: payload.wamid,
    wordingShown: confirmationText(intent),
  });

  count(
    intent === CONSENT_STATUS.OPTED_OUT ? METRIC.CONSENT_OPTED_OUT : METRIC.CONSENT_OPTED_IN,
  );

  if (!result.changed) {
    count(METRIC.CONSENT_CONFIRMATION_SUPPRESSED);
    log.info('wa.consent.unchanged', { status: intent });

    return { outcome: 'unchanged', confirmationSent: false };
  }

  /**
   * An opt-out also lifts a block: someone who opts back in should not stay
   * suppressed by a flag set the last time they opted out.
   */
  if (intent === CONSENT_STATUS.OPTED_IN && thread.isBlocked === true) {
    await patchThread(thread.id, { isBlocked: false });
  }

  const account = await findAccountById(payload.accountId);

  if (account === null) {
    log.warn('wa.consent.no_account_for_confirmation');

    return { outcome: intent === CONSENT_STATUS.OPTED_OUT ? 'opted_out' : 'opted_in', confirmationSent: false };
  }

  try {
    await queueOutbound({
      thread,
      account,
      spec: { kind: 'text', body: confirmationText(intent), previewUrl: false },
      body: confirmationText(intent),
      lane: LANE.INTERACTIVE,
      sourceKind: SOURCE_KIND.SYSTEM,
    });
  } catch (error) {
    /**
     * The consent change is the part that matters and it is already committed.
     * A confirmation that could not be queued is worth a warning, never a
     * failure that would retry the whole handler and risk a second one.
     */
    log.warn('wa.consent.confirmation_failed', describeError(error));

    return {
      outcome: intent === CONSENT_STATUS.OPTED_OUT ? 'opted_out' : 'opted_in',
      confirmationSent: false,
    };
  }

  log.info('wa.consent.keyword_applied', { status: intent });

  return {
    outcome: intent === CONSENT_STATUS.OPTED_OUT ? 'opted_out' : 'opted_in',
    confirmationSent: true,
  };
};

export const handler = async (
  payload: ConsentKeywordPayload,
): Promise<ConsentKeywordResult> => processConsentKeyword(payload);

export default defineLogicFunction({
  universalIdentifier: LF_CONSENT_KEYWORD,
  name: 'wa-consent-keyword',
  description:
    'Applies STOP/START keywords to a contact’s consent and sends exactly one confirmation.',
  timeoutSeconds: 30,
  handler,
});
