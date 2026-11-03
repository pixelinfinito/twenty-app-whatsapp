import type { CampaignStatus } from '../../domain/constants';
import { nodesOf, query, type JsonObject } from './base';

/**
 * `whatsappCampaign`.
 *
 * Grew from the narrow slice the sender needed — it touches campaigns only to
 * stop a run whose template is wrong for every recipient — into the full
 * record the runner, the control route and the rollup read. The field list is
 * shared so that a campaign loaded by one of them is the same shape as a
 * campaign loaded by another; a runner reading a subset and writing a patch
 * built from it is how a status ends up overwritten with a stale value.
 */

const CAMPAIGN_FIELDS = {
  id: true,
  name: true,
  status: true,
  statusReason: true,
  scheduledAt: true,
  startedAt: true,
  completedAt: true,
  audienceDefinition: true,
  variableMapping: true,
  headerMediaFile: { fileId: true, label: true, url: true },
  recipientCount: true,
  excludedCount: true,
  exclusionBreakdown: true,
  queuedCount: true,
  sentCount: true,
  deliveredCount: true,
  readCount: true,
  failedCount: true,
  skippedCount: true,
  respondedCount: true,
  estimatedCostUsd: true,
  actualCostUsd: true,
  maxFailureRatePct: true,
  pacingObserved: true,
  lastRunTickAt: true,
  archivedAt: true,
  testRecipientPhones: true,
  templateId: true,
  accountId: true,
  ownerId: true,
  createdAt: true,
} as const;

export type WhatsappCampaignRecord = {
  id: string;
  name?: string | null;
  status?: string | null;
  statusReason?: string | null;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  audienceDefinition?: JsonObject | null;
  variableMapping?: JsonObject | null;
  headerMediaFile?: { fileId: string; label: string; url?: string }[] | null;
  recipientCount?: number | null;
  excludedCount?: number | null;
  exclusionBreakdown?: JsonObject | null;
  queuedCount?: number | null;
  sentCount?: number | null;
  deliveredCount?: number | null;
  readCount?: number | null;
  failedCount?: number | null;
  skippedCount?: number | null;
  respondedCount?: number | null;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  maxFailureRatePct?: number | null;
  pacingObserved?: boolean | null;
  lastRunTickAt?: string | null;
  archivedAt?: string | null;
  testRecipientPhones?: string[] | null;
  templateId?: string | null;
  accountId?: string | null;
  ownerId?: string | null;
  createdAt?: string | null;
};

export const findCampaignById = async (
  id: string,
): Promise<WhatsappCampaignRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaigns: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: CAMPAIGN_FIELDS },
        },
      }),
    'campaigns.findById',
  );

  return nodesOf<WhatsappCampaignRecord>(result.whatsappCampaigns)[0] ?? null;
};

/**
 * Campaigns in any of the given states, oldest tick first.
 *
 * The ordering is what makes the runner fair: with a cap of three campaigns a
 * tick, sorting by `lastRunTickAt` ascending means a campaign that has waited
 * longest goes next, so four concurrent campaigns interleave instead of the
 * first three starving the fourth until they finish.
 */
export const listCampaignsByStatus = async (
  statuses: CampaignStatus[],
  limit = 20,
): Promise<WhatsappCampaignRecord[]> => {
  if (statuses.length === 0) return [];

  const result = await query(
    (client) =>
      client.query({
        whatsappCampaigns: {
          __args: {
            filter: { status: { in: statuses } },
            orderBy: [{ lastRunTickAt: 'AscNullsFirst' }],
            first: limit,
          },
          edges: { node: CAMPAIGN_FIELDS },
        },
      }),
    'campaigns.listByStatus',
  );

  return nodesOf<WhatsappCampaignRecord>(result.whatsappCampaigns);
};

/**
 * The campaigns page's list (FR-CAM-10) — every status, newest first.
 *
 * Ordered by `createdAt` rather than `startedAt`: a draft has never started, and
 * ordering on a column that is null for the campaign someone is in the middle of
 * building would file it last.
 *
 * **Archived campaigns are excluded here, in the query.** Filtering them out in
 * the browser would have been three lines instead of a parameter, and wrong for
 * the case archiving exists for: the page asks for the newest 50, so a workspace
 * that archived 50 old campaigns would receive 50 hidden rows and render an
 * empty list under "Ainda não há campanhas." — the archive would have hidden the
 * live campaigns instead of the past ones. `archived: true` asks for the other
 * side of the same line, which is what makes the archive reachable.
 */
