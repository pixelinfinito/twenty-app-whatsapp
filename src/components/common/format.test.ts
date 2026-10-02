import { afterEach, describe, expect, it } from 'vitest';

import { langOf, TABLES, translateWith } from './copy';
import { chatTimeZone, clockTime, countdown, dayKey, daySeparator, fileSize, money } from './format';
import { TIME_ZONE_VARIABLE } from '../../domain/time-zone';

const t = translateWith('pt');

/**
 * The host hands a front component its variables in a bundle; outside a host
 * the SDK reads them from `process.env.applicationVariables` as JSON.
 */
const configureZone = (zone: string | undefined): void => {
  if (zone === undefined) delete process.env.applicationVariables;
  else process.env.applicationVariables = JSON.stringify({ [TIME_ZONE_VARIABLE]: zone });
};

/**
 * Africa/Luanda is UTC+1 with no daylight saving, so 23:30 UTC is already
 * tomorrow for the customer. Every assertion below is about that hour.
 */
describe('day boundaries', () => {
  afterEach(() => configureZone(undefined));
  it('files a late-evening message under the customer’s day, not UTC’s', () => {
    // 23:30Z on the 16th is 00:30 on the 17th in Luanda.
    expect(dayKey('2026-08-16T23:30:00.000Z')).toBe('2026-08-17');
    expect(dayKey('2026-08-16T22:30:00.000Z')).toBe('2026-08-16');
  });

  it('calls the customer’s today today', () => {
    const now = new Date('2026-08-17T09:00:00.000Z');

    expect(daySeparator('2026-08-16T23:30:00.000Z', now, 'pt', t)).toBe('Hoje');
  });

  it('calls the day before yesterday', () => {
    const now = new Date('2026-08-17T09:00:00.000Z');

    expect(daySeparator('2026-08-16T12:00:00.000Z', now, 'pt', t)).toBe('Ontem');
  });

  /**
   * Yesterday is the previous *civil* day, not now minus 24 hours. Across a
   * transition the subtraction lands a civil day short: at 00:30 in New York
   * on March 9th, now minus a day is 23:30 on March 7th — the old code called
   * *Saturday* "Yesterday" and kept Sunday's messages on a weekday label.
   */
  it('labels the whole of the previous civil day as yesterday across a transition', () => {
    configureZone('America/New_York');

    const now = new Date('2026-03-09T04:30:00.000Z'); // 00:30 EDT, March 9th.
    const en = translateWith('en');

    expect(daySeparator('2026-03-08T23:00:00.000Z', now, 'en', en)).toBe('Yesterday');
    expect(daySeparator('2026-03-08T06:30:00.000Z', now, 'en', en)).toBe('Yesterday');
    expect(daySeparator('2026-03-07T12:00:00.000Z', now, 'en', en)).toContain('Saturday');
  });

  it('shows the clock in Luanda, not in the reader’s zone', () => {
    expect(clockTime('2026-08-16T23:30:00.000Z', 'pt')).toBe('00:30');
  });
});

describe('chatTimeZone', () => {
  afterEach(() => configureZone(undefined));

  it('defaults to Luanda when nothing is configured', () => {
    expect(chatTimeZone()).toBe('Africa/Luanda');
  });

  it('follows the configured zone', () => {
    configureZone('America/Mexico_City');

    expect(chatTimeZone()).toBe('America/Mexico_City');
  });

  it('degrades an unrecognised zone to the default rather than failing to render', () => {
    configureZone('Not/AZone');

    expect(chatTimeZone()).toBe('Africa/Luanda');
  });

  it('files a Mexican evening message under the customer’s day', () => {
    configureZone('America/Mexico_City');

    // 02:00Z on the 17th is 20:00 on the 16th in Mexico City — yesterday’s
    // conversation, not today’s.
    expect(
      daySeparator('2026-08-17T02:00:00.000Z', new Date('2026-08-17T09:00:00.000Z'), 'en', translateWith('en')),
    ).toBe('Yesterday');
  });
});

