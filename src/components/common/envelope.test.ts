import { describe, expect, it } from 'vitest';

import { mergeEnvelope, type FeedEnvelope } from './use-feed';

const envelope = (over: Partial<FeedEnvelope> = {}): FeedEnvelope => ({
  serverTime: '2026-08-17T06:00:00.000Z',
  nextSince: '2026-08-17T06:00:00.000Z',
  scope: 'thread',
  permissions: {
    canSend: true,
    canManageTemplates: false,
    canManageCampaigns: false,
    workspaceMemberId: 'wm-1',
  },
  ...over,
});

const template = (id: string) => ({
  id,
  name: id,
  language: 'pt_PT',
  category: 'MARKETING',
  qualityScore: null,
  variableSpec: null,
  components: null,
});

/**
 * The bug this exists to prevent: the thread scope sends the template
 * catalogue only on a full load, and the client used to replace the whole
 * envelope on every poll. Three seconds after opening a conversation the
 * catalogue was gone, and "Escolher modelo" opened onto "no published
 * templates for this number" with five of them published.
 */
describe('mergeEnvelope', () => {
  it('takes the first envelope whole', () => {
    const first = envelope({ templates: [template('a')] });

    expect(mergeEnvelope(null, first)).toBe(first);
  });

  it('keeps the catalogue a delta left out', () => {
    const full = envelope({ templates: [template('a'), template('b')] });
    const delta = envelope({ nextSince: '2026-08-17T06:00:03.000Z' });

    const merged = mergeEnvelope(full, delta);

    expect(merged.templates).toHaveLength(2);
    // Everything else is still the new envelope's.
    expect(merged.nextSince).toBe('2026-08-17T06:00:03.000Z');
  });

  it('survives poll after poll rather than only the first one', () => {
    let data = mergeEnvelope(null, envelope({ templates: [template('a')] }));

    for (let poll = 0; poll < 20; poll += 1) {
      data = mergeEnvelope(data, envelope());
    }

    expect(data.templates).toHaveLength(1);
  });

  /**
   * An empty catalogue is a statement, not an omission: every template was
   * unpublished. Merging it away would leave a rep looking at a picker full of
   * templates the server has stopped accepting.
   */
  it('lets an explicitly empty catalogue replace the old one', () => {
    const full = envelope({ templates: [template('a')] });

    expect(mergeEnvelope(full, envelope({ templates: [] })).templates).toEqual([]);
  });

  it('takes a new catalogue over the old one', () => {
    const full = envelope({ templates: [template('a')] });

    expect(
      mergeEnvelope(full, envelope({ templates: [template('b')] })).templates,
    ).toEqual([template('b')]);
  });

  /**
   * Nothing else is carried forward. `thread`, `policy` and `account` are on
   * every thread reply, so a missing one means gone — a conversation that was
   * deleted must not keep rendering from a stale envelope.
   */
  it('does not carry anything but the catalogue across', () => {
    const full = envelope({
      templates: [template('a')],
      policy: { allowed: true, reason: null, warnings: [] },
    });

    expect(mergeEnvelope(full, envelope()).policy).toBeUndefined();
  });
});

it('retains upload metadata across thread deltas', () => {
  const uploadTargets = { messageMediaFieldMetadataId: 'message-field', campaignHeaderMediaFieldMetadataId: null };
  const full = envelope({ uploadTargets });
  expect(mergeEnvelope(full, envelope()).uploadTargets).toEqual(uploadTargets);
});
