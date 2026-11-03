import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_STATUS } from '../domain/constants';

/**
 * Install and uninstall (AR-5, specs/01 §5).
 *
 * Both hooks exist for the same reason: the routing claim is a SERVER-scoped
 * `kv` entry shared across every workspace on the instance, it is invisible in
 * every UI, and it decides whether a number's messages arrive at all.
 *
 * So the tests are about the two ways that goes wrong. A claim left behind by an
 * uninstall makes the number unconnectable *anywhere*, for ever, with no error
 * to read. A claim taken from another workspace silently diverts that tenant's
 * inbound traffic here — which is worse, and is why every write and delete is
 * owner-checked in both directions.
 */

const kvStore = new Map<string, unknown>();
const kvSet = vi.fn();
const kvDelete = vi.fn();

vi.mock('twenty-sdk/logic-function', () => ({
  kv: {
    get: async (key: string) => kvStore.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      kvSet(key, value);
      kvStore.set(key, value);
    },
    delete: async (key: string) => {
      kvDelete(key);

      return kvStore.delete(key);
    },
  },
}));

const listAccounts = vi.fn();
const currentWorkspaceId = vi.fn();
const metadataQuery = vi.fn();

vi.mock('../server/repositories/accounts', () => ({
  listAccounts: (...args: unknown[]) => listAccounts(...args),
}));

vi.mock('../server/workspace', () => ({
  currentWorkspaceId: () => currentWorkspaceId(),
}));

vi.mock('../server/clients', () => ({
  metadataClient: () => ({ query: (...args: unknown[]) => metadataQuery(...args) }),
}));

const { ROLE_ADMIN, ROLE_AGENT } = await import('../constants/universal-identifiers');
const { SCHEMA_VERSION, SCHEMA_VERSION_KEY, install } = await import('./post-install');
const { uninstall } = await import('./uninstall');

const ACCOUNT = {
  id: 'acc1',
  phoneNumberId: '123',
  wabaId: 'waba1',
  status: ACCOUNT_STATUS.CONNECTED,
};

const PHONE_KEY = 'wa:phone-number:123';
const WABA_KEY = 'wa:waba:waba1';

beforeEach(() => {
  kvStore.clear();
  kvSet.mockReset();
  kvDelete.mockReset();
  listAccounts.mockReset();
  currentWorkspaceId.mockReset();
  metadataQuery.mockReset();

  listAccounts.mockResolvedValue([ACCOUNT]);
  currentWorkspaceId.mockResolvedValue('ws1');
  metadataQuery.mockResolvedValue({
    getRoles: [{ universalIdentifier: ROLE_ADMIN }, { universalIdentifier: ROLE_AGENT }],
  });
});

