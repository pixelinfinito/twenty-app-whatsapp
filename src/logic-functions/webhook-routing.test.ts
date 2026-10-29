import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Its own file because it needs `kv` mocked at module level, and
 * `ingestion.test.ts` deliberately runs against the real SDK exports.
 */
const claims = new Map<string, string>();

vi.mock('twenty-sdk/logic-function', () => ({
  kv: {
    get: async (key: string) => claims.get(key) ?? null,
    set: async (key: string, value: string) => {
      claims.set(key, value);
    },
    delete: async (key: string) => claims.delete(key),
  },
  Response: class {},
}));

const { partitionEntriesByWorkspace } = await import('./wa-webhook-resolver');

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