export const listCampaigns = async (
  limit = 50,
  { archived = false }: { archived?: boolean } = {},
): Promise<WhatsappCampaignRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaigns: {
          __args: {
            filter: { archivedAt: { is: archived ? 'NOT_NULL' : 'NULL' } },
            /**
             * The archive is ordered by *when it was filed*, not by when the
             * campaign was created: "what did I put away recently" is the only
             * question anyone asks of an archive, and it is not the same order
             * as the live list's.
             */
            orderBy: archived
              ? [{ archivedAt: 'DescNullsLast' }]
              : [{ createdAt: 'DescNullsLast' }],
            first: limit,
          },
          edges: { node: CAMPAIGN_FIELDS },
        },
      }),
    archived ? 'campaigns.listArchived' : 'campaigns.list',
  );

  return nodesOf<WhatsappCampaignRecord>(result.whatsappCampaigns);
};

/** Campaigns due to start: `SCHEDULED` with a time that has passed. */
export const listDueCampaigns = async (
  now: Date,
  limit = 20,
): Promise<WhatsappCampaignRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappCampaigns: {
          __args: {
            filter: {
              status: { eq: 'SCHEDULED' },
              scheduledAt: { lte: now.toISOString() },
            },
            /**
             * Oldest first. Without an order the page is whatever the database
             * returns, so a workspace with more due campaigns than `limit`
             * could start the same recent ones every tick and leave a campaign
             * scheduled for this morning waiting indefinitely.
             */
            orderBy: [{ scheduledAt: 'AscNullsFirst' }],
            first: limit,
          },
          edges: { node: CAMPAIGN_FIELDS },
        },
      }),
    'campaigns.listDue',
  );

  return nodesOf<WhatsappCampaignRecord>(result.whatsappCampaigns);
};

export type CampaignPatch = {
  name?: string;
  status?: CampaignStatus;
  statusReason?: string | null;
  scheduledAt?: string | null;
  audienceDefinition?: Record<string, unknown> | null;
  variableMapping?: Record<string, unknown> | null;
  headerMediaFile?: { fileId: string; label: string }[];
  recipientCount?: number;
  excludedCount?: number;
  exclusionBreakdown?: Record<string, unknown> | null;
  queuedCount?: number;
  sentCount?: number;
  deliveredCount?: number;
  readCount?: number;
  failedCount?: number;
  skippedCount?: number;
  respondedCount?: number;
  estimatedCostUsd?: number | null;
  actualCostUsd?: number | null;
  maxFailureRatePct?: number;
  testRecipientPhones?: string[];
  /** A state Meta puts a large marketing batch into, not an error (FR-CAM-11). */
  pacingObserved?: boolean;
  lastRunTickAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Set to hide a finished campaign from the campaigns page; `null` unhides it. */
  archivedAt?: string | null;
  templateId?: string | null;
  accountId?: string | null;
  ownerId?: string | null;
};

export const patchCampaign = async (id: string, data: CampaignPatch): Promise<void> => {
  await query(
    (client) => client.mutation({ updateWhatsappCampaign: { __args: { id, data }, id: true } }),
    'campaigns.patch',
  );
};

/**
 * Soft-deletes a campaign.
 *
 * Soft, not hard: `destroy*` is confined to the erasure routine by an
 * architecture test, and a deleted campaign should still be recoverable from
 * the workspace's deleted records for as long as the platform keeps them —
 * "delete" here means "take it off the campaigns page", not "make it
 * unrecoverable".
 *
 * Only ever called for a campaign `canDeleteCampaign` cleared, which is a
 * campaign that has never sent anything. Nothing in this module enforces that;
 * the route does, once, before it calls this.
 */
export const deleteCampaign = async (id: string): Promise<void> => {
  await query(
    (client) => client.mutation({ deleteWhatsappCampaign: { __args: { id }, id: true } }),
    'campaigns.delete',
  );
};

export const createCampaign = async (
  data: CampaignPatch & { name: string },
): Promise<WhatsappCampaignRecord> => {
  const result = await query(
    (client) =>
      client.mutation({
        createWhatsappCampaign: { __args: { data }, ...CAMPAIGN_FIELDS },
      }),
    'campaigns.create',
  );

  return result.createWhatsappCampaign as WhatsappCampaignRecord;
};
