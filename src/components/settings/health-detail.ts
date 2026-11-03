import type { Lang, Translate } from '../common/copy';
import { relativeTime } from '../common/format';

/**
 * The sentence under a health light.
 *
 * The route deliberately sends a machine value and no wording (`HealthRow`:
 * "a machine value, never a sentence — the settings tab owns the wording").
 * The tab was not honouring that: it printed `JSON.stringify(row.detail)`, so
 * an operator checking whether their number was healthy read
 * `{"accountId":"b2ba5b38-9f5a-4ecb-8ffd-6f1002a76fb7","tokenLastCheckedAt":"2026-08-16T20:00:07.472Z"}`
 * — every field they cannot act on, and none of the one they can.
 *
 * Its own module because it is the part worth testing: the panel is layout, and
 * this is the only place where a number turns into a claim about the account.
 */

type Detail = Record<string, unknown>;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const describeHealth = (
  key: string,
  detail: Detail,
  t: Translate,
  lang: Lang,
  now: Date = new Date(),
): string => {
  switch (key) {
    case 'token': {
      const checked = str(detail.tokenLastCheckedAt);

      return checked === null
        ? t('settings.health.detail.tokenNever')
        : t('settings.health.detail.tokenChecked', {
            when: relativeTime(checked, now, lang) || checked,
          });
    }

    case 'webhook': {
      const last = str(detail.webhookLastEventAt);

      return last === null
        ? t('settings.health.detail.webhookNone')
        : t('settings.health.detail.webhookLast', {
            when: relativeTime(last, now, lang) || last,
          });
    }

    /**
     * `UNKNOWN` and a missing rating are the same state — Meta has not graded
     * the number yet — and "Rated UNKNOWN" reads as a grade. The row is green
     * for both, so the sentence beside it has to agree.
     */
    case 'quality': {
      const rating = str(detail.qualityRating);

      return rating === null || rating === 'UNKNOWN'
        ? t('settings.health.detail.qualityUngraded')
        : t('settings.health.detail.quality', { rating });
    }

    /**
     * `available`, not `limit`, leads: it is what decides whether tonight's
     * campaign can start, and it is already net of the 1:1 reserve (AR-21).
     */
    case 'tier':
      return t('settings.health.detail.tier', {
        available: num(detail.available) ?? 0,
        limit: num(detail.limit) ?? 0,
        reserve: num(detail.reserve) ?? 0,
      });

    case 'failedWebhookEvents':
    case 'failedOutbound': {
      const count = num(detail.count) ?? 0;

      return count === 0
        ? t('settings.health.detail.none')
        : t('settings.health.detail.count', { count });
    }

    case 'stuckOutbound': {
      const count = num(detail.count) ?? 0;

      return count === 0
        ? t('settings.health.detail.none')
        : t('settings.health.detail.stuck', {
            count,
            minutes: num(detail.olderThanMinutes) ?? 0,
          });
    }

    /**
     * Each state gets its own sentence rather than a shared one plus a status
     * code. `404` and `401` are the two that matter and they mean entirely
     * different things — a missing route versus a mismatched secret — so a
     * line reading "the route answered 401" would leave the operator to do the
     * interpreting this row exists to do for them.
     */
    case 'webhookRoute': {
      switch (str(detail.state)) {
        case 'live':
          return detail.signed === true
            ? t('settings.health.detail.webhookRouteLive')
            : t('settings.health.detail.webhookRouteLiveUnsigned');
        case 'notRegistered':
          return t('settings.health.detail.webhookRouteMissing');
        case 'executionDisabled':
          return t('settings.health.detail.webhookRouteDisabled');
        case 'secretMismatch':
          return t('settings.health.detail.webhookRouteSecret');
        case 'errored':
          return t('settings.health.detail.webhookRouteErrored', {
            status: num(detail.status) ?? '—',
          });
        case 'unreachable':
          return t('settings.health.detail.webhookRouteUnreachable');
        default:
          return t('settings.health.detail.webhookRouteUnknown', {
            status: num(detail.status) ?? '—',
          });
      }
    }

    /**
     * The words themselves, not the count. "2 problems" sends the operator
     * hunting through four variables; "No longer recognised: SAIR" is the
     * whole investigation, and the word is the thing they have to paste back
     * into the list.
     */
    case 'consentWording': {
      const words = Array.isArray(detail.words)
        ? detail.words.filter((word): word is string => typeof word === 'string')
        : [];

      return words.length === 0
        ? t('settings.health.detail.consentWordingOk')
        : t('settings.health.detail.consentWording', { words: words.join(', ') });
    }

    /**
     * A key this build has never heard of. Showing nothing would hide a check
     * the server thinks is worth running, so the raw value still goes on
     * screen — but only here, where it is the honest answer rather than the
     * default one.
     */
    default:
      return JSON.stringify(detail);
  }
};
