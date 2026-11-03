import { RestApiClient } from 'twenty-client-sdk/rest';
import type { Response, RoutePayload } from 'twenty-sdk/logic-function';
import { requireRole } from './auth';
import { config, forAccount } from './config';
import { toE164, toWaId } from '../domain/phone/normalise';
import { TOOL_ACTIONS, isRead, needsConfirmation, requiredRole, type WhatsappToolName } from './tool-contracts';
import { ToolError } from './tool-errors';
import { handler as feed, inboxSpecFor } from './operation-inbox-feed-route';
import { handler as send, type SendRequestBody } from './operation-send-message-route';
import { handler as threadAction } from './operation-thread-actions-route';
import { handler as templates } from './operation-template-submit';
import { handler as campaigns } from './operation-campaign-control';
import { handler as consent } from './operation-consent-route';
import { handler as accounts } from './operation-account-admin-route';
import { handler as webhooks } from './operation-webhook-replay-route';
import { listAccounts, findAccountById } from './repositories/accounts';
import { findPersonById } from './repositories/people';
import { parseFeedQuery } from '../domain/feed/query';
import { listToolThreads, type InboxFilterSpec } from './repositories/threads';
import { waIdForPerson } from './template-send';
import { toolScope, withApplicationReads } from './tool-scope';
import { matchPerson } from './matching';
import { findThread } from './repositories/threads';
import { consumeConfirmation, once, prepareConfirmation, uuidV4 } from './tool-store';
import { listWebhookEvents } from './repositories/webhook-events';
import { eventsForThread } from './operation-webhook-replay-route';
import { assertToolCampaignAudience } from './tool-audience';
import { logger } from './logger';

type Input = Record<string, unknown>;
type ObjectName = 'whatsappThreads' | 'whatsappTemplates' | 'whatsappAccounts' | 'whatsappCampaigns' | 'whatsappCampaignRecipients' | 'whatsappWebhookEvents' | 'whatsappMessages' | 'whatsappConsentEvents' | 'people' | 'workspaceMembers';
type RecordRow = Record<string, unknown> & { id: string; updatedAt?: string };
type RestEnvelope = { data?: Record<string, unknown>; pageInfo?: { endCursor?: string; hasNextPage?: boolean }; totalCount?: number };
const readRest = () => new RestApiClient({ token: toolScope()!.accessToken });

const event = <T>(body: T, query: Record<string, string | undefined> = {}): RoutePayload<T> => ({
  body, headers: {}, queryStringParameters: query, pathParameters: {}, isBase64Encoded: false,
  requestContext: { http: { method: 'POST', path: '/whatsapp/tool' } }, userWorkspaceId: null,
});
const invoke = async <T>(handler: (event: RoutePayload<T>) => Promise<Response>, input: Input, query?: Record<string, string | undefined>): Promise<Input> => {
  const response = await handler(event(input as T, query));
  const body = response.body as Input;
  if ((response.status ?? 200) >= 500) throw new ToolError('OUTCOME_UNKNOWN', 'Operation failed; inspect its target before retrying with a different requestId.');
  if ((response.status ?? 200) >= 400) {
    const candidate = body.code ?? body.error;
    const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]+$/.test(candidate)
      ? candidate : response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'RECORD_UNAVAILABLE' : 'OPERATION_DENIED';
    return { status: 'denied', code, data: body, warnings: body.warnings ?? [] };
  }
  return { status: response.status === 202 ? 'accepted' : 'ready', data: body,
    ...(body.olderCursor !== undefined || body.nextCursor !== undefined
      ? { pageInfo: { nextCursor: body.olderCursor ?? body.nextCursor ?? null } } : {}), warnings: body.warnings ?? [] };
};

export const readToolPage = async (object: ObjectName, input: Input, filter?: string): Promise<Input> => {
  const first = typeof input.first === 'number' ? input.first : 20;
  const response = await readRest().get<RestEnvelope>(`/rest/${object}`, {
    query: { limit: first, ...(filter ? { filter } : {}), ...(input.after ? { starting_after: String(input.after) } : {}) },
  });
  const rows = response.data?.[object];
  if (!Array.isArray(rows)) throw new ToolError('INVALID_PLATFORM_RESPONSE');
  return { status: 'ready', data: { [object]: rows }, pageInfo: response.pageInfo ?? {}, warnings: [] };
};

