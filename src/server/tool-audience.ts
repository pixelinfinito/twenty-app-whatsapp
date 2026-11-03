import { parseAudienceDefinition, type AudienceCursor } from '../domain/campaign/audience';
import { readAudiencePage } from './audience';
import { ToolError } from './tool-errors';
import { toolScope } from './tool-scope';
import { coreClient } from './clients';

export const assertToolCampaignAudience = async (campaignId: string, expectedCount: number) => {
  if (!toolScope()) return;
  let after: string | undefined;
  let visible = 0;
  for (let page = 0; page < 400; page += 1) {
    const result = await coreClient().query({
      whatsappCampaignRecipients: {
        __args: { filter: { campaignId: { eq: campaignId }, status: { neq: 'EXCLUDED' } }, first: 500, ...(after ? { after } : {}) },
        edges: { node: { personId: true, person: { id: true } } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    });
    const rows = result.whatsappCampaignRecipients?.edges ?? [];
    for (const row of rows) {
      if (!row.node.personId || row.node.person?.id !== row.node.personId) throw new ToolError('AUDIENCE_NOT_ACCESSIBLE');
      visible += 1;
    }
    if (!result.whatsappCampaignRecipients?.pageInfo.hasNextPage) {
      if (visible !== expectedCount) throw new ToolError('AUDIENCE_NOT_ACCESSIBLE');
      return;
    }
    after = result.whatsappCampaignRecipients.pageInfo.endCursor;
  }
  throw new ToolError('AUDIENCE_TOO_LARGE');
};

/** Freeze the caller-visible audience before a privileged background worker runs. */
export const captureToolAudience = async (raw: unknown): Promise<string[] | undefined> => {
  if (!toolScope()) return undefined;
  const parsed = parseAudienceDefinition(raw);
  if (!parsed.ok) throw new ToolError('INVALID_AUDIENCE', parsed.error);
  const ids = new Set<string>();
  let cursor: AudienceCursor | null = null;
  for (let page = 0; page < 400; page += 1) {
    const result = await readAudiencePage({ definition: parsed.definition, cursor });
    result.people.forEach((person) => ids.add(person.id));
    if (!result.nextCursor) return [...ids];
    cursor = result.nextCursor;
  }
  throw new ToolError('AUDIENCE_TOO_LARGE', 'Refusing a partial authorization snapshot.');
};
