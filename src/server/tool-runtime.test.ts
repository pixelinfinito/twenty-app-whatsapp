import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_WHATSAPP_ADMIN, PERMISSION_WHATSAPP_OPERATOR } from '../constants/tool-identifiers';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from './tool-runtime';
import { toolScope } from './tool-scope';
import { requireCaller } from './auth';
import { coreClient } from './clients';

const state = vi.hoisted(() => ({ queries: vi.fn(), mutations: vi.fn(), options: [] as unknown[] }));
vi.mock('twenty-client-sdk/core', () => ({ CoreApiClient: class {
  constructor(options: unknown) { state.options.push(options); }
  query = state.queries;
  mutation = state.mutations;
} }));

const schema = { type: 'object' as const, additionalProperties: false, properties: {} };
it('publishes operator-or-admin requirements for discovery', () => {
  expect(toolTrigger(schema)).toMatchObject({
    requiredAnyPermissionFlagUniversalIdentifiers: [PERMISSION_WHATSAPP_OPERATOR, PERMISSION_WHATSAPP_ADMIN],
  });
  expect(toolTrigger(schema, true)).toMatchObject({ requiredPermissionFlagUniversalIdentifiers: [PERMISSION_WHATSAPP_ADMIN] });
});
const context = (kind: 'member' | 'apiKey' | 'agent' = 'member', flags = [PERMISSION_WHATSAPP_OPERATOR]): WhatsappToolContext => ({
  workspaceId: 'workspace', userWorkspaceId: kind === 'member' ? 'user-workspace' : null,
  workspaceMemberId: kind === 'member' ? 'member' : null, retryCount: 0, maxRetries: 0,
  toolCaller: { version: 1, workspaceId: 'workspace', kind, id: kind, workspaceMemberId: kind === 'member' ? 'member' : null,
    permissionFlagUniversalIdentifiers: flags, surface: kind === 'agent' ? 'AI_TOOL' : 'MCP' },
});
beforeEach(() => { vi.stubEnv('TWENTY_TOOL_CALLER_ACCESS_TOKEN', 'scoped-test-token'); state.options.length = 0; });
afterEach(() => vi.unstubAllEnvs());

describe('trusted AI tool authorization', () => {
  it.each(['member', 'apiKey', 'agent'] as const)('supports authenticated %s principals', async (kind) => {
    const run = vi.fn(async () => {
      const caller = await requireCaller({ userWorkspaceId: 'forged' });
      expect(caller).toMatchObject({ isAgent: true, isAdmin: false, isMachine: kind !== 'member' });
      return { status: 'ready' };
    });
    expect(await authenticatedTool(schema, {}, context(kind), run)).toEqual({ status: 'ready' });
    expect(run).toHaveBeenCalledTimes(1); expect(toolScope()).toBeUndefined();
  });
  it('supports member-backed agents with the effective member identity', async () => {
    const ctx = context('member'); ctx.toolCaller!.surface = 'AI_TOOL';
    await authenticatedTool(schema, {}, ctx, async () => {
      expect(toolScope()!.caller.workspaceMemberId).toBe('member'); return {};
    });
  });
  it('lets admin imply operator', async () => {
    await authenticatedTool(schema, {}, context('apiKey', [PERMISSION_WHATSAPP_ADMIN]), async () => {
      expect(toolScope()!.caller).toMatchObject({ isAdmin: true, isAgent: true }); return {};
    });
  });
  it.each(['missing-context', 'missing-caller', 'missing-token', 'different-workspace', 'different-member', 'no-flags', 'spoofed-input'])('denies %s before any operation', async (scenario) => {
    let ctx: WhatsappToolContext | undefined = context('apiKey'); let input: unknown = {};
    if (scenario === 'missing-context') ctx = undefined;
    if (scenario === 'missing-caller') delete ctx!.toolCaller;
    if (scenario === 'missing-token') vi.stubEnv('TWENTY_TOOL_CALLER_ACCESS_TOKEN', '');
    if (scenario === 'different-workspace') ctx!.toolCaller!.workspaceId = 'other';
    if (scenario === 'different-member') { ctx = context('member'); ctx.toolCaller!.workspaceMemberId = 'other-member'; }
    if (scenario === 'no-flags') ctx!.toolCaller!.permissionFlagUniversalIdentifiers = [];
    if (scenario === 'spoofed-input') input = { toolCaller: context().toolCaller };
    vi.stubEnv('WA_ALLOW_API_KEY_ADMIN', 'true');
    const run = vi.fn();
    expect(await authenticatedTool(schema, input, ctx, run)).toMatchObject({ status: 'denied' });
    expect(run).not.toHaveBeenCalled();
  });
  it('binds read clients to the delegated credential without forwarding argument credentials', async () => {
    await authenticatedTool(schema, {}, context(), async () => {
      await coreClient().query({});
      expect(state.options).toContainEqual({ headers: { Authorization: 'Bearer scoped-test-token' } }); return {};
    });
  });
  it('isolates simultaneous invocation contexts', async () => {
    const seen: string[] = [];
    await Promise.all(['member', 'apiKey'].map((kind) => authenticatedTool(schema, {}, context(kind as 'member' | 'apiKey'), async () => {
      await Promise.resolve(); seen.push(toolScope()!.principal.id); return {};
    })));
    expect(seen.sort()).toEqual(['apiKey', 'member']); expect(toolScope()).toBeUndefined();
  });
});
