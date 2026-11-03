import { afterEach, expect, it, vi } from 'vitest';
import { downloadWorkspaceFile } from './files';
import { withToolScope, type ToolScope } from './tool-scope';

afterEach(() => vi.unstubAllEnvs());
const token = (workspaceId: string) => `header.${Buffer.from(JSON.stringify({ workspaceId })).toString('base64url')}.signature`;
const scope = { principal: { workspaceId: 'this-workspace' }, accessToken: 'caller-token' } as ToolScope;

it('rejects a signed file URL from another workspace before downloading', async () => {
  vi.stubEnv('TWENTY_API_URL', 'https://crm.example.test');
  const fetchImpl = vi.fn();
  await expect(withToolScope(scope, () => downloadWorkspaceFile({
    url: `/file/files-field/33e0a280-8586-4fc4-ae76-ddcd56d420ce?token=${token('another-workspace')}`,
  }, { fetchImpl }))).rejects.toThrow('another workspace');
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('uses the delegated bearer when reading a same-workspace capability', async () => {
  vi.stubEnv('TWENTY_API_URL', 'https://crm.example.test');
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('hello', { headers: { 'content-type': 'text/plain' } }));
  await withToolScope(scope, () => downloadWorkspaceFile({
    url: `/file/files-field/33e0a280-8586-4fc4-ae76-ddcd56d420ce?token=${token('this-workspace')}`,
  }, { fetchImpl }));
  expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'Bearer caller-token' } });
});
