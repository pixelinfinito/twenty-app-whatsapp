import { beforeEach, expect, it, vi } from 'vitest';
import { handler } from './wa-campaign-control';

const state = vi.hoisted(() => ({
  admin: true,
  create: vi.fn(), patch: vi.fn(), find: vi.fn(),
}));
vi.mock('../server/auth', async (original) => ({
  ...await original<typeof import('../server/auth')>(),
  requireCaller: async () => ({ isAdmin: state.admin, isAgent: true, workspaceMemberId: 'member' }),
}));
vi.mock('../server/repositories/campaigns', async (original) => ({
  ...await original<typeof import('../server/repositories/campaigns')>(),
  createCampaign: state.create, patchCampaign: state.patch, findCampaignById: state.find,
}));
vi.mock('../server/repositories/accounts', () => ({ findAccountById: async () => null }));
vi.mock('../server/repositories/templates', () => ({
  findTemplateById: async () => ({ id: 'template', status: 'APPROVED', category: 'UTILITY', publishedToCrm: true, isUsableInCrm: true }),
}));
vi.mock('../server/audit', async (original) => ({ ...await original<typeof import('../server/audit')>(), audit: vi.fn() }));
const call = (body: Record<string, unknown>) => handler({ body } as never);

beforeEach(() => {
  vi.clearAllMocks(); state.admin = true;
  state.create.mockResolvedValue({ id: 'draft', status: 'DRAFT' });
  state.patch.mockResolvedValue(undefined);
  state.find.mockResolvedValue({ id: 'draft', status: 'DRAFT', templateId: 'template', audienceDefinition: null });
});
it('saves an unfinished draft with an explicitly empty audience', async () => {
  const response = await call({ action: 'create', name: 'Draft', accountId: 'account', templateId: 'template', audienceDefinition: null });
  expect(response.status).toBe(201);
  expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Draft', status: 'DRAFT' }));
});
it('clears a draft audience explicitly without retaining the previous selection', async () => {
  const response = await call({ action: 'update', campaignId: 'draft', audienceDefinition: null });
  expect(response.status).toBe(200);
  expect(state.patch).toHaveBeenCalledWith('draft', expect.objectContaining({ audienceDefinition: null }));
});
it('still refuses to build a draft until an audience is supplied', async () => {
  const response = await call({ action: 'build', campaignId: 'draft' });
  expect(response.status).toBe(400);
  expect(state.patch).not.toHaveBeenCalled();
});
it('still refuses malformed audiences rather than treating them as blank drafts', async () => {
  const response = await call({ action: 'update', campaignId: 'draft', audienceDefinition: { kind: 'anything' } });
  expect(response.status).toBe(400);
  expect(state.patch).not.toHaveBeenCalled();
});
it('does not grant agents draft-write authority', async () => {
  state.admin = false;
  expect((await call({ action: 'update', campaignId: 'draft', audienceDefinition: null })).status).toBe(403);
  expect(state.patch).not.toHaveBeenCalled();
});
