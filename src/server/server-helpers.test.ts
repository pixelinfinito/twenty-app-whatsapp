import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { THREAD_STATUS } from '../domain/constants';
import { chunk, isRetryableCoreError, isUniqueViolation, MAX_BATCH } from './batching';
import {
  DEFAULTS,
  boolVar,
  config,
  forAccount,
  intVar,
  listVar,
  numberVar,
  parseCountryCallingCode,
} from './config';
import { REDACTED, describeError, logger, redactForLog } from './logger';
import { splitProfileName, toLinkCandidates } from './matching';
import { metricKey } from './metrics';
import { statusAfterInbound } from './threads';
import { TIMELINE_EVENT, TIMELINE_MODE, shouldWriteActivity } from './timeline';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * D-45. The context most likely to hold something unserialisable is a
 * described error — which means the throw would land *inside a catch block*
 * and replace the real error with a TypeError about logging it.
 */
describe('logging something that cannot be serialised', () => {
  const captured: string[] = [];
  const original = console.error;

  beforeEach(() => {
    captured.length = 0;
    console.error = (line: string) => void captured.push(line);
    process.env.WA_LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    console.error = original;
  });

  it('does not throw on a BigInt', () => {
    expect(() => logger.error('wa.test', { size: BigInt(9) })).not.toThrow();
    expect(captured[0]).toContain('contextUnserialisable');
  });

  it('does not throw on a circular structure', () => {
    const loop: Record<string, unknown> = { name: 'x' };
    loop.self = loop;

    expect(() => logger.error('wa.test', { loop })).not.toThrow();
  });

  it('still names the event when the context is dropped', () => {
    logger.error('wa.send.failed', { size: BigInt(1) });

    expect(captured[0]).toContain('wa.send.failed');
  });
});

describe('logger redaction', () => {
  it('redacts a secret wherever it appears in a value', () => {
    process.env.META_ACCESS_TOKEN = 'EAABsuperSecretToken';

    expect(
      redactForLog({ url: 'https://x/?access=EAABsuperSecretToken&a=1' }),
    ).toEqual({ url: REDACTED });
  });

  it('redacts by key name regardless of the value', () => {
    expect(
      redactForLog({ Authorization: 'Bearer abc', app_secret: 'x', hash: 'y', safe: 'z' }),
    ).toEqual({
      Authorization: REDACTED,
      app_secret: REDACTED,
      hash: REDACTED,
      safe: 'z',
    });
  });

  /**
   * The shape rule catches what no key name would — a token pasted into a
   * free-text `detail` field, for instance.
   */
  it('redacts a long opaque string even under an innocent key', () => {
    expect(redactForLog({ detail: 'A'.repeat(150) })).toEqual({ detail: REDACTED });
    expect(redactForLog({ detail: 'A'.repeat(50) })).toEqual({ detail: 'A'.repeat(50) });
  });

  it('leaves ordinary content alone', () => {
    expect(redactForLog({ preview: 'Olá, tudo bem?', count: 3, ok: true })).toEqual({
      preview: 'Olá, tudo bem?',
      count: 3,
      ok: true,
    });
  });

  it('recurses into arrays and nested objects', () => {
    expect(redactForLog({ items: [{ authorization: 'x' }, { body: 'ok' }] })).toEqual({
      items: [{ authorization: REDACTED }, { body: 'ok' }],
    });
  });

  it('terminates on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;

    expect(() => JSON.stringify(redactForLog(cyclic))).not.toThrow();
  });

  it('ignores a secret too short to be one', () => {
    // An empty or tiny value would otherwise redact every log line it appears in.
    process.env.META_APP_SECRET = 'abc';

    expect(redactForLog({ note: 'abc def' })).toEqual({ note: 'abc def' });
  });
});

describe('describeError', () => {
  /** `Error` loses everything but `message` under JSON.stringify. */
  it('keeps the name, the message and a bounded stack', () => {
    const described = describeError(new TypeError('boom'));

    expect(described).toMatchObject({ errorName: 'TypeError', errorMessage: 'boom' });
    expect(String(described.errorStack).split('\n').length).toBeLessThanOrEqual(6);
  });

  it('handles a thrown non-error', () => {
    expect(describeError('plain string')).toEqual({ errorMessage: 'plain string' });
  });

  it('keeps custom properties such as a Meta error code', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 131047 }))).toMatchObject({
      code: 131047,
    });
  });
});

