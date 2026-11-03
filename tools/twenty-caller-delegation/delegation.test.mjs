import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the actual new platform service from the distributable patch. Only
// framework dependencies are stubbed, so this check needs no Twenty checkout.
const patch = readFileSync(new URL('./twenty-caller-delegation-v1.patch', import.meta.url), 'utf8');
const path = 'packages/twenty-server/src/engine/core-modules/tool-provider/services/logic-function-tool-delegation.service.ts';
const section = patch.split(`diff --git a/${path} b/${path}\n`)[1]?.split('\ndiff --git ')[0];
assert.ok(section, 'platform service must be present in the patch');
const source = section.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020, experimentalDecorators: true }, reportDiagnostics: true });
assert.equal(compiled.diagnostics?.length ?? 0, 0);
const exports = {};
const require = (name) => {
  if (name === '@nestjs/common') return { Injectable: () => (value) => value };
  if (name.endsWith('jwt-token-type.enum')) return { JwtTokenTypeEnum: { API_KEY: 'API_KEY' } };
  if (name.endsWith('get-role-ids-to-intersect.util')) return { getRoleIdsToIntersect: (roles) =>
    Object.values(roles).includes(null) ? null : [...new Set(Object.values(roles).filter((value) => value !== undefined))] };
  if (name.endsWith('find-flat-entity-by-id-in-flat-entity-maps.util')) return {
    findFlatEntityByIdInFlatEntityMaps: ({ flatEntityId, flatEntityMaps }) => flatEntityMaps.byUniversalIdentifier[flatEntityMaps.universalIdentifierById[flatEntityId]],
  };
  throw new Error(`Unexpected runtime dependency: ${name}`);
};
new Function('require', 'exports', compiled.outputText)(require, exports);
const Service = exports.LogicFunctionToolDelegationService;

const maps = () => ({
  flatAgentMaps: { universalIdentifierById: { agent: 'agent' }, byUniversalIdentifier: { agent: { id: 'agent', applicationId: 'origin-app', deletedAt: null } } },
  flatRoleMaps: { universalIdentifierById: { rep: 'rep', admin: 'admin', root: 'root' }, byUniversalIdentifier: {
    rep: { rolePermissionFlagIds: ['operator'] }, admin: { rolePermissionFlagIds: ['operator', 'admin'] }, root: { canAccessAllTools: true, rolePermissionFlagIds: [] },
  } },
  flatRolePermissionFlagMaps: { universalIdentifierById: { operator: 'operator', admin: 'admin' }, byUniversalIdentifier: {
    operator: { permissionFlagUniversalIdentifier: 'operator' }, admin: { permissionFlagUniversalIdentifier: 'admin' },
  } },
  flatPermissionFlagMaps: { byUniversalIdentifier: { operator: { universalIdentifier: 'operator', permissionType: 'tool' },
    admin: { universalIdentifier: 'admin', permissionType: 'tool' } } },
});
const context = (kind) => ({ workspaceId: 'workspace',
  rolePermissionConfig: { intersectionOf: { [kind === 'member' ? 'userWorkspaceRoleId' : kind === 'apiKey' ? 'apiKeyRoleId' : 'agentRoleId']: 'rep' } },
  ...(kind === 'member' ? { userId: 'user', userWorkspaceId: 'membership', authContext: { type: 'user', workspaceMemberId: 'member' } } :
    kind === 'apiKey' ? { authContext: { type: 'apiKey', apiKey: { id: 'key' } } } : { agentId: 'agent', application: { id: 'origin-app' } }),
});
const fixture = () => {
  const calls = [];
  const service = new Service({ getOrRecompute: async () => maps() },
    { generateApplicationAccessToken: async (input) => { calls.push(input); return { token: 'app-token' }; } },
    { signAsyncOrThrow: async (payload, options) => { calls.push({ payload, options }); return 'key-token'; } });
  return { service, calls };
};

test('effective grants intersect API-key, member, app and agent roles', async () => {
  const { service } = fixture();
  const ctx = context('apiKey');
  ctx.rolePermissionConfig.intersectionOf.applicationRoleId = 'admin';
  assert.deepEqual(await service.permissionFlags(ctx), ['operator']);
  assert.equal(await service.allowed({ callerDelegationVersion: 1, requiredPermissionFlagUniversalIdentifiers: ['admin'] }, ctx), false);
  assert.equal(await service.allowed({ callerDelegationVersion: 1, requiredPermissionFlagUniversalIdentifiers: ['operator'] }, ctx), true);
});
for (const kind of ['member', 'apiKey', 'agent']) test(`delegates ${kind} without substituting the app's authority`, async () => {
  const { service, calls } = fixture();
  const result = await service.delegate(context(kind), 'target-app');
  assert.equal(result.caller.kind, kind); assert.deepEqual(result.caller.permissionFlagUniversalIdentifiers, ['operator']);
  if (kind === 'apiKey') assert.deepEqual(calls[0], { payload: { type: 'API_KEY', sub: 'workspace', workspaceId: 'workspace', jti: 'key' }, options: { expiresIn: '5m' } });
  if (kind === 'agent') assert.deepEqual(calls[0], { workspaceId: 'workspace', applicationId: 'origin-app', agentId: 'agent', toolCallerDelegation: true, expiresIn: '5m' });
  if (kind === 'member') { assert.equal(result.caller.workspaceMemberId, 'member'); assert.equal(calls[0].userId, 'user'); }
});
test('missing/revoked roles, absent principals and system bypasses never become admin', async () => {
  const { service } = fixture(); const ctx = context('apiKey');
  ctx.rolePermissionConfig = { intersectionOf: { apiKeyRoleId: null } };
  assert.deepEqual(await service.permissionFlags(ctx), []);
  ctx.rolePermissionConfig = { shouldBypassPermissionChecks: true };
  assert.deepEqual(await service.permissionFlags(ctx), []);
  await assert.rejects(() => service.delegate({ ...context('apiKey'), authContext: undefined }, 'target'));
});
test('member-backed agents keep member permissions and attribution', async () => {
  const { service, calls } = fixture();
  const result = await service.delegate({ ...context('member'), agentId: 'agent' }, 'target-app');
  assert.equal(result.caller.kind, 'member'); assert.equal(result.caller.surface, 'AI_TOOL');
  assert.equal(calls[0].agentId, 'agent');
  assert.equal(calls[0].toolCallerDelegation, true);
  assert.equal(result.caller.agentId, 'agent');
});
test('existing tools without delegation settings keep their discovery behavior', async () => {
  assert.equal(await fixture().service.allowed({}, {}), true);
});

test('admin-only grants satisfy operator-or-admin discovery requirements', async () => {
  const data = maps(); data.flatRoleMaps.byUniversalIdentifier.admin.rolePermissionFlagIds = ['admin'];
  const service = new Service({ getOrRecompute: async () => data }, {}, {});
  const ctx = context('apiKey'); ctx.rolePermissionConfig.intersectionOf.apiKeyRoleId = 'admin';
  assert.equal(await service.allowed({ callerDelegationVersion: 1,
    requiredAnyPermissionFlagUniversalIdentifiers: ['operator', 'admin'] }, ctx), true);
  assert.equal(await service.allowed({ callerDelegationVersion: 1,
    requiredPermissionFlagUniversalIdentifiers: ['operator'] }, ctx), false);
});
