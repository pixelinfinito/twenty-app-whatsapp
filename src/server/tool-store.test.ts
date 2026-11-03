import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolScope } from './tool-scope';

const state = vi.hoisted(() => ({ entries: new Map<string, Record<string, unknown>>(), kv: new Map<string, unknown>(),
  failCompletion: false, timeoutAfterClaim: false }));
vi.mock('twenty-client-sdk/rest', () => ({
  RestApiClientError: class extends Error {},
  RestApiClient: class {
    async post(_path: string, body: Record<string, unknown>) {
      const key = String(body.requestKey);
      if (state.entries.has(key)) throw new Error('unique constraint');
      const entry = { id: key, ...body };
      state.entries.set(key, entry);
      if (state.timeoutAfterClaim) throw new Error('connection lost after commit');
      return { data: { createWhatsappToolRequest: entry } };
    }
    async get(_path: string, options: { query: { filter: string } }) {
      const key = options.query.filter.slice('requestKey[eq]:'.length);
      const entry = state.entries.get(key);
      return { data: { whatsappToolRequests: entry ? [entry] : [] } };
    }
    async patch(path: string, body: Record<string, unknown>) {
      if (state.failCompletion) throw new Error('completion write failed');
      const parts = path.split('/');
      const key = parts[parts.length - 1]!;
      Object.assign(state.entries.get(key)!, body);
    }
  },
}));
vi.mock('twenty-sdk/logic-function', () => ({ kv: {
  get: async (key: string) => state.kv.get(key) ?? null,
  set: async (key: string, value: unknown) => { state.kv.set(key, value); },
} }));

import { CONFIRMATION_TTL_MS, consumeConfirmation, digest, once, prepareConfirmation, stableJson } from './tool-store';
import { withToolScope } from './tool-scope';

const scope = (id = 'actor'): ToolScope => ({ principal: { version: 1, workspaceId: 'workspace', kind: 'apiKey', id,
  surface: 'MCP', workspaceMemberId: null, permissionFlagUniversalIdentifiers: [] } } as unknown as ToolScope);
const run = <T>(fn: () => Promise<T>, id?: string) => withToolScope(scope(id), fn);
beforeEach(() => { state.entries.clear(); state.kv.clear(); state.failCompletion = false; state.timeoutAfterClaim = false; });
afterEach(() => vi.useRealTimers());

describe('durable tool request ledger', () => {
  it('replays a completed request without executing again', async () => {
    const requestId = randomUUID(); const work = vi.fn(async () => ({ status: 'accepted', messageId: 'message' }));
    await run(() => once(requestId, 'send', { text: 'hello' }, work));
    expect(await run(() => once(requestId, 'send', { text: 'hello' }, work))).toMatchObject({ replayed: true, messageId: 'message' });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it.each(['input', 'operation', 'principal'])('rejects a reused requestId with changed %s', async (kind) => {
    const requestId = randomUUID(); const work = vi.fn(async () => ({ status: 'accepted' }));
    await run(() => once(requestId, 'send', { text: 'one' }, work));
    await expect(run(() => once(requestId, kind === 'operation' ? 'erase' : 'send', { text: kind === 'input' ? 'two' : 'one' }, work),
      kind === 'principal' ? 'different' : undefined)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('binds member-backed retries to the initiating agent', async () => {
    const requestId = randomUUID(); const work = vi.fn(async () => ({ status: 'accepted' }));
    const first = scope(); first.principal.agentId = 'first-agent';
    const second = scope(); second.principal.agentId = 'second-agent';
    await withToolScope(first, () => once(requestId, 'send', {}, work));
    await expect(withToolScope(second, () => once(requestId, 'send', {}, work)))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const { confirmationToken } = await withToolScope(first, () => prepareConfirmation('send', {}, {}));
    await expect(withToolScope(second, () => consumeConfirmation(confirmationToken, 'send', {}, {})))
      .rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
  });
  it('atomically admits only one of simultaneous requests', async () => {
    const requestId = randomUUID(); let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const work = vi.fn(async () => { await wait; return { status: 'accepted' }; });
    const first = run(() => once(requestId, 'send', {}, work));
    await Promise.resolve();
    await expect(run(() => once(requestId, 'send', {}, work))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    finish(); await first; expect(work).toHaveBeenCalledTimes(1);
  });
  it('does not repeat a provider call after an uncertain completion write', async () => {
    const requestId = randomUUID(); const work = vi.fn(async () => ({ status: 'accepted' }));
    state.failCompletion = true;
    await expect(run(() => once(requestId, 'submit', {}, work))).rejects.toThrow('completion');
    state.failCompletion = false;
    await expect(run(() => once(requestId, 'submit', {}, work))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('does not execute after a claim timeout that may have committed', async () => {
    state.timeoutAfterClaim = true; const work = vi.fn();
    await expect(run(() => once(randomUUID(), 'send', {}, work))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(work).not.toHaveBeenCalled();
  });
  it('requires a UUID v4', async () => {
    await expect(run(() => once('not-a-uuid', 'send', {}, vi.fn()))).rejects.toMatchObject({ code: 'INVALID_REQUEST_ID' });
  });
});

describe('preview confirmation', () => {
  const input = { campaignId: 'campaign', action: 'launch' }; const revision = { updatedAt: 'revision-1', count: 10 };
  it('binds confirmation to operation, input, actor and revision', async () => {
    const { confirmationToken } = await run(() => prepareConfirmation('campaigns', input, revision));
    await expect(run(() => consumeConfirmation(confirmationToken, 'accounts', input, revision))).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
    await expect(run(() => consumeConfirmation(confirmationToken, 'campaigns', { ...input, campaignId: 'other' }, revision))).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
    await expect(run(() => consumeConfirmation(confirmationToken, 'campaigns', input, revision), 'other')).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
    await expect(run(() => consumeConfirmation(confirmationToken, 'campaigns', input, { ...revision, count: 11 }))).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' });
    await run(() => consumeConfirmation(confirmationToken, 'campaigns', input, revision));
    await expect(run(() => consumeConfirmation(confirmationToken, 'campaigns', input, revision))).rejects.toMatchObject({ code: 'CONFIRMATION_USED' });
  });
  it('expires after ten minutes', async () => {
    vi.useFakeTimers(); const { confirmationToken } = await run(() => prepareConfirmation('campaigns', input, revision));
    vi.advanceTimersByTime(CONFIRMATION_TTL_MS);
    await expect(run(() => consumeConfirmation(confirmationToken, 'campaigns', input, revision))).rejects.toMatchObject({ code: 'CONFIRMATION_EXPIRED' });
  });
  it('requires an issued token', async () => {
    await expect(run(() => consumeConfirmation(undefined, 'campaigns', input, revision))).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });
});

it('canonicalizes nested keys while preserving array order', () => {
  expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 4 }, b: 2 }));
  expect(digest([1, 2])).not.toBe(digest([2, 1]));
});
