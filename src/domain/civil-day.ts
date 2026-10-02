/**
 * Civil-day boundaries in a named time zone (FR-UI-5, FR-CAM-2a).
 *
 * A civil day — "March 8th", what a day separator names and a "created today"
 * filter partitions on — is not always 24 hours: a day with a transition is 23
 * or 25 hours, and in a zone that moves its clocks at midnight civil 00:00 can
 * be missing or occur twice. Offset arithmetic (`+ 86_400_000`, an
 * offset-snapped midnight) is wrong on exactly those days, so the boundaries
 * here are found by asking the zone itself — through `Intl` — which civil date
 * an instant falls in.
 */

const DAY_MS = 86_400_000;

/** The widest offset any IANA zone observes, ±14:00 (LINE, Kiritimati). */
const MAX_OFFSET_MS = 14 * 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

const dayFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);

  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }

  return formatter;
};

/**
 * The civil date of an instant in the zone, as a zero-padded `YYYY-MM-DD` key —
 * never a display string. Assembled from parts rather than formatted, because
 * `format()` gives a locale's *order* (17/08 here, 08/17 there) and a key whose
 * shape depends on the reader's language stops comparing equal when the
 * language changes.
 */
export const civilDayKeyOf = (at: Date, timeZone: string): string => {
  const parts = dayFormatter(timeZone).formatToParts(at);

  const of = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${of('year')}-${of('month')}-${of('day')}`;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

const keyOf = (year: number, month: number, day: number): string => {
  // `Date.UTC` normalises the overflow: the day after 2026-12-31 is
  // 2027-01-01, the day before 2026-03-01 is the 28th or 29th of February.
  const shifted = new Date(Date.UTC(year, month - 1, day));

  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate(),
  )}`;
};

const dayNumber = (key: string, from: number, to: number): number => Number(key.slice(from, to));

/** The civil day after the one the key names. */
export const nextCivilDayKey = (key: string): string =>
  keyOf(dayNumber(key, 0, 4), dayNumber(key, 5, 7), dayNumber(key, 8, 10) + 1);

/** The civil day before the one the key names. */
export const previousCivilDayKey = (key: string): string =>
  keyOf(dayNumber(key, 0, 4), dayNumber(key, 5, 7), dayNumber(key, 8, 10) - 1);

/**
 * The first instant whose civil date in the zone is the one `at` falls in —
 * civil midnight, except where the zone's clocks jump over 00:00, when it is
 * the first instant that exists on that date.
 *
 * Searched, not computed: the zone's offset changes at transitions the lookup
 * cannot see coming, and the civil date is a non-decreasing function of the
 * instant, so the first instant of the day is the boundary of the predicate
 * "civil date ≥ this day". The search bracket is wider than the widest offset
 * either side, which pins the predicate false below and true above.
 */
export const startOfCivilDay = (at: Date, timeZone: string): Date =>
  startOfCivilDayKey(civilDayKeyOf(at, timeZone), timeZone);

/** Like `startOfCivilDay`, for the day *after* the one `at` falls in. */
export const startOfNextCivilDay = (at: Date, timeZone: string): Date =>
  startOfCivilDayKey(nextCivilDayKey(civilDayKeyOf(at, timeZone)), timeZone);

const startOfCivilDayKey = (key: string, timeZone: string): Date => {
  const wall = Date.parse(`${key}T00:00:00.000Z`);

  let before = wall - DAY_MS - MAX_OFFSET_MS;
  let after = wall + MAX_OFFSET_MS;

  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);

    if (civilDayKeyOf(new Date(middle), timeZone) >= key) after = middle;
    else before = middle;
  }

  return new Date(after);
};
