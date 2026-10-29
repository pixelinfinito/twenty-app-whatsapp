import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_CAMPAIGN_SNAPSHOT } from '../constants/universal-identifiers';
import {
  parseAudienceDefinition,
  parseCursor,
  type AudienceCursor,
  type AudienceDefinition,
} from '../domain/campaign/audience';
import {
  emptyBreakdown,
  evaluateExclusion,
  tallyExclusion,
  type ExclusionBreakdown,
} from '../domain/campaign/exclusions';
import { estimateCampaignCostUsd } from '../domain/campaign/guardrails';
import {
  resolveParameters,
  type VariableMapping,
} from '../domain/campaign/variable-resolution';
import {
  CAMPAIGN_STATUS,
  CONSENT_STATUS,
  RECIPIENT_STATUS,
  TEMPLATE_CATEGORY,
  type ConsentStatus,
  type TemplateCategory,
} from '../domain/constants';
import { toE164, toWaId } from '../domain/phone/normalise';
import type { VariableSpec } from '../domain/template-spec';
import { AudienceError, personPhones, readAudiencePage } from '../server/audience';
import { transitionCampaign } from '../server/campaign-state';
import { config, forAccount } from '../server/config';
import { enqueue } from '../server/jobs';
import { describeError, logger } from '../server/logger';
import { findAccountById } from '../server/repositories/accounts';
import { asJson } from '../server/repositories/base';
import {
  findExistingPhones,
  upsertRecipients,
  type RecipientCreateInput,
} from '../server/repositories/campaign-recipients';
import { findCampaignById } from '../server/repositories/campaigns';
import { findTemplateById } from '../server/repositories/templates';
import { findBlockedWaIds } from '../server/repositories/threads';
import { EMPTY_VARIABLE_SPEC } from './wa-outbound-sender';

/**
 * Materialising an audience (FR-CAM-2, FR-CAM-3, NFR-S4).
 *
 * **Self-requeuing, because audience size must never meet the timeout
 * ceiling.** A 100 000-person audience takes about seventeen minutes at the
 * Core API's write budget; a function with a two-minute limit that tried to do
 * it in one call would fail at a size nobody could predict and leave the
 * campaign half-built with no way to tell how far it got. Each page instead
 * writes its rows, records where it stopped, and enqueues itself — so a
 * failure costs one page and a resume costs nothing.
 *
 * **The snapshot is the campaign's content, not just its list.** Parameters
 * are resolved *here* and frozen onto each row, so editing a Person mid-send
 * cannot change what a half-sent campaign says (FR-CAM-2). Excluded people are
 * kept as rows with their reason, which is what makes "show me the 412 we
 * skipped and why" answerable and what lets a later consent campaign pick them
 * up.
 */

export type SnapshotPayload = {
  campaignId: string;
  cursor?: unknown;
  stats?: SnapshotStats;
  page?: number;
};

export type SnapshotStats = {
  scanned: number;
  accepted: number;
  excluded: number;
  breakdown: ExclusionBreakdown;
};

export type SnapshotResult = {
  outcome: 'continued' | 'completed' | 'skipped' | 'failed';
  reason?: string;
  stats?: SnapshotStats;
};

/**
 * The pause between pages (specs/07 §3).
 *
 * Not throttling for its own sake: a large snapshot and a rep's conversation
 * share one Core API budget, and a second of headroom per page is what keeps
 * building an audience from slowing the inbox.
 */
export const PAGE_DELAY_MS = 1_000;

/**
 * 400 pages of 500 is 200 000 people — twice NFR-S4's target. The cap exists so
 * a pagination bug cannot requeue forever; hitting it fails the campaign rather
 * than quietly producing a partial audience, because a partial audience that
 * reports itself `ready` is a campaign that silently missed half its
 * recipients.
 */
export const MAX_PAGES = 400;

export const emptyStats = (): SnapshotStats => ({
  scanned: 0,
  accepted: 0,
  excluded: 0,
  breakdown: emptyBreakdown(),
});

const asStats = (value: unknown): SnapshotStats => {
  if (value === null || typeof value !== 'object') return emptyStats();

  const raw = value as Partial<SnapshotStats>;

  return {
    scanned: typeof raw.scanned === 'number' ? raw.scanned : 0,
    accepted: typeof raw.accepted === 'number' ? raw.accepted : 0,
    excluded: typeof raw.excluded === 'number' ? raw.excluded : 0,
    breakdown: { ...emptyBreakdown(), ...(raw.breakdown ?? {}) },
  };
};

export type PageOutcome = {
  rows: RecipientCreateInput[];
  stats: SnapshotStats;
};