describe('post-install', () => {
  it('records the schema version and reports a first install', async () => {
    const result = await install({ newVersion: '0.1.0' });

    expect(result.firstInstall).toBe(true);
    expect(kvStore.get(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);

    const second = await install({ newVersion: '0.2.0', previousVersion: '0.1.0' });

    expect(second.firstInstall).toBe(false);
    expect(second.previousVersion).toBe('0.1.0');
  });

  it('reports the manifest’s roles as present', async () => {
    const result = await install({ newVersion: '0.1.0' });

    expect(result.rolesMissing).toEqual([]);
    expect(result.rolesPresent).toEqual(['WhatsApp Admin', 'WhatsApp Agent']);
  });

  /**
   * A missing role means an install that will refuse every admin action. Better
   * to see it in the install log than when someone tries to connect a number —
   * but it is a report, not a throw: a hook that aborts leaves the app installed
   * with an error nobody can act on.
   */
  it('names a missing role without failing the install', async () => {
    metadataQuery.mockResolvedValue({ getRoles: [{ universalIdentifier: ROLE_AGENT }] });

    const result = await install({ newVersion: '0.1.0' });

    expect(result.rolesMissing).toEqual(['WhatsApp Admin']);
  });

  it('survives a metadata read that fails', async () => {
    metadataQuery.mockRejectedValue(new Error('metadata unavailable'));

    await expect(install({ newVersion: '0.1.0' })).resolves.toMatchObject({
      rolesPresent: [],
      rolesMissing: [],
    });
  });

  /**
   * A restore or an instance migration leaves the account record intact and the
   * claim gone — an account that looks perfectly healthy while every message for
   * its number is discarded as unclaimed.
   */
  it('re-asserts a missing claim for a connected number', async () => {
    const result = await install({ newVersion: '0.1.0' });

    expect(result.claimsRepaired).toBe(2);
    expect(kvStore.get(PHONE_KEY)).toBe('ws1');
    expect(kvStore.get(WABA_KEY)).toBe('ws1');
  });

  it('leaves an intact claim alone', async () => {
    kvStore.set(PHONE_KEY, 'ws1');
    kvStore.set(WABA_KEY, 'ws1');

    const result = await install({ newVersion: '0.1.0' });

    expect(result.claimsRepaired).toBe(0);
    expect(kvSet).not.toHaveBeenCalledWith(PHONE_KEY, expect.anything());
  });

  /**
   * The claim is shared across the whole instance. Taking one held elsewhere
   * would divert another tenant's inbound messages into this workspace, so it is
   * reported and never written (SEC-5).
   */
  it('reports another workspace’s claim instead of taking it', async () => {
    kvStore.set(PHONE_KEY, 'ws-other');

    const result = await install({ newVersion: '0.1.0' });

    expect(result.claimsConflicting).toBe(1);
    expect(result.claimsRepaired).toBe(0);
    expect(kvStore.get(PHONE_KEY)).toBe('ws-other');
    expect(kvStore.get(WABA_KEY)).toBeUndefined();
  });

  /**
   * The `/s/` prefix is the assertion, not an incidental part of the string.
   * It is the app's own HTTP-route namespace, and no logic function declares
   * `/whatsapp/webhook` in it — so the URL this once published was a 404 that
   * every operator was told to paste into Meta. The callback is the
   * reverse-proxy alias (D-1), which lives at the domain root.
   */
  it('publishes the proxy-alias callback URL, not a non-existent app route', async () => {
    process.env.TWENTY_API_URL = 'https://crm.example.com/';

    const result = await install({ newVersion: '0.1.0' });

    expect(result.callbackUrl).toBe('https://crm.example.com/whatsapp/webhook');
    expect(result.callbackUrl).not.toContain('/s/');
  });

  /** It must never invent an account: an account claims a real phone number. */
  it('seeds nothing the operator has to own', async () => {
    listAccounts.mockResolvedValue([]);

    const result = await install({ newVersion: '0.1.0' });

    expect(result.accounts).toBe(0);
    expect(result.claimsRepaired).toBe(0);
  });
});

describe('uninstall', () => {
  it('releases this workspace’s claims so the number can be connected again', async () => {
    kvStore.set(PHONE_KEY, 'ws1');
    kvStore.set(WABA_KEY, 'ws1');

    const result = await uninstall({ version: '0.1.0' });

    expect(result.released).toBe(2);
    expect(kvStore.has(PHONE_KEY)).toBe(false);
    expect(kvStore.has(WABA_KEY)).toBe(false);
  });

  it('leaves a claim another workspace holds', async () => {
    kvStore.set(PHONE_KEY, 'ws-other');
    kvStore.set(WABA_KEY, 'ws-other');

    const result = await uninstall({ version: '0.1.0' });

    expect(result.released).toBe(0);
    expect(result.foreign).toBe(2);
    expect(kvDelete).not.toHaveBeenCalled();
  });

  /**
   * Unlike `disconnect`, a shared WABA claim *is* released: every account in
   * this workspace is going away together, so the only remaining sharer would be
   * another workspace — which the owner check has already excluded.
   */
  it('releases a WABA claim shared by two of this workspace’s numbers', async () => {
    listAccounts.mockResolvedValue([ACCOUNT, { ...ACCOUNT, id: 'acc2', phoneNumberId: '456' }]);
    kvStore.set(PHONE_KEY, 'ws1');
    kvStore.set('wa:phone-number:456', 'ws1');
    kvStore.set(WABA_KEY, 'ws1');

    const result = await uninstall({ version: '0.1.0' });

    expect(result.released).toBe(3);
    expect(kvStore.has(WABA_KEY)).toBe(false);
  });

  /**
   * Without the workspace id there is no way to tell our claims from a
   * stranger's. A stranded claim is repairable by the next install; a stolen one
   * is an incident.
   */
  it('releases nothing when it cannot tell whose claims these are', async () => {
    currentWorkspaceId.mockResolvedValue(null);
    kvStore.set(PHONE_KEY, 'ws1');

    const result = await uninstall({ version: '0.1.0' });

    expect(result.released).toBe(0);
    expect(kvStore.get(PHONE_KEY)).toBe('ws1');
  });

  it('carries on past one account whose claim cannot be released', async () => {
    listAccounts.mockResolvedValue([
      { ...ACCOUNT, wabaId: 'waba-a' },
      { ...ACCOUNT, id: 'acc2', phoneNumberId: '456', wabaId: 'waba-b' },
    ]);
    kvStore.set(PHONE_KEY, 'ws1');
    kvStore.set('wa:waba:waba-a', 'ws1');
    kvStore.set('wa:phone-number:456', 'ws1');
    kvStore.set('wa:waba:waba-b', 'ws1');

    kvDelete.mockImplementationOnce(() => {
      throw new Error('kv unavailable');
    });

    const result = await uninstall({ version: '0.1.0' });

    expect(result.accounts).toBe(2);
    /** The first account's claim is stranded; the second is still released. */
    expect(kvStore.has(PHONE_KEY)).toBe(true);
    expect(kvStore.has('wa:phone-number:456')).toBe(false);
    expect(kvStore.has('wa:waba:waba-b')).toBe(false);
  });
});
