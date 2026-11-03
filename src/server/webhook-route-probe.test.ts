import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROBE_BODY,
  PROBE_STATE,
  decideRouteProbe,
  probeWebhookRoute,
  resolverUrl,
} from './webhook-route-probe';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

/**
 * The failure this exists to catch: the app installs, all its logic functions
 * register, every other health row is green, and `POST /webhooks/server/{id}`
 * answers 404 because the application registration is unclaimed and a server
 * route has no workspace to run in. Confirmed on a live 2.31.1 install.
 */
describe('decideRouteProbe', () => {
  it('fails on 404 — the route does not exist', () => {
    expect(decideRouteProbe({ status: 404, signed: true })).toMatchObject({
      ok: false,
      state: PROBE_STATE.NOT_REGISTERED,
    });
  });

  it('passes on the resolver accepting a signed probe', () => {
    expect(decideRouteProbe({ status: 200, signed: true })).toMatchObject({
      ok: true,
      state: PROBE_STATE.LIVE,
    });
  });

  /**
   * The one reading that inverts. Unsigned, a 401 is the resolver refusing an
   * unverifiable delivery — which is the route working, and a pass. Signed, it
   * rejected a signature this app just computed, so the secret it verifies
   * against is not the secret it signs with.
   */
  it('reads 401 as healthy when unsigned and as a bad secret when signed', () => {
    expect(decideRouteProbe({ status: 401, signed: false })).toMatchObject({
      ok: true,
      state: PROBE_STATE.LIVE,
    });
    expect(decideRouteProbe({ status: 401, signed: true })).toMatchObject({
      ok: false,
      state: PROBE_STATE.SECRET_MISMATCH,
    });
  });

  /**
   * The state one step past the 404, found on the same live install: the
   * registration is claimed so the route exists, and the platform then refuses
   * to run it because the server has no `LOGIC_FUNCTION_TYPE`. The resolver
   * never answers 403 itself, so the status can only mean this.
   */
  it('fails on 403 — the platform will not run logic functions at all', () => {
    expect(decideRouteProbe({ status: 403, signed: true })).toMatchObject({
      ok: false,
      state: PROBE_STATE.EXECUTION_DISABLED,
    });
  });

  it('fails when the request never completed', () => {
    expect(decideRouteProbe({ status: null, signed: true })).toMatchObject({
      ok: false,
      state: PROBE_STATE.UNREACHABLE,
    });
  });

  /**
   * The third state the live install produced, once execution was enabled and
   * before the variables were set: the resolver fails closed on a missing
   * `META_APP_SECRET` rather than verifying signatures against an empty key,
   * so the only outward sign is a 500.
   */
  it('fails on a 5xx — a route that throws is not a healthy route', () => {
    expect(decideRouteProbe({ status: 500, signed: false })).toMatchObject({
      ok: false,
      state: PROBE_STATE.ERRORED,
      status: 500,
    });
  });

  /** Green on the unfamiliar: a row that cries wolf stops being read. */
  it('reports an unrecognised status without failing the row', () => {
    expect(decideRouteProbe({ status: 302, signed: true })).toMatchObject({
      ok: true,
      state: PROBE_STATE.UNKNOWN,
      status: 302,
    });
  });
});

describe('probeWebhookRoute', () => {
  it('posts the probe to the resolver, signed, when the secret is set', async () => {
    process.env.META_APP_SECRET = 'super-secret';

    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 } as Response);

    const outcome = await probeWebhookRoute({
      baseUrl: 'https://crm.example.com/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toMatchObject({ ok: true, state: PROBE_STATE.LIVE, signed: true });

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe(resolverUrl('https://crm.example.com'));
    expect(init.method).toBe('POST');
    expect(init.body).toBe(PROBE_BODY);
    expect(init.headers['x-hub-signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  /**
   * A signature the resolver accepts stops at its `object` guard, so the probe
   * touches no record, no queue and no Meta call — and, unlike an unsigned
   * one, does not trip the signature-rejected metric on every page load.
   */
  it('sends a body the resolver will recognise as not a delivery', () => {
    expect(JSON.parse(PROBE_BODY).object).not.toBe('whatsapp_business_account');
  });

  it('still probes, unsigned, when no app secret is configured', async () => {
    delete process.env.META_APP_SECRET;

    const fetchImpl = vi.fn().mockResolvedValue({ status: 401 } as Response);

    const outcome = await probeWebhookRoute({
      baseUrl: 'https://crm.example.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Unsigned 401 proves the route is there, which is what it can prove.
    expect(outcome).toMatchObject({ ok: true, state: PROBE_STATE.LIVE, signed: false });
    expect(fetchImpl.mock.calls[0][1].headers['x-hub-signature-256']).toBeUndefined();
  });

  it('reports a thrown request as unreachable rather than crashing the panel', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      probeWebhookRoute({
        baseUrl: 'https://crm.example.com',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ ok: false, state: PROBE_STATE.UNREACHABLE });
  });

  it('builds the resolver URL from the compile-time identifier', () => {
    expect(resolverUrl('https://crm.example.com///')).toBe(
      'https://crm.example.com/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd',
    );
  });
});
