import { describe, expect, it } from 'vitest';

import { translateWith } from '../common/copy';
import { describeHealth } from './health-detail';

const t = translateWith('en');
const now = new Date('2026-08-16T20:00:00.000Z');

/**
 * The panel used to print the row's raw JSON, which meant an operator asking
 * "is my number healthy" was shown an account UUID and an ISO timestamp. Every
 * case here is a check that the sentence contains the number that decides
 * something and not the ones that decide nothing.
 */
describe('describeHealth', () => {
  it('never shows the account id, which the operator cannot act on', () => {
    const line = describeHealth(
      'token',
      { accountId: 'b2ba5b38-9f5a-4ecb-8ffd-6f1002a76fb7', tokenLastCheckedAt: now.toISOString() },
      t,
      'en',
      now,
    );

    expect(line).not.toContain('b2ba5b38');
    expect(line).toContain('Checked');
  });

  it('says so plainly when the token has never been checked', () => {
    expect(describeHealth('token', { tokenLastCheckedAt: null }, t, 'en', now)).toBe(
      'Never checked',
    );
  });

  /** A quiet webhook and a webhook that has never fired are different problems. */
  it('separates a silent webhook from one that has never received anything', () => {
    expect(describeHealth('webhook', { webhookLastEventAt: null }, t, 'en', now)).toBe(
      'No events received yet',
    );
    expect(
      describeHealth(
        'webhook',
        { webhookLastEventAt: '2026-08-15T22:29:11.119Z' },
        t,
        'en',
        now,
      ),
    ).toContain('Last event');
  });

  /**
   * `available` is the number that decides whether tonight's campaign can
   * start; `limit` alone would read as headroom that is not there.
   */
  it('leads the tier line with what is actually left to send', () => {
    expect(
      describeHealth(
        'tier',
        { tier: 'TIER_250', limit: 250, used: 0, reserve: 25, available: 225 },
        t,
        'en',
        now,
      ),
    ).toBe('225 sends available today of 250, with 25 held back for 1:1 conversations');
  });

  it('reads "None" rather than "0" for the three counters', () => {
    expect(describeHealth('failedWebhookEvents', { count: 0 }, t, 'en', now)).toBe('None');
    expect(
      describeHealth('stuckOutbound', { count: 0, olderThanMinutes: 15 }, t, 'en', now),
    ).toBe('None');
    expect(describeHealth('failedOutbound', { count: 0 }, t, 'en', now)).toBe('None');
  });

  /** It printed `{"count":0}` before — the raw-JSON fallback is for unknown keys only. */
  it('renders the failed-send count as a number, never as raw JSON', () => {
    expect(describeHealth('failedOutbound', { count: 3 }, t, 'en', now)).toBe('3');
  });

  it('names the threshold when messages are stuck, so the count means something', () => {
    expect(
      describeHealth('stuckOutbound', { count: 2, olderThanMinutes: 15 }, t, 'en', now),
    ).toBe('2 for more than 15 minutes');
  });

  /**
   * A check added by a newer server than this build. Hiding it would hide a
   * problem; the raw value is the honest answer when there is no wording yet.
   */
  it('falls back to the raw value for a check it has no wording for', () => {
    expect(describeHealth('somethingNew', { count: 3 }, t, 'en', now)).toBe('{"count":3}');
  });

  it('answers in Portuguese when asked in Portuguese', () => {
    expect(describeHealth('quality', { qualityRating: 'GREEN' }, translateWith('pt'), 'pt', now)).toBe(
      'Classificação GREEN',
    );
  });

  /**
   * `UNKNOWN` is Meta saying "no data yet", which is what every number reports
   * until it has sent enough to be graded. "Rated UNKNOWN" reads as a grade,
   * and beside a row that is now green it reads as a contradiction.
   */
  it.each([{ qualityRating: 'UNKNOWN' }, { qualityRating: null }, {}])(
    'says a number is ungraded rather than inventing a rating for %p',
    (detail) => {
      expect(describeHealth('quality', detail, t, 'en', now)).toBe(
        'Meta has not rated this number yet.',
      );
    },
  );

  /**
   * 404 and 401 are the two statuses that matter and they mean opposite
   * things, so each gets its own sentence rather than a shared line quoting
   * the code back at the operator.
   */
  it.each([
    [{ state: 'notRegistered', status: 404 }, 'The server answered 404 — there is no server route for this app.'],
    [{ state: 'secretMismatch', status: 401 }, 'The route rejected a signature this app generated: META_APP_SECRET does not match the app secret in Meta.'],
    [{ state: 'live', signed: true }, 'The route answers and the signature was accepted.'],
    [{ state: 'live', signed: false }, 'The route answers. Set META_APP_SECRET to confirm the signature too.'],
    [{ state: 'executionDisabled', status: 403 }, 'The server refuses to run logic functions — nothing in this app works. Set LOGIC_FUNCTION_TYPE=LOCAL (or LAMBDA) in the Twenty server environment and restart.'],
    [{ state: 'errored', status: 500 }, 'The route exists but threw (500). On a fresh install this is almost always META_APP_SECRET being unset — the resolver refuses to verify signatures against an empty key. Check the function logs.'],
    [{ state: 'unreachable', status: null }, 'The route could not be reached from the server.'],
  ])('explains the webhook route state %p', (detail, expected) => {
    expect(describeHealth('webhookRoute', detail, t, 'en', now)).toBe(expected);
  });

  it('names the drifted consent keyword, not a count', () => {
    expect(
      describeHealth('consentWording', { count: 1, words: ['SAIR'] }, t, 'en', now),
    ).toBe('No longer recognised: SAIR');
  });

  it('says so plainly when the consent wording agrees with the lists', () => {
    expect(describeHealth('consentWording', { count: 0, words: [] }, t, 'en', now)).toBe(
      'The confirmations and the keyword lists agree.',
    );
  });
});
