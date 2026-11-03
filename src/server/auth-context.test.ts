import { beforeEach, expect, it, vi } from 'vitest';
import { ROLE_AGENT } from '../constants/universal-identifiers';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./clients', () => ({ metadataClient: () => ({ query: mocks.query }) }));
vi.mock('twenty-sdk/logic-function', async (original) => ({
  ...(await original<typeof import('twenty-sdk/logic-function')>()),
  kv: { get: async () => null, set: async () => {} },
}));
import { ForbiddenError, UnauthorizedError, requireCaller, requireRole } from './auth';
beforeEach(() => {
  delete process.env.WA_ALLOW_API_KEY_ADMIN;
  mocks.query.mockResolvedValue({
    getRoles: [
      {
        universalIdentifier: ROLE_AGENT,
        canUpdateAllSettings: false,
        workspaceMembers: [{ id: 'member', userWorkspaceId: null }],
      },
    ],
  });
});
it('binds permissions to platform context instead of a request identity', async () => {
  const caller = await requireCaller(
    { userWorkspaceId: 'forged' },
    { userWorkspaceId: 'workspace-user', workspaceMemberId: 'member' },
  );
  expect(caller).toMatchObject({
    userWorkspaceId: 'workspace-user',
    workspaceMemberId: 'member',
    isAgent: true,
    isAdmin: false,
  });
  expect(() => requireRole(caller, 'admin')).toThrow(ForbiddenError);
});
it('does not promote a machine caller using an event membership', async () => {
  await expect(
    requireCaller(
      { userWorkspaceId: 'forged' },
      { userWorkspaceId: null, workspaceMemberId: null },
    ),
  ).rejects.toThrow(ForbiddenError);
});
it('refuses invocations without a trusted execution context', async () => {
  process.env.WA_ALLOW_API_KEY_ADMIN = 'true';
  await expect(requireCaller({ userWorkspaceId: 'forged' })).rejects.toThrow(UnauthorizedError);
});
