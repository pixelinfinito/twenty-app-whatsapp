/**
 * The clock the app renders in (FR-UI-5, specs/08 §8).
 *
 * The rule the two call sites encode is right and stays: the reader's browser
 * is the wrong clock, because a rep in Lisbon looking at an Angolan number's
 * conversation must see the day boundary the *customer* is on, or a message
 * sent at 23:30 files itself under tomorrow and the day separators stop meaning
 * anything.
 *
 * What travels badly is spelling "the customer's time zone" as a literal. For
 * an Angolan deployment the two are the same; seven hours west they are not,
 * and the failure is the one the rule set out to prevent, just for a different
 * reader. So the zone is an application variable and this is its default —
 * `Africa/Luanda`, unchanged, so no existing install moves.
 *
 * Only the *shape* test lives here, pure and shared, following the same split
 * as `workspace-file.ts`: the domain owns the rule, and each layer reads the
 * environment the way it can. `server/config.ts` reads `process.env`; the
 * front component reads `getApplicationVariable`. Neither read belongs here —
 * the domain does not touch `process.env`, and the sandbox has no server
 * module.
 */

/** Unchanged from the literal it replaces, so nothing moves without opting in. */
export const DEFAULT_TIME_ZONE = 'Africa/Luanda';

export const TIME_ZONE_VARIABLE = 'WA_TIME_ZONE';

/**
 * A configured zone, or the default.
 *
 * Validated rather than trusted: `Intl` throws a `RangeError` on a name it does
 * not know, and an unvalidated typo would take down every timestamp in the
 * inbox at once — the formatter is constructed per render, so the throw would
 * surface as a blank panel rather than as a wrong hour. A bad value degrades to
 * the documented default, matching how `server/config.ts` treats every other
 * unparseable variable.
 */
/**
 * Memoised, because the answer for a given name never changes and the question
 * is asked per recipient.
 *
 * A snapshot resolves `now.*` for every row of a 100 000-recipient campaign, so
 * an `Intl.DateTimeFormat` constructed just to validate is built a hundred
 * thousand times for one answer — enough to push `load.test.ts` past its page
 * budget on its own.
 */
const resolved = new Map<string, string>();

export const resolveTimeZone = (configured: string | null | undefined): string => {
  if (typeof configured !== 'string') return DEFAULT_TIME_ZONE;

  const candidate = configured.trim();
  if (candidate.length === 0) return DEFAULT_TIME_ZONE;

  const cached = resolved.get(candidate);
  if (cached !== undefined) return cached;

  let answer: string;

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate });
    answer = candidate;
  } catch {
    answer = DEFAULT_TIME_ZONE;
  }

  resolved.set(candidate, answer);

  return answer;
};