/**
 * One page of people, decided.
 *
 * Pure but for nothing — it takes the blocked set and the already-seen phones
 * as data, so the whole exclusion matrix for a page can be asserted without a
 * database. That matters because rule 2 (marketing needs an explicit opt-in,
 * so `unknown` is excluded) is the single highest-consequence line in the
 * campaign path: getting it backwards messages people who never agreed.
 */
export const decidePage = ({
  people,
  campaignId,
  templateCategory,
  spec,
  mapping,
  defaultCallingCode,
  accountDisplayName,
  blockedWaIds,
  seenPhones,
  now,
  stats,
}: {
  people: {
    id: string;
    whatsappOptInStatus?: string | null;
    phones?: unknown;
  }[];
  campaignId: string;
  templateCategory: TemplateCategory;
  spec: VariableSpec;
  mapping: VariableMapping;
  defaultCallingCode: string;
  accountDisplayName: string | null;
  blockedWaIds: ReadonlySet<string>;
  seenPhones: Set<string>;
  now: Date;
  stats: SnapshotStats;
}): PageOutcome => {
  const rows: RecipientCreateInput[] = [];
  let next = { ...stats, breakdown: { ...stats.breakdown } };

  for (const person of people) {
    const phones = personPhones(person as never);

    const resolution = resolveParameters({
      spec,
      mapping,
      subject: {
        person: person as never,
        account: {
          displayName: accountDisplayName,
          defaultCountryCallingCode: defaultCallingCode,
        },
        now,
        timeZone: config.timeZone(),
      },
    });

    const decision = evaluateExclusion({
      candidate: {
        personId: person.id,
        primaryPhone: phones.primary,
        additionalPhones: phones.additional,
        consent: (person.whatsappOptInStatus ?? CONSENT_STATUS.UNKNOWN) as ConsentStatus,
        threadIsBlocked:
          phones.primary !== null &&
          blockedWaIds.has(toWaId(toE164(phones.primary, defaultCallingCode) ?? '')),
        missingVariables: resolution.ok ? [] : resolution.missingKeys,
      },
      templateCategory,
      defaultCallingCode,
      seenPhones,
    });

    next = { ...next, scanned: next.scanned + 1 };

    if (decision.excluded) {
      next = {
        ...next,
        excluded: next.excluded + 1,
        breakdown: tallyExclusion(next.breakdown, decision.reason),
      };

      rows.push({
        campaignId,
        personId: person.id,
        status: RECIPIENT_STATUS.EXCLUDED,
        exclusionReason: decision.reason,
        resolvedPhone: decision.phone,
        resolvedParameters: null,
      });

      continue;
    }

    /**
     * Recorded before the row is written. Two people sharing a number in the
     * same page must not both be accepted, and the page's rows are written in
     * one batch — so the in-memory set is what makes "first occurrence in scan
     * order wins" true within a page, as the stored rows make it true across
     * them.
     */
    seenPhones.add(decision.phone);

    next = { ...next, accepted: next.accepted + 1 };

    rows.push({
      campaignId,
      personId: person.id,
      status: RECIPIENT_STATUS.PENDING,
      exclusionReason: null,
      resolvedPhone: decision.phone,
      resolvedParameters: resolution.parameters as unknown as Record<string, unknown>,
    });
  }

  return { rows, stats: next };
};

