import { createHash, randomUUID } from 'node:crypto';
import { RestApiClient, RestApiClientError } from 'twenty-client-sdk/rest';
import { kv } from 'twenty-sdk/logic-function';
import { ToolError } from './tool-errors';
import { toolScope } from './tool-scope';

export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
export const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
export const uuidV4 = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

type Entry = { id: string; requestKey: string; fingerprint: string; state: string; result?: Record<string, unknown> | null };
type Envelope = { data?: Record<string, unknown> };
const rest = () => new RestApiClient({ runAs: 'application' });

const claim = async (key: string, fingerprint: string): Promise<{ entry: Entry; owned: boolean }> => {
  try {
    const result = await rest().post<Envelope>('/rest/whatsappToolRequests', {
      name: key, requestKey: key, fingerprint, state: 'RUNNING',
    });
    const entry = result.data?.createWhatsappToolRequest as Entry | undefined;
    if (!entry?.id) throw new ToolError('REQUEST_STORE_UNAVAILABLE');
    return { entry, owned: true };
  } catch (error) {
    // Read after *any* uncertain create: a timeout may have committed the claim.
    const result = await rest().get<Envelope>('/rest/whatsappToolRequests', {
      query: { filter: `requestKey[eq]:${key}`, limit: 1 },
    });
    const entry = (result.data?.whatsappToolRequests as Entry[] | undefined)?.[0];
    if (!entry) throw error;
    return { entry, owned: false };
  }
};

export const once = async (
  requestId: unknown, operation: string, input: unknown,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  if (!uuidV4(requestId)) throw new ToolError('INVALID_REQUEST_ID');
  const principal = toolScope()!.principal;
  const key = digest([principal.workspaceId, requestId.toLowerCase()]);
  const fingerprint = digest([principal.kind, principal.id, principal.agentId, operation, input]);
  const { entry, owned } = await claim(key, fingerprint);
  if (entry.fingerprint !== fingerprint) throw new ToolError('IDEMPOTENCY_CONFLICT');
  if (!owned) {
    if (entry.state === 'DONE' && entry.result) return { ...entry.result, replayed: true };
    throw new ToolError('OUTCOME_UNKNOWN', 'This request already started. Do not retry with a new requestId; inspect its target state.');
  }
  // A failed/uncertain operation retains RUNNING permanently. Repeating provider
  // submissions after a crash would be unsafe; reconcile the target instead.
  const result = await run();
  await rest().patch(`/rest/whatsappToolRequests/${entry.id}`, { state: 'DONE', result });
  return result;
};

export const CONFIRMATION_TTL_MS = 10 * 60_000;
type Confirmation = { fingerprint: string; revision: string; expiresAt: number; principal: string };
const principalKey = () => {
  const p = toolScope()!.principal;
  return digest([p.workspaceId, p.kind, p.id, p.agentId]);
};
export const prepareConfirmation = async (operation: string, input: unknown, revision: unknown) => {
  const confirmationToken = randomUUID();
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  await kv.set(`wa:tool:confirmation:${confirmationToken}`, {
    fingerprint: digest([operation, input]), revision: digest(revision), expiresAt, principal: principalKey(),
  } satisfies Confirmation, { scope: 'WORKSPACE' });
  return { confirmationToken, expiresAt: new Date(expiresAt).toISOString() };
};
export const consumeConfirmation = async (
  token: unknown, operation: string, input: unknown, revision: unknown,
): Promise<void> => {
  if (!uuidV4(token)) throw new ToolError('CONFIRMATION_REQUIRED');
  const saved = await kv.get<Confirmation>(`wa:tool:confirmation:${token}`, { scope: 'WORKSPACE' });
  if (!saved || saved.expiresAt <= Date.now()) throw new ToolError('CONFIRMATION_EXPIRED');
  if (saved.principal !== principalKey() || saved.fingerprint !== digest([operation, input])) {
    throw new ToolError('CONFIRMATION_MISMATCH');
  }
  if (saved.revision !== digest(revision)) throw new ToolError('CONFIRMATION_STALE');
  const { owned } = await claim(`confirmation:${token}`, saved.fingerprint);
  if (!owned) throw new ToolError('CONFIRMATION_USED');
};

export const isAccessFailure = (error: unknown) => error instanceof RestApiClientError &&
  (error.status === 401 || error.status === 403);
