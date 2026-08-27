import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULTS, config } from '../server/config';

/**
 * The declared value of an application variable and its constant fallback must
 * agree.
 *
 * A mismatch is invisible from both sides. With the variable set — which it is
 * on every install, because declaring it with a value creates it — the
 * declaration wins and the constant is dead code that nothing exercises. Clear
 * the variable and behaviour jumps to a number nobody chose, in a build where
 * every test still passes.
 *
 * Two were already wrong when this test was written. `WA_INTERACTIVE_LANE_SHARE`
 * declared `0.4` against a constant of `40` — the same word meaning a fraction
 * in one place and a percentage in the other, in a number that *multiplies the
 * send rate*, so clearing the variable would have paced the interactive lane at
 * 800 messages a second against Meta's ceiling of 80. `WA_RECIPIENT_MIN_SPACING_MS`
 * differed by a factor of eight.
 *
 * This is the same class of defect as the `WA_PROVIDER` drift that only a live
 * call found (`cloud-api.provider.test.ts`), which is why it is checked
 * mechanically rather than by reading.
 */

const source = readFileSync(join(process.cwd(), 'src/application-config.ts'), 'utf8');

const applicationVariablesBlock = ((): string => {
  const start = source.indexOf('applicationVariables: {');

  expect(start, 'applicationVariables block not found').toBeGreaterThan(-1);

  return source.slice(start);
})();

/**
 * Read from the source text rather than by importing the module:
 * `defineApplication` returns a wrapped manifest, and asserting against its
 * internal shape would make this a test about the SDK.
 */
const declaredValues = ((): Map<string, string> => {
  const declarations = new Map<string, string>();

  for (const match of applicationVariablesBlock.matchAll(
    /^\s{4}(WA_[A-Z0-9_]+|META_[A-Z0-9_]+):\s*\{([\s\S]*?)^\s{4}\},$/gm,
  )) {
    const name = match[1]!;
    const body = match[2]!;

    const value =
      /value:\s*'([^']*)'/.exec(body)?.[1] ??
      /value:\s*(true|false)/.exec(body)?.[1] ??
      /value:\s*(-?[0-9.]+)/.exec(body)?.[1] ??
      /value:\s*(\[[^\]]*\])/.exec(body)?.[1] ??
      null;

    if (value !== null) declarations.set(name, value);
  }

  return declarations;
})();

/**
 * Every constant in `DEFAULTS` paired with the variable it stands in for. The
 * pairing is explicit because the names differ by convention (`camelCase`
 * against `WA_SCREAMING_SNAKE`) and a derived mapping would silently skip
 * anything that did not match the pattern — leaving exactly the drift this
 * test exists to find.
 */
const PAIRS: [keyof typeof DEFAULTS, string][] = [
  ['defaultCountryCallingCode', 'WA_DEFAULT_COUNTRY_CALLING_CODE'],
  ['timeZone', 'WA_TIME_ZONE'],
  ['sendThrottlePerSecond', 'WA_SEND_THROTTLE_PER_SECOND'],
  ['interactiveLaneShare', 'WA_INTERACTIVE_LANE_SHARE'],
  ['recipientMinSpacingMs', 'WA_RECIPIENT_MIN_SPACING_MS'],
  ['mediaAutoDownloadMaxBytes', 'WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES'],
  ['serviceWindowHours', 'WA_SERVICE_WINDOW_HOURS'],
  ['fepWindowHours', 'WA_FEP_WINDOW_HOURS'],
  ['optOutKeywords', 'WA_OPT_OUT_KEYWORDS'],
  ['optInKeywords', 'WA_OPT_IN_KEYWORDS'],
  ['campaignBatchSize', 'WA_CAMPAIGN_BATCH_SIZE'],
  ['campaignTierReservePct', 'WA_CAMPAIGN_TIER_RESERVE_PCT'],
  ['campaignFailureWindow', 'WA_CAMPAIGN_FAILURE_WINDOW'],
  ['campaignMaxFailureRatePct', 'WA_CAMPAIGN_MAX_FAILURE_RATE_PCT'],
  ['retentionWebhookEventDays', 'WA_RETENTION_WEBHOOK_EVENT_DAYS'],
  ['retentionMessageMonths', 'WA_RETENTION_MESSAGE_MONTHS'],
  ['timelineMode', 'WA_TIMELINE_MODE'],
  ['sendReadReceipts', 'WA_SEND_READ_RECEIPTS'],
  ['webhookStalenessHours', 'WA_WEBHOOK_STALENESS_HOURS'],
  ['autoCloseDays', 'WA_AUTO_CLOSE_DAYS'],
  ['confirmationLocale', 'WA_CONFIRMATION_LOCALE'],
  ['optOutConfirmationPt', 'WA_OPT_OUT_CONFIRMATION_PT'],
  ['optOutConfirmationEn', 'WA_OPT_OUT_CONFIRMATION_EN'],
  ['optInConfirmationPt', 'WA_OPT_IN_CONFIRMATION_PT'],
  ['optInConfirmationEn', 'WA_OPT_IN_CONFIRMATION_EN'],
  ['templateSubmitHourlyCap', 'WA_TEMPLATE_SUBMIT_HOURLY_CAP'],
  ['rateMarketingUsd', 'WA_RATE_MARKETING_USD'],
  ['rateUtilityUsd', 'WA_RATE_UTILITY_USD'],
  ['rateAuthenticationUsd', 'WA_RATE_AUTHENTICATION_USD'],
  ['allowApiKeyAdmin', 'WA_ALLOW_API_KEY_ADMIN'],
];