describe('config parsing', () => {
  it('falls back to the documented default when unset', () => {
    delete process.env.WA_SEND_THROTTLE_PER_SECOND;

    expect(config.sendThrottlePerSecond()).toBe(DEFAULTS.sendThrottlePerSecond);
  });

  /** A malformed variable degrades to the default, not to NaN two layers down. */
  it('falls back on an unparseable value', () => {
    process.env.WA_SEND_THROTTLE_PER_SECOND = 'twenty';

    expect(config.sendThrottlePerSecond()).toBe(DEFAULTS.sendThrottlePerSecond);
  });

  it('reads a set value', () => {
    process.env.WA_SEND_THROTTLE_PER_SECOND = '35';

    expect(config.sendThrottlePerSecond()).toBe(35);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['maybe', true],
  ])('parses the boolean %p', (value, expected) => {
    process.env.WA_TEST_FLAG = value;

    expect(boolVar('WA_TEST_FLAG', true)).toBe(expected);
  });

  it('parses and trims a comma list, falling back when empty', () => {
    process.env.WA_OPT_OUT_KEYWORDS = ' STOP , SAIR ,, ';

    expect(config.optOutKeywords()).toEqual(['STOP', 'SAIR']);

    process.env.WA_OPT_OUT_KEYWORDS = ' , ';

    expect(config.optOutKeywords()).toEqual([...DEFAULTS.optOutKeywords]);
  });

  it('handles a whitespace-only value as unset', () => {
    process.env.WA_SERVICE_WINDOW_HOURS = '   ';

    expect(config.serviceWindowHours()).toBe(DEFAULTS.serviceWindowHours);
  });

  /**
   * Meta retries for 7 days and this table is the only replay surface, so a
   * shorter retention would discard events Meta is still resending.
   */
  it('refuses a webhook retention below the Meta retry window', () => {
    process.env.WA_RETENTION_WEBHOOK_EVENT_DAYS = '2';

    expect(config.retentionWebhookEventDays()).toBe(7);
  });

  it('lets the account field win over the variable', () => {
    process.env.WA_DEFAULT_COUNTRY_CALLING_CODE = '+351';

    expect(forAccount('+244', config.defaultCountryCallingCode)).toBe('+244');
    expect(forAccount(null, config.defaultCountryCallingCode)).toBe('+351');
    expect(forAccount(undefined, config.defaultCountryCallingCode)).toBe('+351');
  });

  /**
   * The field is free text sitting under `phone_number_id` and `WABA id`, and
   * operators pasted the whole display number into it. The stored value is the
   * prefix put in front of every nationally-formatted contact, so a full
   * number there produces recipients that do not exist — and the send fails at
   * Meta, weeks and several layers away from the typo.
   */
  it.each(['+244', '244', ' +244 ', '1', '351'])(
    'accepts the calling code %p',
    (value) => {
      expect(parseCountryCallingCode(value)).toMatch(/^\+\d{1,3}$/);
    },
  );

  it.each([
    '+244923456789', // the whole display number — the actual bug
    '244 923 456 789',
    '+0244', // no calling code starts with zero
    '+2440',
    'AO',
    '',
    '+',
  ])('refuses %p', (value) => {
    expect(parseCountryCallingCode(value)).toBeNull();
  });

  it('normalises to a leading plus, so the normaliser never has to guess', () => {
    expect(parseCountryCallingCode('244')).toBe('+244');
    expect(parseCountryCallingCode('+244')).toBe('+244');
  });

  it('treats a false account value as set, not as absent', () => {
    // `false` is a real setting; `??` on it would silently re-enable a feature.
    expect(forAccount(false, () => true)).toBe(false);
    expect(forAccount(0, () => 20)).toBe(0);
  });

  it('exposes the other parsers', () => {
    process.env.WA_X = '7.9';

    expect(numberVar('WA_X', 1)).toBe(7.9);
    expect(intVar('WA_X', 1)).toBe(7);
    expect(listVar('WA_MISSING', ['a'])).toEqual(['a']);
  });
});