const getRecord = async (object: ObjectName, id: unknown): Promise<RecordRow> => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new ToolError('INVALID_INPUT', `${object}: a record UUID is required`);
  const response = await readRest().get<RestEnvelope>(`/rest/${object}`, { query: { filter: `id[eq]:${id}`, limit: 1 } });
  const row = (response.data?.[object] as RecordRow[] | undefined)?.[0];
  if (!row) throw new ToolError('RECORD_UNAVAILABLE', `${object} record is missing or inaccessible`);
  return row;
};

const requiredTargets = async (input: Input) => {
  const targets: [ObjectName, unknown][] = [['whatsappThreads', input.threadId], ['people', input.personId],
    ['whatsappAccounts', input.accountId], ['whatsappTemplates', input.templateId], ['whatsappCampaigns', input.campaignId], ['workspaceMembers', input.assigneeId]];
  const records: RecordRow[] = [];
  for (const [object, id] of targets) if (id) records.push(await getRecord(object, id));
  for (const id of (input.eventIds as string[] | undefined) ?? []) records.push(await getRecord('whatsappWebhookEvents', id));
  for (const row of (input.rows as Input[] | undefined) ?? []) records.push(await getRecord('people', row.personId));
  // New/existing relationships are always resolved with the caller's access.
  for (const row of [...records]) {
    if (row.accountId && row.accountId !== input.accountId) records.push(await getRecord('whatsappAccounts', row.accountId));
    if (row.templateId && row.templateId !== input.templateId) records.push(await getRecord('whatsappTemplates', row.templateId));
    if (row.personId && row.personId !== input.personId) records.push(await getRecord('people', row.personId));
  }
  return records;
};

const sendMessage = async (input: Input): Promise<Input> => {
  const selectors = [input.threadId, input.personId, input.phone].filter((v) => v !== undefined);
  if (selectors.length !== 1) throw new ToolError('RECIPIENT_AMBIGUOUS', 'Supply exactly one of threadId, personId, or phone+accountId.');
  const body: SendRequestBody = { message: input.message, clientToken: String(input.requestId).toLowerCase() };
  const message = input.message as Input | undefined;
  if (message?.kind === 'media' && message.fileId && !message.fileUrl && !message.filePath) {
    if (!uuidV4(message.fileId)) throw new ToolError('INVALID_INPUT', 'fileId must be a UUID v4');
    // A newly completed native upload can be attached directly. The outbound
    // worker reads it through the retained FILES field with a fresh signed URL.
    body.message = { ...message, filePath: `file/files-field/${message.fileId}` };
  }
  if (input.threadId) body.threadId = String(input.threadId);
  else {
    let accountId = input.accountId as string | undefined;
    if (!accountId) {
      if (input.phone) throw new ToolError('ACCOUNT_REQUIRED');
      const connected = (await listAccounts()).filter((a) => a.status === 'CONNECTED');
      if (connected.length !== 1) throw new ToolError('ACCOUNT_AMBIGUOUS');
      accountId = connected[0]!.id;
    }
    const account = await findAccountById(accountId);
    if (!account) throw new ToolError('ACCOUNT_UNKNOWN');
    const country = forAccount(account.defaultCountryCallingCode, config.defaultCountryCallingCode);
    let waId: string | null;
    if (input.personId) {
      const person = await findPersonById(String(input.personId));
      waId = person ? waIdForPerson(person, country) : null;
    } else {
      if (typeof input.phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(input.phone)) throw new ToolError('INVALID_PHONE', 'Use an exact E.164 number, including +country code.');
      const e164 = toE164(input.phone, country);
      waId = e164 ? toWaId(e164) : null;
    }
    if (!waId) throw new ToolError('NO_PHONE');
    const identity = await withApplicationReads(async () => ({
      thread: await findThread(account.id, waId!),
      person: await matchPerson({ waId: waId!, account: { ...account, contactAutoCreationEnabled: false } }),
    }));
    if (identity.thread) {
      await getRecord('whatsappThreads', identity.thread.id);
      if (identity.thread.personId) await getRecord('people', identity.thread.personId);
    }
    if (identity.person.kind === 'ambiguous') throw new ToolError('RECIPIENT_AMBIGUOUS');
    if (identity.person.kind === 'matched' || identity.person.kind === 'created') {
      await getRecord('people', identity.person.person.id);
      if (input.personId && input.personId !== identity.person.person.id) throw new ToolError('RECIPIENT_AMBIGUOUS');
    }
    body.accountId = accountId; body.waId = waId;
  }
  const result = await invoke(send, body as Input);
  if (result.status === 'accepted') {
    const data = result.data as Input;
    const message = data.message as Input;
    // Persist only identifiers and status in the request ledger, not message bodies.
    return { status: 'accepted', messageId: message.id, threadId: data.threadId, delivery: 'queued',
      replayed: data.replayed === true, warnings: result.warnings };
  }
  return result;
};