describe('countdown', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');

  it('reads hours and minutes while there is time', () => {
    expect(countdown('2026-08-16T17:12:00.000Z', now)).toBe('5h 12m');
  });

  it('drops to minutes inside the last hour', () => {
    expect(countdown('2026-08-16T12:45:00.000Z', now)).toBe('45m');
  });

  it('never rounds a nearly-closed window up to a minute', () => {
    // Rounding "59 seconds left" to "1m" is how a rep types a free-form reply
    // into a window that closes while they are typing.
    expect(countdown('2026-08-16T12:00:59.000Z', now)).toBe('<1m');
  });

  it('answers null once the window has closed, so no chip is drawn', () => {
    expect(countdown('2026-08-16T11:59:59.000Z', now)).toBeNull();
    expect(countdown(null, now)).toBeNull();
  });
});

describe('fileSize', () => {
  it('reads the way a download button should', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(51_200)).toBe('50 kB');
    expect(fileSize(94_371_840)).toBe('90 MB');
    expect(fileSize(1_572_864)).toBe('1.5 MB');
  });

  it('says nothing rather than "NaN" for a size nobody recorded', () => {
    expect(fileSize(null)).toBe('');
    expect(fileSize(undefined)).toBe('');
  });
});

describe('money', () => {
  it('keeps two decimals for ordinary amounts', () => {
    expect(money(12.5)).toBe('$12.50');
    expect(money(0.02)).toBe('$0.02');
    expect(money(0)).toBe('$0.00');
  });

  /** A $0.004 utility send rendered as `$0.00` read as "free" (UX review). */
  it('never rounds a real cost down to nothing', () => {
    expect(money(0.004)).toBe('$0.004');
    expect(money(0.0009)).toBe('$0.0009');
  });

  it('answers $0.00 rather than NaN for an amount nobody recorded', () => {
    expect(money(null)).toBe('$0.00');
    expect(money(undefined)).toBe('$0.00');
  });
});

describe('copy', () => {
  it('renders a missing key visibly rather than as silence', () => {
    // A blank denial reads as "you may send".
    expect(t('policy.NOT_A_REAL_CODE')).toBe('policy.NOT_A_REAL_CODE');
  });

  it('answers in the reader’s language', () => {
    expect(translateWith('pt')('policy.WINDOW_CLOSED')).toContain('janela');
    expect(translateWith('en')('policy.WINDOW_CLOSED')).toContain('window');
    expect(translateWith('es')('policy.WINDOW_CLOSED')).toContain('ventana');
  });

  /**
   * A Spanish locale used to fall through to English, and once `es` existed in
   * the catalogue its *table* was still missing — `translateWith('es')` read
   * `TABLES.es` before that table was built and threw on the first key. Both
   * routes are pinned: the locale routes to `es`, and `es` renders.
   */
  it('routes an es locale to Spanish, not to English', () => {
    expect(langOf('es-419')).toBe('es');
    expect(translateWith('es')('chat.today')).toBe('Hoy');
  });

  /**
   * The structural guarantee, asserted rather than assumed. Parallel tables let
   * a key exist in one language and not the other, and the failure surfaces as
   * an English sentence in a Portuguese screen — or as nothing at all. Paired
   * entries make it unrepresentable; this is what proves the pairing held.
   */
  it('has every language for every key, and none is blank', () => {
    const keys = Object.keys(TABLES.pt);

    expect(keys.length).toBeGreaterThan(100);
    expect(Object.keys(TABLES.en)).toEqual(keys);
    expect(Object.keys(TABLES.es)).toEqual(keys);

    const blank = keys.filter(
      (key) =>
        TABLES.pt[key]!.trim() === '' ||
        TABLES.en[key]!.trim() === '' ||
        TABLES.es[key]!.trim() === '',
    );

    expect(blank).toEqual([]);
  });

  /**
   * A `{placeholder}` that exists in one language and not the other renders as
   * literal braces for half the users — the kind of defect that survives review
   * because the language the reviewer reads is fine.
   */
  it('uses the same placeholders in every language', () => {
    const placeholders = (text: string): string[] =>
      (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

    const mismatched = Object.keys(TABLES.pt).filter(
      (key) =>
        placeholders(TABLES.pt[key]!).join(',') !== placeholders(TABLES.en[key]!).join(',') ||
        placeholders(TABLES.pt[key]!).join(',') !== placeholders(TABLES.es[key]!).join(','),
    );

    expect(mismatched).toEqual([]);
  });

  it('substitutes values', () => {
    expect(t('chat.closesIn', { time: '5h 12m' })).toBe('fecha em 5h 12m');
  });
});
