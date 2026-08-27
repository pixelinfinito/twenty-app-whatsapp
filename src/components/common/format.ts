import { getApplicationVariable } from 'twenty-sdk/front-component';

import { resolveTimeZone, TIME_ZONE_VARIABLE } from '../../domain/time-zone';
import type { Lang, Translate } from './copy';

/**
 * Dates, countdowns and sizes (FR-UI-5, specs/08 §8).
 *
 * The time zone is not the reader's browser. A rep in Lisbon looking at an
 * Angolan number's conversation must see the day boundary the *customer* is on,
 * or a message sent at 23:30 files itself under tomorrow and the day separators
 * stop meaning anything. Same reasoning as the campaign quiet-hours rule (D-44).
 *
 * Which zone that is comes from `WA_TIME_ZONE`, defaulting to `Africa/Luanda`.
 * The rule above is what makes the browser wrong; it is not an argument for any
 * particular zone, and outside Angola the literal produced the very failure the
 * rule prevents.
 */

/**
 * Read once, on first format rather than at import.
 *
 * The host populates the variable bundle before the component runs, so a
 * module-scope read can land before there is anything to read. Deferring also
 * keeps this module importable from a test that never sets one — the same
 * reason `use-feed.ts` reads its intervals at call time.
 */
let cachedTimeZone: string | null = null;

export const chatTimeZone = (): string =>
  (cachedTimeZone ??= resolveTimeZone(getApplicationVariable(TIME_ZONE_VARIABLE)));

const LOCALE: Record<Lang, string> = { pt: 'pt-PT', en: 'en-GB', es: 'es-MX' };

const formatter = (lang: Lang, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(LOCALE[lang], { timeZone: chatTimeZone(), ...options });

export const parseDate = (value: string | null | undefined): Date | null => {
  if (typeof value !== 'string' || value.length === 0) return null;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** The time on a bubble: 14:07. */
export const clockTime = (value: string | null | undefined, lang: Lang): string => {
  const date = parseDate(value);

  return date === null
    ? ''
    : formatter(lang, { hour: '2-digit', minute: '2-digit' }).format(date);
};

/**
 * The calendar day in the configured zone, as a comparable key — never a display string.
 *
 * Assembled from parts rather than formatted, because `format()` gives a
 * locale's *order* (17/08 here, 08/17 there) and a key whose shape depends on
 * the reader's language is one that stops comparing equal when the language
 * changes.
 */
export const dayKey = (value: string | null | undefined): string => {
  const date = parseDate(value);

  if (date === null) return '';

  const parts = formatter('en', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const of = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${of('year')}-${of('month')}-${of('day')}`;
};

/** The heading between two days of a conversation. */
export const daySeparator = (
  value: string | null | undefined,
  now: Date,
  lang: Lang,
  t: Translate,
): string => {
  const key = dayKey(value);

  if (key === '') return '';
  if (key === dayKey(now.toISOString())) return t('chat.today');

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  if (key === dayKey(yesterday.toISOString())) return t('chat.yesterday');

  const date = parseDate(value)!;

  return formatter(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
};

/**
 * How long is left, as "5h 12m" (FR-UI-6).
 *
 * Truncated, not rounded: a window with 59 seconds left reads "1m" if rounded
 * up, and a rep who trusts that number sends a free-form message into a closed
 * window. Under a minute it says so.
 */
export const countdown = (
  expiresAt: string | null | undefined,
  now: Date,
): string | null => {
  const date = parseDate(expiresAt);

  if (date === null) return null;

  const remaining = date.getTime() - now.getTime();

  if (remaining <= 0) return null;

  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;

  return '<1m';
};

/** "há 5 min" / "5 min ago" for an inbox row. */
export const relativeTime = (
  value: string | null | undefined,
  now: Date,
  lang: Lang,
): string => {
  const date = parseDate(value);

  if (date === null) return '';

  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const relative = new Intl.RelativeTimeFormat(LOCALE[lang], { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];

  let amount = seconds;

  for (const [unit, size] of units) {
    if (Math.abs(amount) < size) return relative.format(Math.round(amount), unit);

    amount /= size;
  }

  return relative.format(Math.round(amount), 'year');
};

export const fileSize = (bytes: number | null | undefined): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';

  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

/**
 * `2:07` — a media duration, in the one format every player uses.
 *
 * Not localised, and deliberately so: a colon between minutes and seconds is
 * how a duration is written in both pt and en, and running it through
 * `Intl.RelativeTimeFormat` would turn "2:07" into "há 2 minutos", which is a
 * statement about *when* rather than *how long*.
 */
export const duration = (seconds: number | null | undefined): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';

  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);

  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
};

/**
 * The coordinates a location card shows as its quiet third line.
 *
 * Six decimal places is roughly 10 cm, which is far more precision than a
 * dropped pin has; four is ~11 m and is what a rep can act on without the
 * number wrapping onto a second line in a narrow pane.
 */
export const coordinates = (
  latitude: number | null,
  longitude: number | null,
): string | null =>
  latitude === null || longitude === null
    ? null
    : `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

/**
 * An external map link for a dropped pin.
 *
 * A plain link rather than an embedded tile: the sandbox renders with an opaque
 * origin, so a third-party tile server is a request that either fails or leaks
 * the customer's location to a host nobody chose (spec §"Location").
 */
export const mapLink = (latitude: number | null, longitude: number | null): string | null =>
  latitude === null || longitude === null
    ? null
    : `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

/**
 * `$0.004`, not `$0.00` — money that keeps its sub-cent precision.
 *
 * WhatsApp utility messages cost fractions of a cent, so a one-recipient
 * campaign estimated at $0.004 rendered as `$0.00` — an estimate that reads as
 * "free", which is the one thing a cost estimate must never say. Two decimals
 * remain the ceiling for ordinary amounts; a positive amount that would round
 * to zero keeps enough places to show its first significant digit (capped at
 * four, which covers every Meta rate).
 */
export const money = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$0.00';

  const abs = Math.abs(value);

  if (abs === 0 || abs >= 0.005) return `$${value.toFixed(2)}`;

  // Enough places to reach the first significant digit — $0.0009 must not
  // round up to $0.001, which is different money.
  const places = Math.min(4, Math.ceil(-Math.log10(abs)));

  return `$${value.toFixed(Math.max(3, places))}`;
};

/** `+244 928 863 659` — grouped for reading, never for dialling. */
export const displayPhone = (value: string | null | undefined): string => {
  if (typeof value !== 'string' || value.length === 0) return '';

  const digits = value.replace(/[^\d+]/g, '');

  if (!digits.startsWith('+')) return value;

  const rest = digits.slice(1);
  const groups = rest.replace(/(\d{3})(?=\d)/g, '$1 ');

  return `+${groups}`;
};