const capabilities = async (): Promise<Input> => {
  const scope = toolScope()!;
  const operations = Object.fromEntries(Object.entries(TOOL_ACTIONS).map(([name, actions]) => [name,
    actions.filter((a) => requiredRole(name as WhatsappToolName, a) === 'agent' || scope.caller.isAdmin)
      .map((action) => ({ action, confirmationRequired: needsConfirmation(name as WhatsappToolName, action) })),
  ]));
  return { status: 'ready', principal: { kind: scope.principal.kind, id: scope.principal.id },
    permissions: { operator: true, admin: scope.caller.isAdmin }, accounts: await listAccounts(), operations,
    messageKinds: ['text', 'template', 'media', 'interactive', 'reaction', 'location', 'contacts'],
    mediaKinds: ['image', 'video', 'audio', 'document', 'sticker'], voiceNotes: true,
    confirmationTtlSeconds: 600, warnings: [] };
};

const previewOperation = async (name: WhatsappToolName, input: Input): Promise<Input> => {
  if (name === 'whatsapp-campaigns' && ['launch', 'resume'].includes(String(input.action))) {
    const campaign = await getRecord('whatsappCampaigns', input.campaignId);
    await assertToolCampaignAudience(campaign.id, Number(campaign.recipientCount ?? 0));
    return invoke(campaigns, { ...input, action: 'preflight' });
  }
  if (name === 'whatsapp-consent' && input.action === 'erase') return invoke(consent, { ...input, dryRun: true });
  if (name === 'whatsapp-webhooks' && input.action !== 'replay') return invoke(webhooks, { ...input, limit: input.first ?? 20, dryRun: true });
  if (name === 'whatsapp-consent' && input.action === 'import') {
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 60) throw new ToolError('INVALID_INPUT', 'Import requires 1–60 evidence rows.');
  }
  return { status: 'ready', data: { action: input.action, targets: await requiredTargets(input),
    ...(input.rows ? { rowCount: (input.rows as unknown[]).length } : {}) }, warnings: [] };
};

const dispatch = async (name: WhatsappToolName, input: Input): Promise<Input> => {
  switch (name) {
    case 'whatsapp-get-capabilities': return capabilities();
    case 'whatsapp-list-threads': {
      const parsed = parseFeedQuery({ scope: 'inbox', filter: (input.filter ?? (input.status === 'CLOSED' ? 'closed' : 'all')) as string });
      if (!parsed.ok) throw new ToolError('INVALID_INPUT', parsed.error);
      const spec = inboxSpecFor(parsed.query, toolScope()!.caller, new Date());
      if ('error' in spec) throw new ToolError('INVALID_INPUT', spec.error);
      // Compound/time filters use the shared GraphQL repository, with the
      // additional selectors applied in the repository (never after paging).
      return listThreads(input, spec);
    }
    case 'whatsapp-get-thread': return invoke(feed, {}, { scope: 'thread', id: String(input.threadId), limit: String(input.first ?? 20), before: input.after as string | undefined });
    case 'whatsapp-send-message': return sendMessage(input);
    case 'whatsapp-thread-action': return invoke(threadAction, input);
    case 'whatsapp-templates':
      if (input.action === 'list') return readToolPage('whatsappTemplates', input, input.accountId ? `accountId[eq]:${input.accountId}` : undefined);
      if (input.action === 'sync') return invoke(accounts, { action: 'syncTemplates', accountId: input.accountId });
      return invoke(templates, input);
    case 'whatsapp-campaigns':
      if (input.action === 'list') return readToolPage('whatsappCampaigns', input,
        `and(archivedAt[is]:${input.archived ? 'NOT_NULL' : 'NULL'}${input.accountId ? `,accountId[eq]:${input.accountId}` : ''})`);
      if (input.action === 'get') return { status: 'ready', data: { campaign: await getRecord('whatsappCampaigns', input.campaignId),
        recipients: await readToolPage('whatsappCampaignRecipients', input, `campaignId[eq]:${input.campaignId}`) }, warnings: [] };
      return invoke(campaigns, input);
    case 'whatsapp-consent':
      if (input.action === 'history') return readToolPage('whatsappConsentEvents', input, `personId[eq]:${input.personId}`);
      return invoke(consent, { ...input, ...(input.action === 'erase' ? { dryRun: false } : {}) });
    case 'whatsapp-accounts':
      if (input.action === 'list') return readToolPage('whatsappAccounts', input);
      return invoke(accounts, input);
    case 'whatsapp-webhooks': return invoke(webhooks, { ...input, limit: input.first ?? 20, ...(input.action !== 'list' ? { dryRun: false } : {}) });
  }
};

