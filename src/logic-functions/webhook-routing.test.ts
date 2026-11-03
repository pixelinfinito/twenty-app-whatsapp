import { createHmac } from 'node:crypto';
import type { RoutePayload } from 'twenty-sdk/logic-function';
import type { MetaWebhookBody } from '../domain/webhook/types';
import { LF_WEBHOOK_INGEST } from '../constants/universal-identifiers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Its own file because it needs `kv` mocked at module level, and
 * `ingestion.test.ts` deliberately runs against the real SDK exports.
 */
const claims = new Map<string, string>();

vi.mock('twenty-sdk/logic-function', async (importOriginal) => ({
  ...await importOriginal<typeof import('twenty-sdk/logic-function')>(),
  kv: {
    get: async (key: string) => claims.get(key) ?? null,
    set: async (key: string, value: string) => {
      claims.set(key, value);
    },
    delete: async (key: string) => claims.delete(key),
  },
}));

const { default: resolver, handler, partitionEntriesByWorkspace } = await import('./wa-webhook-resolver');

const delivery = (wabaId: string, phoneNumberId: string) => ({
  entry: [
    {
      id: wabaId,
      changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId } } }],
    },
  ],
});

beforeEach(() => {
  claims.clear();
});

/**
 * The diagnostic a live install proved was missing.
 *
 * A real inbound message arrived, its signature verified, and it was discarded
 * as unclaimed — while the settings page showed the number CONNECTED and every
 * other health signal was green. The log said `unclaimedEntries: 1` and
 * nothing more, so there was no way to tell whether Meta was delivering for a
 * different `phone_number_id` than the one claimed. A count is not a
 * diagnostic; the keys are.
 */
describe('partitionEntriesByWorkspace', () => {
  it('routes an entry to the workspace holding its phone claim', async () => {
    claims.set('wa:phone-number:pn-1', 'ws-1');

    const result = await partitionEntriesByWorkspace(delivery('waba-1', 'pn-1'));

    expect(result.unclaimedEntries).toBe(0);
    expect(result.unclaimedKeys).toEqual([]);
    expect([...result.groups.keys()]).toEqual(['ws-1']);
  });

  it('names both keys it tried when nothing claims the delivery', async () => {
    const result = await partitionEntriesByWorkspace(delivery('waba-x', 'pn-x'));

    expect(result.unclaimedEntries).toBe(1);
    expect(result.unclaimedKeys).toEqual(['wa:phone-number:pn-x', 'wa:waba:waba-x']);
    expect(result.groups.size).toBe(0);
  });

  /**
   * The exact shape of the live failure: a claim exists, but for a different
   * number than the one Meta is delivering for. Printing the attempted key
   * beside the connected one is what makes that visible in a glance.
   */
  it('reports the arriving key, not the claimed one, when the two disagree', async () => {
    claims.set('wa:phone-number:1206450239224164', 'ws-1');

    const result = await partitionEntriesByWorkspace(
      delivery('2129199877947066', 'some-other-number'),
    );

    expect(result.unclaimedKeys).toContain('wa:phone-number:some-other-number');
    expect(result.unclaimedKeys).not.toContain('wa:phone-number:1206450239224164');
  });

  /** A template event carries no phone id, so the WABA claim is the only way in. */
  it('falls back to the WABA claim', async () => {
    claims.set('wa:waba:waba-1', 'ws-1');

    const result = await partitionEntriesByWorkspace({
      entry: [
        {
          id: 'waba-1',
          changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED' } }],
        },
      ],
    });

    expect([...result.groups.keys()]).toEqual(['ws-1']);
  });

  it('de-duplicates the reported keys across entries', async () => {
    const result = await partitionEntriesByWorkspace({
      entry: [
        ...delivery('waba-x', 'pn-x').entry,
        ...delivery('waba-x', 'pn-x').entry,
      ],
    });

    expect(result.unclaimedEntries).toBe(2);
    expect(result.unclaimedKeys).toEqual(['wa:phone-number:pn-x', 'wa:waba:waba-x']);
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('single callback handler', () => {
  const secret = 'test-only-signing-secret';
  const token = 'test-only-verification-token';
  const event = (overrides: Partial<RoutePayload<MetaWebhookBody>> = {}): RoutePayload<MetaWebhookBody> => ({
    headers: {}, queryStringParameters: {}, pathParameters: {}, body: null,
    isBase64Encoded: false, userWorkspaceId: null,
    requestContext: { http: { method: 'POST', path: '/webhooks/server/test' } },
    ...overrides,
  });

  beforeEach(() => {
    vi.stubEnv('META_VERIFY_TOKEN', token);
    vi.stubEnv('META_APP_SECRET', secret);
  });

  it('declares both methods on the resolver route', () => {
    expect(resolver.config.serverRouteTriggerSettings?.httpMethods).toEqual(['GET', 'POST']);
  });

  it('returns the bare GET challenge without demanding a POST signature', async () => {
    expect(await handler(event({
      requestContext: { http: { method: 'GET', path: '/webhooks/server/test' } },
      queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' },
    }))).toMatchObject({ status: 200, body: '12345', headers: { 'content-type': 'text/plain' } });
  });

  it('rejects a wrong GET verification token', async () => {
    expect(await handler(event({
      requestContext: { http: { method: 'GET', path: '/webhooks/server/test' } },
      queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' },
    }))).toMatchObject({ status: 403 });
  });

  it('rejects a POST when the signed raw body was changed', async () => {
    const rawBody = JSON.stringify({ object: 'whatsapp_business_account', ...delivery('waba-1', 'pn-1') });
    const signature = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(await handler(event({ rawBody: rawBody + ' ', body: JSON.parse(rawBody), headers: { 'x-hub-signature-256': signature } }))).toMatchObject({ status: 401 });
  });

  it('dispatches a valid signed POST to the claimed workspace', async () => {
    claims.set('wa:phone-number:pn-1', 'ws-1');
    const body = { object: 'whatsapp_business_account', ...delivery('waba-1', 'pn-1') };
    const rawBody = JSON.stringify(body);
    const signature = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(await handler(event({ rawBody, body, headers: { 'x-hub-signature-256': signature } }))).toMatchObject({
      workspaceId: 'ws-1', targetLogicFunctionUniversalIdentifier: LF_WEBHOOK_INGEST, payload: { body },
    });
  });
});
