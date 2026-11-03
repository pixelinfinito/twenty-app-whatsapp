import { beforeEach, expect, it, vi } from 'vitest';
import type { ToolScope } from './tool-scope';
import { withToolScope } from './tool-scope';
const mocks = vi.hoisted(() => ({ read: vi.fn(), query: vi.fn() }));
vi.mock('./audience', () => ({ readAudiencePage: mocks.read }));
vi.mock('./clients', () => ({ coreClient: () => ({ query: mocks.query }) }));
import { assertToolCampaignAudience, captureToolAudience } from './tool-audience';
const scope = {} as ToolScope;
beforeEach(() => vi.clearAllMocks());

it('captures only caller-visible People, across every audience page', async () => {
  mocks.read.mockResolvedValueOnce({ people: [{ id: 'visible-1' }], nextCursor: { kind: 'relay', after: 'next' } })
    .mockResolvedValueOnce({ people: [{ id: 'visible-2' }], nextCursor: null });
  expect(await withToolScope(scope, () => captureToolAudience({ kind: 'view', viewId: 'view' }))).toEqual(['visible-1', 'visible-2']);
  expect(mocks.read.mock.calls[1]![0].cursor).toEqual({ kind: 'relay', after: 'next' });
});
it('does not change the existing human/workflow snapshot behavior', async () => {
  expect(await captureToolAudience({ kind: 'view', viewId: 'view' })).toBeUndefined();
  expect(mocks.read).not.toHaveBeenCalled();
});
it('refuses a partial authorization snapshot', async () => {
  mocks.read.mockResolvedValue({ people: [], nextCursor: { kind: 'relay', after: 'next' } });
  await expect(withToolScope(scope, () => captureToolAudience({ kind: 'view', viewId: 'view' }))).rejects.toMatchObject({ code: 'AUDIENCE_TOO_LARGE' });
});
it('refuses campaign launch when an accepted recipient points to an inaccessible Person', async () => {
  mocks.query.mockResolvedValue({ whatsappCampaignRecipients: { edges: [{ node: { personId: 'hidden', person: null } }], pageInfo: { hasNextPage: false } } });
  await expect(withToolScope(scope, () => assertToolCampaignAudience('campaign', 1))).rejects.toMatchObject({ code: 'AUDIENCE_NOT_ACCESSIBLE' });
});
it('refuses campaign launch when row permissions hide recipient records', async () => {
  mocks.query.mockResolvedValue({ whatsappCampaignRecipients: { edges: [], pageInfo: { hasNextPage: false } } });
  await expect(withToolScope(scope, () => assertToolCampaignAudience('campaign', 1))).rejects.toMatchObject({ code: 'AUDIENCE_NOT_ACCESSIBLE' });
});
it('allows a fully visible campaign audience', async () => {
  mocks.query.mockResolvedValue({ whatsappCampaignRecipients: { edges: [{ node: { personId: 'visible', person: { id: 'visible' } } }], pageInfo: { hasNextPage: false } } });
  await expect(withToolScope(scope, () => assertToolCampaignAudience('campaign', 1))).resolves.toBeUndefined();
});
