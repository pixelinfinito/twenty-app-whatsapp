import { describe, expect, it } from 'vitest';

import {
  attachSenderLabels,
  isRetryableError,
  memberLabel,
  projectMessage,
  projectThread,
} from './projection';

/**
 * What the components are allowed to believe.
 *
 * `isRetryable` is the one field here that is a *decision* rather than a copy,
 * which is why it is tested hardest: the **Repetir** button appears because of
 * it, and a button that appears on a message that can never succeed teaches a
 * rep to press it on the ones that can't either.
 */
describe('isRetryableError', () => {
  it('offers a retry only for the backoff class', () => {
    // 130429 — rate limit hit. Waiting is exactly the fix.
    expect(isRetryableError('130429')).toBe(true);
  });

  it('refuses a retry for a terminal recipient outcome', () => {
    // 131026 — not on WhatsApp. No number of presses changes that.
    expect(isRetryableError('131026')).toBe(false);
  });

  it('refuses a retry for an internal policy code', () => {
    expect(isRetryableError('POLICY_WINDOW_CLOSED')).toBe(false);
    expect(isRetryableError('UNKNOWN_ACCEPTANCE')).toBe(false);
  });

  /**
   * The one internal exception (D-58). Nothing reached Meta — the file could
   * not be read out of Twenty's own storage — and what fixes it is in the
   * rep's hands: a re-copied address, or a file store that answers this time.
   */
  it('offers a retry when the attachment could not be read', () => {
    expect(isRetryableError('ATTACHMENT_UNREADABLE')).toBe(true);
  });

  /** Meta losing a file it once held is not the same event, and is terminal. */
  it('refuses a retry when Meta no longer has the media', () => {
    expect(isRetryableError('MEDIA_UNAVAILABLE')).toBe(false);
  });

  it('refuses a retry for a code with no catalogue row', () => {
    // Absence of evidence that a retry is safe is not evidence that it is.
    expect(isRetryableError('999999')).toBe(false);
  });

  it('answers false for a message that never failed', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError('')).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('projectMessage', () => {
  it('carries the signed file url the bubble renders from', () => {
    const projected = projectMessage({
      id: 'm1',
      messageType: 'IMAGE',
      mediaMeta: { mimeType: 'image/jpeg', fileSize: 51_200, deferred: false },
      mediaFile: [{ fileId: 'f1', label: 'photo.jpg', url: 'https://host/file/f1?token=x' }],
    });

    expect(projected.media).toEqual({
      kind: 'IMAGE',
      fileId: 'f1',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      sizeBytes: 51_200,
      url: 'https://host/file/f1?token=x',
      deferred: false,
      downloadFailed: false,
      isVoice: false,
      isAnimated: false,
      durationSeconds: null,
      width: null,
      height: null,
    });
  });

  /**
   * The two flags a renderer cannot infer. A voice note and an attached `.ogg`
   * have the same MIME type and deserve different cards, so the projection has
   * to carry Meta's own answer rather than a guess made from the file.
   */
  it('carries the voice flag and the dimensions the renderer reserves space with', () => {
    const projected = projectMessage({
      id: 'm1',
      messageType: 'AUDIO',
      mediaMeta: { mimeType: 'audio/ogg', voice: true, durationSeconds: 12 },
    });

    expect(projected.media).toMatchObject({ isVoice: true, durationSeconds: 12 });
    expect(projected.content).toEqual({
      kind: 'audio',
      media: projected.media,
      isVoice: true,
    });
  });

  /**
   * The sender's own name for the file, spelled the way `MediaMeta` spells it.
   * Reading `fileName` here found nothing and fell through to the storage
   * label, which is deliberately a WAMID — so every document in the chat was
   * labelled `wamid.HBgMMj….pdf` and looked broken.
   */
  it('prefers the name the sender gave the document over the storage label', () => {
    const projected = projectMessage({
      id: 'm1',
      messageType: 'DOCUMENT',
      mediaMeta: { mimeType: 'application/pdf', filename: 'Proposta.pdf', fileSize: 82_000 },
      mediaFile: [
        { fileId: 'f1', label: 'wamid.HBgMMjQ0OTI4.pdf', url: 'https://host/file/f1?token=x' },
      ],
    });

    expect(projected.media?.fileName).toBe('Proposta.pdf');
  });

  it('falls back to the storage label when the sender named nothing', () => {
    const projected = projectMessage({
      id: 'm1',
      messageType: 'DOCUMENT',
      mediaMeta: { mimeType: 'application/pdf' },
      mediaFile: [
        { fileId: 'f1', label: 'wamid.HBgMMjQ0OTI4.pdf', url: 'https://host/file/f1?token=x' },
      ],
    });

    expect(projected.media?.fileName).toBe('wamid.HBgMMjQ0OTI4.pdf');
  });

  it('reports deferred media with no url, so the bubble offers a download (D-8)', () => {
    const projected = projectMessage({
      id: 'm1',
      messageType: 'VIDEO',
      mediaMeta: { fileSize: 94_371_840, deferred: true },
    });

    expect(projected.media).toMatchObject({ deferred: true, url: null, sizeBytes: 94_371_840 });
  });

  it('has no media block at all for a text message', () => {
    expect(projectMessage({ id: 'm1', messageType: 'TEXT', body: 'olá' }).media).toBeNull();
  });

  it('lifts reactions out of the payload and drops cleared ones', () => {
    const projected = projectMessage({
      id: 'm1',
      payload: {
        reactions: [
          { waId: '244900000001', emoji: '👍' },
          // A cleared reaction is stored as an empty emoji; showing it would
          // render a blank chip that a rep cannot explain.
          { waId: '244900000002', emoji: '' },
        ],
      },
    });

    expect(projected.reactions).toEqual([
      {
        actorId: '244900000001',
        actorLabel: null,
        actorKind: 'CONTACT',
        emoji: '👍',
        isMine: false,
      },
    ]);
  });

  /**
   * Which chip is the viewer's own is the whole of the removal interaction:
   * tapping an active reaction clears it, tapping another replaces it. The
   * browser is told, never left to compare ids it was not given (D-53).
   */
  it('marks the reading rep’s own reaction, and nobody else’s', () => {
    const projected = projectMessage(
      {
        id: 'm1',
        payload: {
          reactions: [
            { workspaceMemberId: 'wm-1', emoji: '🙏' },
            { workspaceMemberId: 'wm-2', emoji: '❤️' },
            { waId: '244900000001', emoji: '👍' },
          ],
        },
      },
      { workspaceMemberId: 'wm-1', contactWaId: '244900000001', contactLabel: 'Marcos' },
    );

    expect(projected.reactions.map((reaction) => reaction.isMine)).toEqual([
      true,
      false,
      false,
    ]);
    expect(projected.reactions[2]).toMatchObject({
      actorKind: 'CONTACT',
      actorLabel: 'Marcos',
    });
  });

  it('parses a JSON column that arrived as a string', () => {
    const projected = projectMessage({
      id: 'm1',
      statusTimestamps: '{"accepted":1786884204}',
    });

    expect(projected.statusTimestamps).toEqual({ accepted: 1786884204 });
  });

  it('survives a payload that is not JSON at all', () => {
    const projected = projectMessage({ id: 'm1', payload: 'not json {' });

    expect(projected.payload).toBeNull();
    expect(projected.reactions).toEqual([]);
  });
});

describe('projectThread', () => {
  it('normalises the counters a badge reads, so the UI never renders null', () => {
    const projected = projectThread({ id: 't1' });

    expect(projected.unreadCount).toBe(0);
    expect(projected.isBlocked).toBe(false);
    expect(projected.person).toBeNull();
  });

  it('keeps the link candidates that ask a human to decide (FR-CID-5)', () => {
    const projected = projectThread({
      id: 't1',
      status: 'NEEDS_REVIEW',
      linkCandidates: { candidates: [{ personId: 'p1' }, { personId: 'p2' }] },
    });

    expect(projected.linkCandidates).toEqual({
      candidates: [{ personId: 'p1' }, { personId: 'p2' }],
    });
  });
});

/**
 * Two reps working the same conversation saw an identical column of blue
 * bubbles with nothing to tell them apart. `sentById` answered "who" for an
 * audit and for nobody reading a conversation.
 */
describe('naming the colleague who sent a message', () => {
  it('joins the parts of a workspace member’s name', () => {
    expect(memberLabel({ name: { firstName: 'Ana', lastName: 'Silva' } })).toBe('Ana Silva');
    expect(memberLabel({ name: { firstName: 'Ana', lastName: null } })).toBe('Ana');
  });

  /**
   * Nothing rather than a placeholder: a member with no name filled in should
   * leave the line absent, not print "Unknown" under everything they send.
   */
  it('answers nothing rather than a placeholder', () => {
    expect(memberLabel({ name: { firstName: '  ', lastName: null } })).toBeNull();
    expect(memberLabel({})).toBeNull();
    expect(memberLabel(null)).toBeNull();
  });

  it('attaches each name to the messages that member sent', () => {
    const messages = [
      projectMessage({ id: 'a', direction: 'OUTBOUND', sentById: 'wm-1' }),
      projectMessage({ id: 'b', direction: 'OUTBOUND', sentById: 'wm-2' }),
      projectMessage({ id: 'c', direction: 'INBOUND' }),
    ];

    const named = attachSenderLabels(
      messages,
      new Map([
        ['wm-1', 'Ana Silva'],
        ['wm-2', 'Marcos Lisboa'],
      ]),
    );

    expect(named.map((message) => message.sentByLabel)).toEqual([
      'Ana Silva',
      'Marcos Lisboa',
      null,
    ]);
  });

  /**
   * A campaign or a workflow has no author worth naming, and a member the
   * lookup could not resolve must not inherit the previous message's name —
   * attributing one rep's message to another is worse than showing none.
   */
  it('leaves an unresolved or automated sender unnamed', () => {
    const named = attachSenderLabels(
      [
        projectMessage({ id: 'a', sentById: 'wm-gone' }),
        projectMessage({ id: 'b', sourceKind: 'CAMPAIGN' }),
      ],
      new Map([['wm-1', 'Ana Silva']]),
    );

    expect(named.map((message) => message.sentByLabel)).toEqual([null, null]);
  });
});