// Imported separately to keep the inbox's GraphQL filter semantics intact.
const listThreads = (input: Input, spec: InboxFilterSpec) => listToolThreads(spec, input);

export const executeWhatsappTool = async (name: WhatsappToolName, input: Input): Promise<Input> => {
  const action = typeof input.action === 'string' ? input.action : '';
  requireRole(toolScope()!.caller, requiredRole(name, action));
  for (const key of ['since', 'until', 'scheduledAt', 'snoozedUntil']) {
    if (typeof input[key] === 'string' && !Number.isFinite(Date.parse(input[key]))) throw new ToolError('INVALID_INPUT', `${key}: invalid timestamp`);
  }
  if (name === 'whatsapp-consent' && !input.personId && action !== 'import') throw new ToolError('INVALID_INPUT', 'personId is required');
  if (isRead(name, action)) {
    await requiredTargets(input);
    return dispatch(name, input);
  }
  if (!uuidV4(input.requestId)) throw new ToolError('INVALID_REQUEST_ID');
  const { requestId, phase, confirmationToken, ...operationInput } = input;
  if (!needsConfirmation(name, action) && (phase !== undefined || confirmationToken !== undefined)) {
    throw new ToolError('INVALID_INPUT', 'phase and confirmationToken apply only to operations requiring confirmation.');
  }
  // Include target authorization checks on every retry, even if a result exists.
  await requiredTargets(operationInput);
  const result = await once(requestId, name, { ...operationInput, phase: phase ?? 'preview', confirmationToken }, async () => {
    if (needsConfirmation(name, action)) {
      const preview = await previewOperation(name, operationInput);
      if (preview.status === 'denied') return preview;
      let events: unknown;
      if (name === 'whatsapp-webhooks' && action === 'replayFailed') {
        events = (await listWebhookEvents({ statuses: ['FAILED'],
          since: typeof input.since === 'string' ? new Date(input.since) : null,
          until: typeof input.until === 'string' ? new Date(input.until) : null,
          limit: typeof input.first === 'number' ? input.first : 20,
        })).items.map((row) => ({ id: row.id, status: row.processingStatus, attempts: row.attemptCount }));
      } else if (name === 'whatsapp-webhooks' && action === 'resyncThread') {
        const found = await eventsForThread(String(input.threadId), typeof input.since === 'string' ? new Date(input.since) : null,
          typeof input.first === 'number' ? input.first : 20);
        if (!found.ok) throw new ToolError('RECORD_UNAVAILABLE');
        events = found.events.map((row) => ({ id: row.id, status: row.processingStatus, attempts: row.attemptCount }));
      }
      const targets = (await requiredTargets(operationInput)).map((r) => {
        if (typeof r.updatedAt !== 'string') throw new ToolError('REVISION_UNAVAILABLE');
        return { id: r.id, updatedAt: r.updatedAt };
      });
      const revision = { targets, events,
        ...((name === 'whatsapp-consent' && action === 'erase') || name === 'whatsapp-webhooks' ? { impact: preview.data } : {}) };
      if (phase !== 'execute') {
        const confirmation = await prepareConfirmation(name, operationInput, revision);
        return { status: 'confirmation_required', preview, ...confirmation, warnings: [] };
      }
      await consumeConfirmation(confirmationToken, name, operationInput, revision);
    }
    return dispatch(name, { ...operationInput, requestId });
  });
  const principal = toolScope()!.principal;
  logger.info('wa.tool.operation', { tool: name, action, requestId, status: result.status,
    principalKind: principal.kind, principalId: principal.id, surface: principal.surface });
  return result;
};
