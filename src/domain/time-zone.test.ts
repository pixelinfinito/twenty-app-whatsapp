import { describe, expect, it } from 'vitest';

import { DEFAULT_TIME_ZONE, resolveTimeZone } from './time-zone';

describe('resolveTimeZone', () => {
  it('keeps Africa/Luanda as the default, so no existing install moves', () => {
    expect(DEFAULT_TIME_ZONE).toBe('Africa/Luanda');
    expect(resolveTimeZone(undefined)).toBe('Africa/Luanda');
    expect(resolveTimeZone(null)).toBe('Africa/Luanda');
  });

  it('accepts an IANA name', () => {
    expect(resolveTimeZone('America/Mexico_City')).toBe('America/Mexico_City');
    expect(resolveTimeZone('Europe/Lisbon')).toBe('Europe/Lisbon');
    expect(resolveTimeZone('UTC')).toBe('UTC');
  });

  it('trims, because a variable captured through a form carries whitespace', () => {
    expect(resolveTimeZone('  America/Mexico_City  ')).toBe('America/Mexico_City');
  });

  it('falls back on an empty or blank value rather than passing it to Intl', () => {
    expect(resolveTimeZone('')).toBe('Africa/Luanda');
    expect(resolveTimeZone('   ')).toBe('Africa/Luanda');
  });

  /**
   * The case that decides the shape of this function. `Intl` throws on a name
   * it does not know, and the formatter is built per render — so an unvalidated
   * typo is not a wrong hour, it is every timestamp in the inbox failing to
   * render at once.
   */
  it('falls back on a name Intl rejects instead of throwing', () => {
    expect(() => resolveTimeZone('Not/A_Zone')).not.toThrow();
    expect(resolveTimeZone('Not/A_Zone')).toBe('Africa/Luanda');
    expect(resolveTimeZone('America/Mexico City')).toBe('Africa/Luanda');
  });

  it('produces a zone Intl can actually format with', () => {
    const at = new Date('2026-08-27T03:24:00.000Z');

    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: resolveTimeZone('America/Mexico_City'),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);

    expect(formatted).toBe('21:24');
  });
});
