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
 * Scanned, not computed: the zone's offset changes at transitions the lookup
 * cannot see coming, and the civil date is not even monotone — America/
 * Goose_Bay ended DST on 2009-11-01 by rolling midnight back into October
 * 31st, so November 1st exists in two pieces and a binary search over "civil
 * date ≥ this day" answers with the *second* piece. The bracket is stepped in
 * five-minute increments and the first rise of "civil date == this day" is
 * refined by halving; IANA never puts two transitions inside one increment,
 * so the predicate is single-step within it. Answered per (zone, day) and
 * memoised — the boundaries never move once found.
 */
export const startOfCivilDay = (at: Date, timeZone: string): Date =>
  new Date(firstInstantOfCivilDay(civilDayKeyOf(at, timeZone), timeZone));

/** Like `startOfCivilDay`, for the day *after* the one `at` falls in. */
export const startOfNextCivilDay = (at: Date, timeZone: string): Date =>
  new Date(firstInstantOfCivilDay(nextCivilDayKey(civilDayKeyOf(at, timeZone)), timeZone));

const SCAN_STEP_MS = 5 * 60_000;

const boundaries = new Map<string, number>();

const firstInstantOfCivilDay = (key: string, timeZone: string): number =>
  firstInstantOfCivilDayScanned(key, timeZone, 0);

const firstInstantOfCivilDayScanned = (
  key: string,
  timeZone: string,
  skippedDays: number,
): number => {
  const memoKey = `${timeZone} ${key}`;

  const memoised = boundaries.get(memoKey);
  if (memoised !== undefined) return memoised;

  const wall = Date.parse(`${key}T00:00:00.000Z`);
  const from = wall - DAY_MS - MAX_OFFSET_MS;
  const to = wall + DAY_MS + MAX_OFFSET_MS;

  let first: number | null = null;
  let wasMatch = civilDayKeyOf(new Date(from), timeZone) === key;

  for (let at = from + SCAN_STEP_MS; at <= to; at += SCAN_STEP_MS) {
    const isMatch = civilDayKeyOf(new Date(at), timeZone) === key;

    if (isMatch && !wasMatch) {
      first = refineBoundary(at - SCAN_STEP_MS, at, key, timeZone);
      break;
    }

    wasMatch = isMatch;
  }

  if (first === null) {
    /**
     * No instant of this civil date exists — a zone can skip a whole date
     * when it crosses the date line westward (Samoa skipped 2011-12-30). The
     * day's beginning is then the next existing day's, which is also the
     * exclusive end the window before it wants. Never recurses far: dates a
     * zone skips are beside each other by construction.
     */
    if (skippedDays < 4) return firstInstantOfCivilDayScanned(nextCivilDayKey(key), timeZone, skippedDays + 1);

    return wall;
  }

  boundaries.set(memoKey, first);

  return first;
};

/** The first instant in the step where the civil date became the day. */
const refineBoundary = (before: number, after: number, key: string, timeZone: string): number => {
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);

    if (civilDayKeyOf(new Date(middle), timeZone) === key) after = middle;
    else before = middle;
  }

  return after;
};