/** `'0.0040'` and `0.004` are the same number; `['A','B']` and a JS array are the same list. */
const comparable = (value: unknown): string => {
  if (Array.isArray(value)) return value.join(',');

  if (typeof value === 'string' && /^\[.*\]$/.test(value)) {
    return [...value.matchAll(/'([^']*)'/g)].map((match) => match[1]).join(',');
  }

  // Before the numeric branch: `Number(false)` is `0`, which would make a
  // boolean variable agree with any constant that happened to be zero.
  if (typeof value === 'boolean' || value === 'true' || value === 'false') {
    return String(value);
  }

  const asNumber = Number(value);

  return Number.isFinite(asNumber) && `${value}`.trim().length > 0
    ? String(asNumber)
    : String(value);
};

describe('application variables and their constant fallbacks', () => {
  it('found the declarations to compare against', () => {
    expect(declaredValues.size).toBeGreaterThanOrEqual(PAIRS.length);
  });

  it.each(PAIRS)('declares %s to match its constant', (key, variable) => {
    const declared = declaredValues.get(variable);

    expect(declared, `${variable} is not declared`).toBeDefined();
    expect(comparable(declared), variable).toBe(comparable(DEFAULTS[key]));
  });

  /**
   * Every declared variable is paired with something. Without this, adding a
   * variable and forgetting the constant leaves a gap the table above cannot
   * see.
   */
  it('pairs every declared WA_ variable with a constant', () => {
    const paired = new Set(PAIRS.map(([, variable]) => variable));

    const unpaired = [...declaredValues.keys()].filter(
      (name) =>
        name.startsWith('WA_') &&
        !paired.has(name) &&
        // Front-end poll intervals and the provider key are read by other
        // modules, not by `config`.
        !name.startsWith('WA_POLL_INTERVAL_') &&
        name !== 'WA_PROVIDER',
    );

    expect(unpaired).toEqual([]);
  });
});

describe('the lane share, whichever way it is typed', () => {
  const withValue = <T>(value: string | undefined, read: () => T): T => {
    const previous = process.env.WA_INTERACTIVE_LANE_SHARE;

    if (value === undefined) delete process.env.WA_INTERACTIVE_LANE_SHARE;
    else process.env.WA_INTERACTIVE_LANE_SHARE = value;

    try {
      return read();
    } finally {
      if (previous === undefined) delete process.env.WA_INTERACTIVE_LANE_SHARE;
      else process.env.WA_INTERACTIVE_LANE_SHARE = previous;
    }
  };

  it('reads a percentage and a fraction as the same share', () => {
    expect(withValue('40', config.interactiveLaneShare)).toBeCloseTo(0.4);
    expect(withValue('0.4', config.interactiveLaneShare)).toBeCloseTo(0.4);
  });

  /** Neither lane may be starved, whatever an operator types. */
  it.each([
    ['0', 0.1],
    ['-5', 0.1],
    ['100', 0.9],
    ['1000', 0.9],
  ])('clamps %p to %p', (input, expected) => {
    expect(withValue(input, config.interactiveLaneShare)).toBeCloseTo(expected);
  });

  it('falls back to the constant when unset', () => {
    expect(withValue(undefined, config.interactiveLaneShare)).toBeCloseTo(
      DEFAULTS.interactiveLaneShare,
    );
  });
});
