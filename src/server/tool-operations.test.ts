import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolScope } from './tool-scope';
import { withToolScope } from './tool-scope';

const mocks = vi.hoisted(() => ({
  send: vi.fn(), thread: vi.fn(), campaign: vi.fn(), consent: vi.fn(), accounts: vi.fn(), templates: vi.fn(), webhooks: vi.fn(),
  get: vi.fn(), prepare: vi.fn(), consume: vi.fn(), once: vi.fn(), findAccount: vi.fn(), listAccounts: vi.fn(), findPerson: vi.fn(),
  matchPerson: vi.fn(), findThread: vi.fn(), assertAudience: vi.fn(), listThreads: vi.fn(),
}));
vi.mock('twenty-client-sdk/rest', () => ({ RestApiClient: class { get = mocks.get; } }));
vi.mock('./operation-send-message-route', () => ({ handler: mocks.send }));
vi.mock('./operation-thread-actions-route', () => ({ handler: mocks.thread }));
vi.mock('./operation-campaign-control', () => ({ handler: mocks.campaign }));
vi.mock('./operation-consent-route', () => ({ handler: mocks.consent }));
vi.mock('./operation-account-admin-route', () => ({ handler: mocks.accounts }));
vi.mock('./operation-template-submit', () => ({ handler: mocks.templates }));
vi.mock('./operation-webhook-replay-route', () => ({ handler: mocks.webhooks, eventsForThread: vi.fn() }));
vi.mock('./operation-inbox-feed-route', () => ({ handler: vi.fn(), inboxSpecFor: () => ({ kind: 'all' }) }));
vi.mock('./tool-store', () => ({
  once: mocks.once, consumeConfirmation: mocks.consume, prepareConfirmation: mocks.prepare,
  uuidV4: (id: unknown) => typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id),
}));
vi.mock('./repositories/accounts', () => ({ findAccountById: mocks.findAccount, listAccounts: mocks.listAccounts }));
vi.mock('./repositories/people', () => ({ findPersonById: mocks.findPerson }));
vi.mock('./repositories/threads', () => ({ findThread: mocks.findThread, listToolThreads: mocks.listThreads }));
vi.mock('./matching', () => ({ matchPerson: mocks.matchPerson }));
vi.mock('./tool-audience', () => ({ assertToolCampaignAudience: mocks.assertAudience }));
import { executeWhatsappTool } from './tool-operations';

const id = '33e0a280-8586-4fc4-ae76-ddcd56d420ce';
const otherId = 'ec6c5663-0f92-4dca-8e11-a8dc8e2da690';
const scope = (admin = true) => ({ principal: { kind: 'apiKey', id: 'key', surface: 'MCP' },
  caller: { isAgent: true, isAdmin: admin, workspaceMemberId: null }, accessToken: 'caller-token' }) as unknown as ToolScope;
const run = (name: Parameters<typeof executeWhatsappTool>[0], input: Record<string, unknown>, admin = true) =>
  withToolScope(scope(admin), () => executeWhatsappTool(name, input));

beforeEach(() => {
  vi.clearAllMocks();
  for (const handler of [mocks.thread, mocks.campaign, mocks.consent, mocks.accounts, mocks.templates, mocks.webhooks]) {
    handler.mockImplementation(async (event) => ({ status: 200, body: { action: event.body.action } }));
  }
  mocks.send.mockResolvedValue({ status: 202, body: { message: { id: 'message', body: 'private content' }, threadId: id } });
  mocks.get.mockImplementation(async (path: string, options: { query: { filter?: string } }) => {
    const object = path.split('/')[2]!;
    const exactId = options.query.filter?.startsWith('id[eq]:') ? options.query.filter.slice(7) : id;
    return { data: { [object]: [{ id: exactId, updatedAt: 'revision-1', recipientCount: 0 }] }, pageInfo: { hasNextPage: false } };
  });
  mocks.prepare.mockResolvedValue({ confirmationToken: 'preview-token', expiresAt: 'later' });
  mocks.once.mockImplementation(async (_id, _operation, _input, work) => work());
  mocks.findAccount.mockResolvedValue({ id, status: 'CONNECTED', defaultCountryCallingCode: '244' });
  mocks.listAccounts.mockResolvedValue([{ id, status: 'CONNECTED' }]);
  mocks.findPerson.mockResolvedValue({ id, phones: { primaryPhoneCallingCode: '+244', primaryPhoneNumber: '923000000' } });
  mocks.findThread.mockResolvedValue(null);
  mocks.matchPerson.mockResolvedValue({ kind: 'unmatched' });
});

