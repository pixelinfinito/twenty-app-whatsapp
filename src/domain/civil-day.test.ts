import { describe, expect, it } from 'vitest';

import {
  civilDayKeyOf,
  nextCivilDayKey,
  previousCivilDayKey,
  startOfCivilDay,
  startOfNextCivilDay,
} from './civil-day';

/**
 * Every assertion below sits on a transition day or beside one, because that
 * is where offset arithmetic fails: a day with a transition is 23 or 25 hours,
 * and `+ 86_400_000` drifts an hour past the next midnight on each of them.
 */
describe('civilDayKeyOf', () => {
  it('names the civil date of the zone, not of UTC', () => {
    // 23:30Z is already the 17th in Luanda (UTC+1).
    expect(civilDayKeyOf(new Date('2026-08-16T23:30:00.000Z'), 'Africa/Luanda')).toBe(
      '2026-08-17',
    );
  });

  it('follows the zone across a spring transition', () => {
    // 05:30Z is 00:30 EST (the transition comes at 07:00Z), so the 8th —
    // though Luanda at the same instant reads 06:30, also the 8th.
    expect(civilDayKeyOf(new Date('2026-03-08T05:30:00.000Z'), 'America/New_York')).toBe(
      '2026-03-08',
    );
  });
});

describe('startOfCivilDay and startOfNextCivilDay', () => {
  it('spans a 23-hour spring-forward day in New York', () => {
    // DST starts 2026-03-08 at 02:00 local. Midnight EST is 05:00Z; the next
    // midnight is already EDT, 04:00Z.
    const at = new Date('2026-03-08T12:00:00.000Z');

    expect(startOfCivilDay(at, 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
    expect(startOfNextCivilDay(at, 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });

  it('spans a 25-hour fall-back day in New York', () => {
    // DST ends 2026-11-01 at 02:00 local. Midnight EDT is 04:00Z; the next
    // midnight is EST, 05:00Z.
    const at = new Date('2026-11-01T12:00:00.000Z');

    expect(startOfCivilDay(at, 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    expect(startOfNextCivilDay(at, 'America/New_York').toISOString()).toBe(
      '2026-11-02T05:00:00.000Z',
    );
  });

  it('spans the 25-hour fall-back day in Lisbon', () => {
    // The EU falls back at 01:00Z on 2026-10-25: midnight WEST is 23:00Z on
    // the 24th, and the next midnight WET is 00:00Z on the 26th.
    const at = new Date('2026-10-25T12:00:00.000Z');

    expect(startOfCivilDay(at, 'Europe/Lisbon').toISOString()).toBe(
      '2026-10-24T23:00:00.000Z',
    );
    expect(startOfNextCivilDay(at, 'Europe/Lisbon').toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
  });

  it('spans the 23-hour spring-forward day in Sydney', () => {
    // DST starts 2026-10-04 at 02:00 AEST. Midnight AEST is 14:00Z the day
    // before; the next midnight is AEDT, 13:00Z.
    const at = new Date('2026-10-04T03:00:00.000Z');

    expect(startOfCivilDay(at, 'Australia/Sydney').toISOString()).toBe(
      '2026-10-03T14:00:00.000Z',
    );
    expect(startOfNextCivilDay(at, 'Australia/Sydney').toISOString()).toBe(
      '2026-10-04T13:00:00.000Z',
    );
  });

  it('keeps 24-hour days where there is no transition', () => {
    const at = new Date('2026-08-16T12:00:00.000Z');

    expect(startOfCivilDay(at, 'Africa/Luanda').toISOString()).toBe('2026-08-15T23:00:00.000Z');
    expect(startOfNextCivilDay(at, 'Africa/Luanda').toISOString()).toBe('2026-08-16T23:00:00.000Z');
  });

  it('resolves the boundary instants to the exact civil day they separate', () => {
    const from = startOfCivilDay(new Date('2026-03-08T12:00:00.000Z'), 'America/New_York');
    const to = startOfNextCivilDay(new Date('2026-03-08T12:00:00.000Z'), 'America/New_York');

    expect(civilDayKeyOf(from, 'America/New_York')).toBe('2026-03-08');
    expect(civilDayKeyOf(new Date(from.getTime() - 1), 'America/New_York')).toBe('2026-03-07');
    expect(civilDayKeyOf(new Date(to.getTime() - 1), 'America/New_York')).toBe('2026-03-08');
    expect(civilDayKeyOf(to, 'America/New_York')).toBe('2026-03-09');
  });
});

describe('civil key arithmetic', () => {
  it('crosses month, year and leap-day boundaries', () => {
    expect(nextCivilDayKey('2026-12-31')).toBe('2027-01-01');
    expect(nextCivilDayKey('2028-02-28')).toBe('2028-02-29');
    expect(nextCivilDayKey('2026-02-28')).toBe('2026-03-01');
    expect(previousCivilDayKey('2026-03-01')).toBe('2026-02-28');
    expect(previousCivilDayKey('2027-01-01')).toBe('2026-12-31');
  });
});
