import { CoreApiClient } from 'twenty-client-sdk/core';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { expect, it } from 'vitest';

const core = new CoreApiClient();
const routes = new RestApiClient();

it('retains an unfinished draft, persists audience removal, and refuses to build it', async () => {
  let accountId: string | null = null;
  let templateId: string | null = null;
  let campaignId: string | null = null;
  try {
    const account = await core.mutation({ createWhatsappAccount: {
      __args: { data: { name: 'Draft integration test', status: 'CONNECTED', isTestAccount: true } }, id: true,
    } });
    accountId = account.createWhatsappAccount!.id;
    const template = await core.mutation({ createWhatsappTemplate: {
      __args: { data: {
        name: 'draft_integration', accountId, language: 'en', category: 'UTILITY',
        status: 'APPROVED', publishedToCrm: true, isUsableInCrm: true,
      } }, id: true,
    } });
    templateId = template.createWhatsappTemplate!.id;
    const created = await routes.post<{ campaign: { id: string } }>('/s/whatsapp/campaign', {
      action: 'create', name: 'Unfinished draft', accountId, templateId,
      audienceDefinition: null, scheduledAt: null,
    });
    campaignId = created.campaign.id;
    const people = await core.query({ people: { __args: { first: 1 }, edges: { node: { id: true } } } });
    const personId = people.people!.edges[0]!.node.id;
    await routes.post('/s/whatsapp/campaign', {
      action: 'update', campaignId, audienceDefinition: { kind: 'manual', personIds: [personId] },
      scheduledAt: '2027-01-01T12:30:00Z',
    });
    await routes.post('/s/whatsapp/campaign', {
      action: 'update', campaignId, audienceDefinition: null, scheduledAt: null,
    });
    const reread = await core.query({ whatsappCampaigns: {
      __args: { first: 1, filter: { id: { eq: campaignId } } },
      edges: { node: { status: true, audienceDefinition: true, scheduledAt: true } },
    } });
    expect(reread.whatsappCampaigns!.edges[0]!.node).toMatchObject({
      status: 'DRAFT', audienceDefinition: null, scheduledAt: null,
    });
    await expect(routes.post('/s/whatsapp/campaign', { action: 'build', campaignId })).rejects.toMatchObject({ status: 400 });
  } finally {
    if (campaignId) await core.mutation({ destroyWhatsappCampaign: { __args: { id: campaignId }, id: true } });
    if (templateId) await core.mutation({ destroyWhatsappTemplate: { __args: { id: templateId }, id: true } });
    if (accountId) await core.mutation({ destroyWhatsappAccount: { __args: { id: accountId }, id: true } });
  }
});