describe('agent operation dispatch', () => {
  it.each(['text', 'template', 'media', 'interactive', 'reaction', 'location', 'contacts'])('queues %s through the shared send operation', async (kind) => {
    const message = { kind, body: 'hello', contextWamid: 'quoted', fileId: otherId, filePath: 'files/media' };
    const requestId = randomUUID();
    const result = await run('whatsapp-send-message', { threadId: id, requestId, message }, false);
    expect(mocks.send.mock.calls[0]![0].body).toMatchObject({ threadId: id, message, clientToken: requestId });
    expect(result).toMatchObject({ status: 'accepted', delivery: 'queued', messageId: 'message' });
    expect(JSON.stringify(result)).not.toContain('private content');
  });
  it('starts a raw E.164 recipient only with a selected account', async () => {
    await run('whatsapp-send-message', { phone: '+244923000000', accountId: id, requestId: randomUUID(), message: { kind: 'text', body: 'hello' } });
    expect(mocks.send.mock.calls[0]![0].body).toMatchObject({ waId: '244923000000', accountId: id });
    await expect(run('whatsapp-send-message', { phone: '+244923000000', requestId: randomUUID() })).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' });
  });
  it('accepts a newly completed native upload by fileId alone', async () => {
    await run('whatsapp-send-message', { threadId: id, requestId: randomUUID(), message: { kind: 'media', mediaKind: 'image', fileId: otherId } });
    expect(mocks.send.mock.calls[0]![0].body.message).toMatchObject({ fileId: otherId, filePath: `file/files-field/${otherId}` });
  });
  it('resolves a Person without defaulting between multiple accounts', async () => {
    mocks.listAccounts.mockResolvedValue([{ id, status: 'CONNECTED' }, { id: otherId, status: 'CONNECTED' }]);
    await expect(run('whatsapp-send-message', { personId: id, requestId: randomUUID() })).rejects.toMatchObject({ code: 'ACCOUNT_AMBIGUOUS' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('rejects mixed recipient selectors', async () => {
    await expect(run('whatsapp-send-message', { threadId: id, personId: id, requestId: randomUUID() })).rejects.toMatchObject({ code: 'RECIPIENT_AMBIGUOUS' });
  });
  it('does not treat an inaccessible existing phone identity as an unknown contact', async () => {
    mocks.matchPerson.mockResolvedValue({ kind: 'matched', person: { id: otherId } });
    mocks.get.mockImplementation(async (_path, options) => ({ data: { whatsappAccounts: [{ id }], people: options.query.filter.includes(otherId) ? [] : [{ id }] } }));
    await expect(run('whatsapp-send-message', { phone: '+244923000000', accountId: id, requestId: randomUUID() })).rejects.toMatchObject({ code: 'RECORD_UNAVAILABLE' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('keeps backend consent/window/policy denials machine-readable', async () => {
    mocks.send.mockResolvedValue({ status: 409, body: { code: 'WINDOW_CLOSED', warnings: [] } });
    expect(await run('whatsapp-send-message', { threadId: id, requestId: randomUUID() })).toMatchObject({ status: 'denied', code: 'WINDOW_CLOSED' });
  });
  it('rejects unauthorized roles before performing an admin operation', async () => {
    await expect(run('whatsapp-accounts', { action: 'connect', requestId: randomUUID() }, false)).rejects.toThrow();
    expect(mocks.accounts).not.toHaveBeenCalled(); expect(mocks.once).not.toHaveBeenCalled();
  });
  it('forwards operator thread actions through the existing service', async () => {
    await run('whatsapp-thread-action', { action: 'assign', threadId: id, assigneeId: null, requestId: randomUUID() }, false);
    expect(mocks.thread.mock.calls[0]![0].body).toMatchObject({ action: 'assign', assigneeId: null });
  });
  it('forwards admin template submission and sync through the existing services', async () => {
    await run('whatsapp-templates', { action: 'submit', accountId: id, requestId: randomUUID(), components: [] });
    expect(mocks.templates).toHaveBeenCalledTimes(1);
    await run('whatsapp-templates', { action: 'sync', accountId: id, requestId: randomUUID() });
    expect(mocks.accounts.mock.calls[0]![0].body).toMatchObject({ action: 'syncTemplates', accountId: id });
  });
  it('uses caller-scoped, bounded pagination for template reads', async () => {
    await run('whatsapp-templates', { action: 'list', accountId: id, first: 7, after: 'cursor' }, false);
    expect(mocks.get).toHaveBeenLastCalledWith('/rest/whatsappTemplates', { query: { limit: 7, starting_after: 'cursor', filter: `accountId[eq]:${id}` } });
    expect(mocks.templates).not.toHaveBeenCalled();
  });
});

describe('bulk/destructive previews', () => {
  it.each(['launch', 'resume', 'cancel', 'delete'])('previews campaign %s without running that action', async (action) => {
    const result = await run('whatsapp-campaigns', { action, campaignId: id, requestId: randomUUID() });
    expect(result.status).toBe('confirmation_required');
    expect(mocks.campaign.mock.calls.every(([event]) => event.body.action === 'preflight')).toBe(true);
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it('erasure preview is always a dry run', async () => {
    const result = await run('whatsapp-consent', { action: 'erase', personId: id, requestId: randomUUID() });
    expect(result.status).toBe('confirmation_required');
    expect(mocks.consent.mock.calls[0]![0].body.dryRun).toBe(true);
  });
  it('disconnect preview does not call the account operation', async () => {
    await run('whatsapp-accounts', { action: 'disconnect', accountId: id, requestId: randomUUID() });
    expect(mocks.accounts).not.toHaveBeenCalled();
  });
  it('consent import preview does not apply any row', async () => {
    await run('whatsapp-consent', { action: 'import', rows: [{ personId: id, status: 'OPTED_IN', wordingShown: 'Agreed' }], requestId: randomUUID() });
    expect(mocks.consent).not.toHaveBeenCalled();
  });
  it('selected-event replay preview schedules nothing', async () => {
    await run('whatsapp-webhooks', { action: 'replay', eventIds: [id], requestId: randomUUID() });
    expect(mocks.webhooks).not.toHaveBeenCalled();
  });
  it('validates confirmation before executing a destructive action', async () => {
    mocks.consume.mockRejectedValueOnce(new Error('stale confirmation'));
    await expect(run('whatsapp-accounts', { action: 'disconnect', accountId: id, phase: 'execute', confirmationToken: 'token', requestId: randomUUID() })).rejects.toThrow('stale');
    expect(mocks.accounts).not.toHaveBeenCalled();
    await run('whatsapp-accounts', { action: 'disconnect', accountId: id, phase: 'execute', confirmationToken: 'token', requestId: randomUUID() });
    expect(mocks.accounts).toHaveBeenCalledTimes(1);
  });
});