describe('batching', () => {
  it('chunks at 60 by default', () => {
    expect(MAX_BATCH).toBe(60);
    expect(chunk(Array.from({ length: 130 }, (_u, i) => i)).map((c) => c.length)).toEqual([
      60, 60, 10,
    ]);
  });

  it('returns nothing for an empty list and refuses a zero size', () => {
    expect(chunk([])).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it.each([
    ['Request failed with status 429', true],
    ['Too Many Requests', true],
    ['503 Service Unavailable', true],
    ['socket hang up', true],
    ['Field "waId" is required', false],
    ['Validation error on field status', false],
  ])('classifies %p as retryable=%s', (message, expected) => {
    expect(isRetryableCoreError(new Error(message))).toBe(expected);
  });

  /**
   * A unique violation is the *expected* outcome of a Meta redelivery, not a
   * failure — it is how dedup works at all (D-12).
   */
  it.each([
    'duplicate key value violates unique constraint "IDX_WEBHOOK_DEDUPKEY"',
    'A record with this value already exists',
    'Uniqueness violation',
  ])('recognises the unique violation %p', (message) => {
    expect(isUniqueViolation(new Error(message))).toBe(true);
  });

  it('does not mistake an ordinary error for a unique violation', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
  });
});

describe('metrics', () => {
  it('keys by event and UTC day', () => {
    expect(metricKey('wa.inbound.processed', new Date('2026-08-15T23:30:00Z'))).toBe(
      'wa:metric:wa.inbound.processed:2026-08-15',
    );
  });
});

describe('splitProfileName', () => {
  /** A mononym in `lastName` reads as a missing first name everywhere in the CRM. */
  it('puts a single word in the first name', () => {
    expect(splitProfileName('Marcos', '+244')).toEqual({ firstName: 'Marcos', lastName: '' });
  });

  /**
   * Portuguese surnames are routinely compound; splitting on the last space
   * would file "Ana Maria Silva" under "Silva" alone.
   */
  it('splits on the first space, keeping compound surnames whole', () => {
    expect(splitProfileName('Ana Maria Silva', '+244')).toEqual({
      firstName: 'Ana',
      lastName: 'Maria Silva',
    });
  });

  it('collapses whitespace and falls back when there is no name', () => {
    expect(splitProfileName('  Ana   Silva  ', '+244')).toEqual({
      firstName: 'Ana',
      lastName: 'Silva',
    });
    expect(splitProfileName('   ', '+244917164819')).toEqual({
      firstName: '+244917164819',
      lastName: '',
    });
    expect(splitProfileName(null, 'fallback')).toEqual({ firstName: 'fallback', lastName: '' });
  });
});

describe('toLinkCandidates', () => {
  it('summarises people for the disambiguation banner', () => {
    expect(
      toLinkCandidates([
        {
          id: 'p1',
          name: { firstName: 'Ana', lastName: 'Silva' },
          phones: { primaryPhoneNumber: '923000000', primaryPhoneCallingCode: '+244' },
        },
        { id: 'p2', name: null, phones: null },
      ]),
    ).toEqual([
      { personId: 'p1', name: 'Ana Silva', phone: '+244923000000' },
      { personId: 'p2', name: 'Sem nome', phone: null },
    ]);
  });
});

describe('statusAfterInbound', () => {
  /** FR-THR-2: a new inbound always reopens a closed conversation. */
  it.each([THREAD_STATUS.CLOSED, THREAD_STATUS.AWAITING_REPLY, THREAD_STATUS.OPEN, null])(
    'reopens from %s',
    (from) => {
      expect(statusAfterInbound(from)).toBe(THREAD_STATUS.OPEN);
    },
  );

  /**
   * The exception: the ambiguity is unresolved however many messages arrive,
   * and downgrading to OPEN would hide the banner asking a human to fix it.
   */
  it('leaves a needs-review thread in needs-review', () => {
    expect(statusAfterInbound(THREAD_STATUS.NEEDS_REVIEW)).toBe(THREAD_STATUS.NEEDS_REVIEW);
  });
});

describe('timeline volume control', () => {
  it('writes everything in ALL mode', () => {
    expect(
      shouldWriteActivity(TIMELINE_EVENT.MESSAGE_RECEIVED, { mode: TIMELINE_MODE.ALL }),
    ).toBe(true);
  });

  it('writes nothing in OFF mode, not even a failure', () => {
    expect(
      shouldWriteActivity(TIMELINE_EVENT.MESSAGE_FAILED, { mode: TIMELINE_MODE.OFF }),
    ).toBe(false);
  });

  /**
   * SUMMARY is the default because one activity per message is 50 000 rows/day
   * on a table Twenty uses for its own purposes.
   */
  it('skips the turns of a back-and-forth in SUMMARY mode', () => {
    expect(
      shouldWriteActivity(TIMELINE_EVENT.MESSAGE_RECEIVED, { mode: TIMELINE_MODE.SUMMARY }),
    ).toBe(false);
  });

  it('still writes the first message of a thread', () => {
    expect(
      shouldWriteActivity(TIMELINE_EVENT.MESSAGE_RECEIVED, {
        mode: TIMELINE_MODE.SUMMARY,
        isFirstOfThread: true,
      }),
    ).toBe(true);
  });

  it.each([
    TIMELINE_EVENT.TEMPLATE_SENT,
    TIMELINE_EVENT.MESSAGE_FAILED,
    TIMELINE_EVENT.CONSENT_OPTED_OUT,
    TIMELINE_EVENT.THREAD_ASSIGNED,
  ])('always writes %s — the events people look back for', (event) => {
    expect(shouldWriteActivity(event, { mode: TIMELINE_MODE.SUMMARY })).toBe(true);
  });

  it('defaults to SUMMARY when the variable is unset', () => {
    delete process.env.WA_TIMELINE_MODE;

    expect(shouldWriteActivity(TIMELINE_EVENT.MESSAGE_RECEIVED)).toBe(false);
    expect(shouldWriteActivity(TIMELINE_EVENT.MESSAGE_FAILED)).toBe(true);
  });
});