export const runSnapshot = async (
  payload: SnapshotPayload,
): Promise<SnapshotResult> => {
  const log = logger.child({ fn: 'wa-campaign-snapshot', correlationId: payload.campaignId });

  const campaign = await findCampaignById(payload.campaignId);

  if (campaign === null) {
    return { outcome: 'skipped', reason: 'campaign not found' };
  }

  /**
   * A cancelled campaign stops the walk immediately. Without this check a
   * cancel pressed during a seventeen-minute snapshot would keep writing rows
   * for another quarter of an hour into a campaign the admin has already
   * abandoned.
   */
  if (campaign.status !== CAMPAIGN_STATUS.SNAPSHOTTING) {
    log.info('wa.campaign.snapshot_abandoned', { status: campaign.status });

    return { outcome: 'skipped', reason: `status is ${campaign.status ?? 'unset'}` };
  }

  const page = payload.page ?? 1;
  const stats = asStats(payload.stats);

  const fail = async (reason: string): Promise<SnapshotResult> => {
    log.error('wa.campaign.snapshot_failed', { reason, page });

    await transitionCampaign({
      campaign,
      to: CAMPAIGN_STATUS.FAILED,
      reason: reason.slice(0, 500),
    });

    return { outcome: 'failed', reason };
  };

  if (page > MAX_PAGES) {
    return fail(`Audience exceeded ${MAX_PAGES} pages — refusing a partial snapshot`);
  }

  if (typeof campaign.accountId !== 'string' || typeof campaign.templateId !== 'string') {
    return fail('The campaign has no sending number or no template');
  }

  const [account, template] = await Promise.all([
    findAccountById(campaign.accountId),
    findTemplateById(campaign.templateId),
  ]);

  if (account === null) return fail('The campaign’s WhatsApp number no longer exists');
  if (template === null) return fail('The campaign’s template no longer exists');

  const parsedAudience = parseAudienceDefinition(campaign.audienceDefinition);

  if (!parsedAudience.ok) return fail(parsedAudience.error);

  const definition: AudienceDefinition = parsedAudience.definition;
  const cursor: AudienceCursor | null = parseCursor(payload.cursor);

  const defaultCallingCode = forAccount(
    account.defaultCountryCallingCode,
    config.defaultCountryCallingCode,
  );

  const templateCategory = (template.category ?? TEMPLATE_CATEGORY.UTILITY) as TemplateCategory;
  const spec = asJson<VariableSpec>(template.variableSpec, EMPTY_VARIABLE_SPEC);
  const mapping = asJson<VariableMapping>(campaign.variableMapping, {});

  let read;

  try {
    read = await readAudiencePage({ definition, cursor });
  } catch (error) {
    if (error instanceof AudienceError) {
      return fail([error.message, ...error.reasons].join(' · '));
    }

    throw error;
  }

  const now = new Date();

  /**
   * Two batched lookups per page, in place of two per person: which of these
   * numbers a human has blocked, and which this campaign has already accepted.
   * At 500 people a page that is the difference between four requests and a
   * thousand.
   */
  const canonical = new Map<string, string>();

  for (const person of read.people) {
    const phones = personPhones(person);
    const e164 = toE164(phones.primary, defaultCallingCode);

    if (e164 !== null) canonical.set(person.id, e164);
  }

  const [blockedWaIds, existingPhones] = await Promise.all([
    findBlockedWaIds(account.id, [...new Set([...canonical.values()].map(toWaId))]),
    findExistingPhones(campaign.id, [...new Set(canonical.values())]),
  ]);

  const decided = decidePage({
    people: read.people as never,
    campaignId: campaign.id,
    templateCategory,
    spec,
    mapping,
    defaultCallingCode,
    accountDisplayName: account.displayName ?? account.name ?? null,
    blockedWaIds,
    seenPhones: new Set(existingPhones),
    now,
    stats,
  });

  const written = await upsertRecipients(decided.rows);

  log.info('wa.campaign.snapshot_page', {
    page,
    scanned: decided.stats.scanned,
    accepted: decided.stats.accepted,
    excluded: decided.stats.excluded,
    created: written.created,
    updated: written.updated,
  });

  if (read.nextCursor !== null) {
    const landed = await enqueue({
      logicFunctionUniversalIdentifier: LF_CAMPAIGN_SNAPSHOT,
      payload: {
        campaignId: campaign.id,
        cursor: read.nextCursor,
        stats: decided.stats,
        page: page + 1,
      },
      delayMs: PAGE_DELAY_MS,
      correlationId: campaign.id,
    });

    /**
     * A snapshot that cannot schedule its own continuation must not report
     * itself ready: the campaign would launch to whatever fraction of the
     * audience happened to be written, which is the one outcome worse than
     * failing.
     */
    if (!landed) {
      return fail('Could not schedule the next audience page');
    }

    await transitionCampaign({
      campaign,
      to: CAMPAIGN_STATUS.SNAPSHOTTING,
      reason: `building: ${decided.stats.scanned} scanned`,
      patch: {
        recipientCount: decided.stats.accepted,
        excludedCount: decided.stats.excluded,
        exclusionBreakdown: { ...decided.stats.breakdown },
      },
    });

    return { outcome: 'continued', stats: decided.stats };
  }

  await transitionCampaign({
    campaign,
    to: CAMPAIGN_STATUS.READY,
    reason: null,
    patch: {
      recipientCount: decided.stats.accepted,
      excludedCount: decided.stats.excluded,
      exclusionBreakdown: { ...decided.stats.breakdown },
      estimatedCostUsd: estimateCampaignCostUsd({
        recipientCount: decided.stats.accepted,
        category: templateCategory,
        rates: config.rates(),
      }),
    },
  });

  log.info('wa.campaign.snapshot_complete', {
    pages: page,
    accepted: decided.stats.accepted,
    excluded: decided.stats.excluded,
  });

  return { outcome: 'completed', stats: decided.stats };
};

export const handler = async (payload: SnapshotPayload): Promise<SnapshotResult> => {
  try {
    return await runSnapshot(payload);
  } catch (error) {
    logger.error('wa.campaign.snapshot_error', {
      correlationId: payload.campaignId,
      ...describeError(error),
    });

    throw error;
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_CAMPAIGN_SNAPSHOT,
  name: 'wa-campaign-snapshot',
  description:
    'Materialises a campaign audience one page at a time, resolving parameters and recording exclusions.',
  timeoutSeconds: 120,
  handler,
});
