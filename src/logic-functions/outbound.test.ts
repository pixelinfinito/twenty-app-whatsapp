import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  DIRECTION,
  LANE,
  MESSAGE_STATUS,
  MESSAGE_TYPE,
  QUALITY,
  THREAD_STATUS,
} from '../domain/constants';
import { computeSlots, laneRate } from '../domain/pacing';
import { DENIAL, evaluateSendPermission } from '../domain/policy/send-permission';
import type { SendSpec } from '../domain/send-spec';
import type { ResolvedParameters } from '../domain/template-render';
import type { VariableSpec } from '../domain/template-spec';
import { ERROR_CLASS, INTERNAL_ERROR, MetaApiError, classify } from '../providers/whatsapp/errors';
import { cursorValue, laneRatesFor } from '../server/schedule';
import {
  EMPTY_VARIABLE_SPEC,
  MAX_SEND_ATTEMPTS,
  buildOutboundPayload,
  denialErrorCode,
  mediaCacheKey,
  mediaHandleFor,
  previewFor,
  retryDecision,
  sendGuard,
} from './wa-outbound-sender';
import {
  MAX_TEXT_LENGTH,
  messageTypeFor,
  parseClientMessage,
  toSendSpec,
} from './wa-send-message-route';
import { isRedundantLink, statusAfterLink } from './wa-thread-actions-route';
import {
  PROBE_FAILURES_BEFORE_ERROR,
  STALE_CLAIM_MS,
  STUCK_MESSAGE_MS,
  isWebhookStale,
  probeVerdict,
  shouldRollTierWindow,
  stuckAction,
  throughputPerSecond,
} from './wa-health-check';
import {
  MAX_ORPHAN_ATTEMPTS,
  ORPHAN_GRACE_MS,
  ORPHAN_RETRY_DELAY_MS,
  orphansToDefer,
} from './wa-status-processor';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const WA_ID = '244923000000';

describe('the send guard', () => {
  it('proceeds for a queued outbound message', () => {
    expect(
      sendGuard({ status: MESSAGE_STATUS.QUEUED, wamid: null, direction: DIRECTION.OUTBOUND }),
    ).toEqual({ proceed: true });
  });

  /**
   * A WAMID means Meta already has the message, whatever the status column
   * says. It is checked first because it is the stronger fact: a status that
   * disagrees with it is our bookkeeping being behind, not a reason to send
   * again.
   */
  it('refuses a message that already has a WAMID, whatever its status', () => {
    for (const status of [MESSAGE_STATUS.QUEUED, MESSAGE_STATUS.FAILED]) {
      const guard = sendGuard({ status, wamid: 'wamid.HBg', direction: DIRECTION.OUTBOUND });

      expect(guard.proceed, status).toBe(false);
      expect(guard.reason).toContain('already accepted');
    }
  });

  it.each([MESSAGE_STATUS.ACCEPTED, MESSAGE_STATUS.SENT, MESSAGE_STATUS.DELIVERED])(
    'refuses a message already in %s',
    (status) => {
      expect(
        sendGuard({ status, wamid: null, direction: DIRECTION.OUTBOUND }).proceed,
      ).toBe(false);
    },
  );

  /** The queue can deliver the same job twice; that must be free. */
  it('refuses an inbound message', () => {
    expect(
      sendGuard({
        status: MESSAGE_STATUS.QUEUED,
        wamid: null,
        direction: DIRECTION.INBOUND,
      }).proceed,
    ).toBe(false);
  });
});

describe('retrying, and refusing to', () => {
  const retryable = new MetaApiError('rate limited', { code: 130429 });
  const terminal = new MetaApiError('not on whatsapp', { code: 131026 });
  const tokenDead = new MetaApiError('token expired', { code: 190 });
  const ambiguous = new MetaApiError('unknown', { ambiguous: true });

  const decide = (error: MetaApiError, retryCount: number) =>
    retryDecision(error, classify(error), retryCount, () => 1);

  it('retries a backoff-class failure with a growing delay', () => {
    const first = decide(retryable, 0);
    const third = decide(retryable, 2);

    expect(first).toMatchObject({ action: 'retry', attempt: 1 });
    expect(third).toMatchObject({ action: 'retry', attempt: 3 });
    expect(first.action === 'retry' && third.action === 'retry').toBe(true);
    expect(first.action === 'retry' && third.action === 'retry' && third.delayMs).toBeGreaterThan(
      first.action === 'retry' ? first.delayMs : 0,
    );
  });

  it('stops retrying at the attempt cap', () => {
    expect(decide(retryable, MAX_SEND_ATTEMPTS - 1).action).toBe('retry');
    expect(decide(retryable, MAX_SEND_ATTEMPTS).action).toBe('fail');
  });

  it('never retries a terminal recipient error', () => {
    expect(decide(terminal, 0)).toEqual({ action: 'fail', errorCode: '131026' });
  });

  /** A retry with a dead token is noise, not resilience (R-8). */
  it('does not retry an expired token', () => {
    expect(classify(tokenDead).class).toBe(ERROR_CLASS.RETRYABLE_AFTER_REFRESH);
    expect(decide(tokenDead, 0).action).toBe('fail');
  });

  /**
   * The rule the whole design turns on. Meta may have accepted the request, so
   * a retry could deliver a second copy to a real person — and a duplicate
   * customer message is worse than a false failure.
   */
  it('never retries an ambiguous outcome, at any attempt count', () => {
    for (const attempt of [0, 1, 4, 10]) {
      expect(decide(ambiguous, attempt), `attempt ${attempt}`).toEqual({
        action: 'fail',
        errorCode: INTERNAL_ERROR.UNKNOWN_ACCEPTANCE,
      });
    }
  });
});

describe('policy denials become internal error codes', () => {
  it('maps every denial the gate can produce', () => {
    for (const denial of Object.values(DENIAL)) {
      const code = denialErrorCode(denial);

      expect(code, denial).toBeDefined();
      expect(code.startsWith('POLICY_'), `${denial} -> ${code}`).toBe(true);
    }
  });

  /** Distinguishable from Meta's, which are numeric (appendix B §3). */
  it('produces codes no Meta error could collide with', () => {
    for (const denial of Object.values(DENIAL)) {
      expect(Number.isNaN(Number(denialErrorCode(denial)))).toBe(true);
    }
  });
});

describe('building the wire payload', () => {
  it('sends text to the waId with a quoted context', () => {
    expect(
      buildOutboundPayload({
        spec: { kind: 'text', body: 'Olá!', contextWamid: 'wamid.QUOTED' },
        waId: WA_ID,
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: WA_ID,
      type: 'text',
      context: { message_id: 'wamid.QUOTED' },
      text: { body: 'Olá!', preview_url: true },
    });
  });

  it('sends media by id, never by link', () => {
    const payload = buildOutboundPayload({
      spec: { kind: 'media', mediaKind: 'image', caption: 'Proposta' },
      waId: WA_ID,
      mediaId: '1234567890',
    });

    expect(payload).toMatchObject({
      type: 'image',
      image: { id: '1234567890', caption: 'Proposta' },
    });
    expect(JSON.stringify(payload)).not.toContain('link');
  });

  /**
   * Building a media send without a resolved id would produce a payload Meta
   * rejects with a generic error. Throwing keeps the cause where it happened.
   */
  it('refuses to build a media send with no media id', () => {
    expect(() =>
      buildOutboundPayload({
        spec: { kind: 'media', mediaKind: 'image' },
        waId: WA_ID,
      }),
    ).toThrow(/media id/);
  });

  const templateSpec: VariableSpec = {
    ...EMPTY_VARIABLE_SPEC,
    body: {
      variableCount: 2,
      indices: [1, 2],
      names: [],
      text: 'Olá {{1}}, da {{2}}',
      example: [],
    },
    totalVariableCount: 2,
  };

  it('orders body parameters by the spec, not by appearance', () => {
    const payload = buildOutboundPayload({
      spec: { kind: 'template', templateId: 't1' },
      waId: WA_ID,
      template: {
        name: 'proposta_setembro',
        languageCode: 'pt_PT',
        spec: templateSpec,
        parameters: { body: ['Marcos', 'Pixel'], buttons: [] },
      },
    });

    expect(payload.template).toEqual({
      name: 'proposta_setembro',
      language: { code: 'pt_PT' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Marcos' },
            { type: 'text', text: 'Pixel' },
          ],
        },
      ],
    });
  });

  /**
   * The header media id is resolved at send time and injected — a campaign
   * uploads its header image once for the whole audience, so the stored
   * parameters carry a file handle and the wire payload carries Meta's id.
   */
  it('injects a resolved header media id into the template parameters', () => {
    const withHeader: VariableSpec = {
      ...templateSpec,
      header: {
        format: 'IMAGE',
        variableCount: 0,
        indices: [],
        names: [],
        text: null,
        example: [],
      },
    };

    const parameters: ResolvedParameters = {
      header: { kind: 'media', mediaId: null, fileId: 'files/header.png' },
      body: ['Marcos', 'Pixel'],
      buttons: [],
    };

    const payload = buildOutboundPayload({
      spec: { kind: 'template', templateId: 't1' },
      waId: WA_ID,
      template: { name: 't', languageCode: 'pt_PT', spec: withHeader, parameters },
      mediaId: 'META-MEDIA-1',
    });

    expect(payload.template?.components?.[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { id: 'META-MEDIA-1' } }],
    });
  });

  /**
   * D-42. A declared header that produces no parameter used to be dropped from
   * the payload, and Meta answered 132000 — "parameter count mismatch" — for
   * every recipient: an error naming the symptom and hiding the cause.
   */
  it('refuses to build a template whose media header has no id', () => {
    const withHeader: VariableSpec = {
      ...templateSpec,
      header: {
        format: 'IMAGE',
        variableCount: 0,
        indices: [],
        names: [],
        text: null,
        example: [],
      },
    };

    expect(() =>
      buildOutboundPayload({
        spec: { kind: 'template', templateId: 't1' },
        waId: WA_ID,
        template: {
          name: 't',
          languageCode: 'pt_PT',
          spec: withHeader,
          parameters: {
            header: { kind: 'media', mediaId: null, fileId: null },
            body: ['Marcos', 'Pixel'],
            buttons: [],
          },
        },
      }),
    ).toThrow(/no resolved media id/);
  });

  it('refuses to build a template send with no template', () => {
    expect(() =>
      buildOutboundPayload({ spec: { kind: 'template', templateId: 't1' }, waId: WA_ID }),
    ).toThrow(/variable spec/);
  });

  /** A reaction names its target in `message_id`; a context makes Meta reject it. */
  it('builds a reaction with no context block', () => {
    const payload = buildOutboundPayload({
      spec: { kind: 'reaction', targetWamid: 'wamid.TARGET', emoji: '👍' },
      waId: WA_ID,
    });

    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: WA_ID,
      type: 'reaction',
      reaction: { message_id: 'wamid.TARGET', emoji: '👍' },
    });
  });

  it('builds interactive buttons and lists from the stored shape', () => {
    const buttons = buildOutboundPayload({
      spec: {
        kind: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Confirma?' },
          action: { buttons: [{ reply: { id: 'yes', title: 'Sim' } }] },
        },
      },
      waId: WA_ID,
    });

    expect(buttons.interactive).toMatchObject({
      type: 'button',
      action: { buttons: [{ type: 'reply', reply: { id: 'yes', title: 'Sim' } }] },
    });

    const list = buildOutboundPayload({
      spec: {
        kind: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'Escolha' },
          action: { button: 'Ver', sections: [] },
        },
      },
      waId: WA_ID,
    });

    expect(list.interactive).toMatchObject({ type: 'list', action: { button: 'Ver' } });
  });

  it('builds a location', () => {
    expect(
      buildOutboundPayload({
        spec: { kind: 'location', latitude: -8.83, longitude: 13.23, name: 'Pixel' },
        waId: WA_ID,
      }).location,
    ).toEqual({ latitude: -8.83, longitude: 13.23, name: 'Pixel' });
  });

  /**
   * FR-CID-2: every builder addresses the `waId`. For Argentina and Mexico the
   * dialable form differs and produces *silent* non-delivery — an error with no
   * error — so this is asserted across the whole set rather than per builder.
   */
  it('addresses the waId in every kind', () => {
    const specs: SendSpec[] = [
      { kind: 'text', body: 'x' },
      { kind: 'media', mediaKind: 'image' },
      { kind: 'reaction', targetWamid: 'w', emoji: '👍' },
      { kind: 'location', latitude: 1, longitude: 2 },
      { kind: 'contacts', contacts: [] },
      { kind: 'interactive', interactive: { type: 'button', body: { text: 'x' }, action: { buttons: [{ reply: { id: 'a', title: 'A' } }] } } },
    ];

    for (const spec of specs) {
      const payload = buildOutboundPayload({ spec, waId: WA_ID, mediaId: 'm1' });

      expect(payload.to, spec.kind).toBe(WA_ID);
      expect(payload.messaging_product).toBe('whatsapp');
    }
  });
});

describe('deciding what needs a media upload', () => {
  it('needs one for a media send', () => {
    expect(
      mediaHandleFor({ kind: 'media', mediaKind: 'video', filePath: 'files/a.mp4' }, null),
    ).toMatchObject({ kind: 'video', path: 'files/a.mp4' });
  });

  it('needs none for text', () => {
    expect(mediaHandleFor({ kind: 'text', body: 'x' }, null)).toBeNull();
  });

  /** A campaign resolves its header once at snapshot time, not per recipient. */
  it('needs none when the template header id is already resolved', () => {
    const template = {
      name: 't',
      languageCode: 'pt_PT',
      spec: {
        ...EMPTY_VARIABLE_SPEC,
        header: {
          format: 'IMAGE' as const,
          variableCount: 0,
          indices: [],
          names: [],
          text: null,
          example: [],
        },
      },
      parameters: {
        header: { kind: 'media' as const, mediaId: 'META-1', fileId: null },
        body: [],
        buttons: [],
      },
    };

    expect(mediaHandleFor({ kind: 'template', templateId: 't1' }, template)).toBeNull();
  });

  /**
   * A media header stored as a file handle is uploaded at send time, and the
   * kind follows the template's declared header format — sending an mp4 as
   * `image` is rejected by Meta with an error naming neither.
   */
  it('needs one for a template header still in storage, typed by its format', () => {
    const template = {
      name: 't',
      languageCode: 'pt_PT',
      spec: {
        ...EMPTY_VARIABLE_SPEC,
        header: {
          format: 'VIDEO' as const,
          variableCount: 0,
          indices: [],
          names: [],
          text: null,
          example: [],
        },
      },
      parameters: {
        header: {
          kind: 'media' as const,
          mediaId: null,
          fileId: 'file-record-1',
          filePath: 'files/promo.mp4',
        },
        body: [],
        buttons: [],
      },
    };

    expect(mediaHandleFor({ kind: 'template', templateId: 't1' }, template)).toEqual({
      kind: 'video',
      fileId: 'file-record-1',
      url: null,
      path: 'files/promo.mp4',
    });
  });

  it('needs none for a text-header template', () => {
    const template = {
      name: 't',
      languageCode: 'pt_PT',
      spec: EMPTY_VARIABLE_SPEC,
      parameters: {
        header: { kind: 'text' as const, values: ['Olá'] },
        body: [],
        buttons: [],
      },
    };

    expect(mediaHandleFor({ kind: 'template', templateId: 't1' }, template)).toBeNull();
  });

  /** Keyed by content, so one image attached to 5 000 recipients is one upload. */
  it('keys the upload cache by digest', () => {
    expect(mediaCacheKey('abc123')).toBe('wa:media-upload:abc123');
  });
});

describe('the outbound preview', () => {
  it.each([
    [{ kind: 'text', body: 'Olá Marcos' } as SendSpec, 'Olá Marcos'],
    [{ kind: 'media', mediaKind: 'image' } as SendSpec, '📷 Imagem'],
    [{ kind: 'media', mediaKind: 'image', caption: 'Proposta' } as SendSpec, '📷 Imagem · Proposta'],
    [{ kind: 'reaction', targetWamid: 'w', emoji: '👍' } as SendSpec, '👍'],
    [{ kind: 'location', latitude: 1, longitude: 2, name: 'Sede' } as SendSpec, '📍 Sede'],
  ])('renders %o as %p', (spec, expected) => {
    expect(previewFor(spec, { body: null, templateName: null })).toBe(expected);
  });

  it('shows the template name rather than a raw body', () => {
    expect(
      previewFor({ kind: 'template', templateId: 't' }, { body: null, templateName: 'proposta' }),
    ).toBe('proposta');
  });

  it('collapses whitespace and truncates at 120 characters', () => {
    const preview = previewFor(
      { kind: 'text', body: `linha1\n\n   linha2 ${'x'.repeat(200)}` },
      { body: null, templateName: null },
    );

    expect(preview.length).toBe(120);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview).not.toContain('\n');
  });
});

describe('parsing what the composer sends', () => {
  it('accepts a text message', () => {
    const result = parseClientMessage({ kind: 'text', body: 'Olá' });

    expect(result).toEqual({
      ok: true,
      message: { kind: 'text', body: 'Olá', contextWamid: null },
    });
  });

  it.each([
    ['a missing body', { kind: 'text' }],
    ['an empty body', { kind: 'text', body: '   ' }],
    ['an unknown kind', { kind: 'carousel' }],
    ['no kind at all', {}],
    ['a string instead of an object', 'text'],
    ['null', null],
    ['a media send with no handle', { kind: 'media', mediaKind: 'image' }],
    ['an unknown media kind', { kind: 'media', mediaKind: 'hologram', filePath: 'x' }],
    ['a template with no id', { kind: 'template' }],
    ['a reaction with no target', { kind: 'reaction', emoji: '👍' }],
    ['interactive with no object', { kind: 'interactive', interactive: 'buttons' }],
    ['a location with no coordinates', { kind: 'location' }],
  ])('rejects %s', (_label, body) => {
    expect(parseClientMessage(body).ok).toBe(false);
  });

  it('rejects text over WhatsApp’s own ceiling rather than truncating it', () => {
    const result = parseClientMessage({ kind: 'text', body: 'x'.repeat(MAX_TEXT_LENGTH + 1) });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(String(MAX_TEXT_LENGTH));
  });

  /**
   * An empty emoji is not a missing field — it is how a reaction is *removed*,
   * through the same call rather than a delete endpoint.
   */
  it('accepts an empty emoji as a reaction removal', () => {
    const result = parseClientMessage({ kind: 'reaction', targetWamid: 'wamid.X', emoji: '' });

    expect(result).toEqual({
      ok: true,
      message: { kind: 'reaction', targetWamid: 'wamid.X', emoji: '' },
    });
  });

  /**
   * The route used to queue any non-null `interactive` object. The message
   * then failed inside the sender, minutes later, with a Meta error nobody
   * could map back to a field — and the builder that could have corrected it
   * was long gone.
   */
  it('refuses an invalid interactive message with the field that caused it', () => {
    const result = parseClientMessage({
      kind: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Confirma?' },
        action: {
          buttons: [{ type: 'reply', reply: { id: 'b1', title: 'x'.repeat(30) } }],
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('INTERACTIVE_INVALID');
    expect(result.ok === false && result.fields).toEqual([
      { field: 'action.buttons.0.reply.title', code: 'TOO_LONG', limit: 20 },
    ]);
  });

  it('accepts a well-formed quick-reply message', () => {
    expect(
      parseClientMessage({
        kind: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Confirma a morada?' },
          action: { buttons: [{ type: 'reply', reply: { id: 'b1', title: 'Sim' } }] },
        },
      }).ok,
    ).toBe(true);
  });

  /**
   * A transposed coordinate pair is accepted by Meta and sends the customer to
   * a point in the Atlantic — the silent failure FR-CID-2 treats as the worst
   * kind.
   */
  it('rejects coordinates outside the range a point on Earth can have', () => {
    expect(parseClientMessage({ kind: 'location', latitude: 91, longitude: 13 }).ok).toBe(
      false,
    );
    expect(
      parseClientMessage({ kind: 'location', latitude: -8.9126, longitude: 13.2334 }).ok,
    ).toBe(true);
  });

  it('accepts a contact card only when it names somebody', () => {
    expect(
      parseClientMessage({
        kind: 'contacts',
        contacts: [{ name: { formatted_name: 'Abel Febere' } }],
      }).ok,
    ).toBe(true);

    expect(parseClientMessage({ kind: 'contacts', contacts: [{ phones: [] }] }).ok).toBe(
      false,
    );
    expect(parseClientMessage({ kind: 'contacts', contacts: [] }).ok).toBe(false);
  });

  /**
   * Only audio can be a voice note. Accepting the flag on an image would store
   * a lie the transcript then renders — a photo with a microphone label.
   */
  it('keeps the voice flag on audio and drops it everywhere else', () => {
    const voice = parseClientMessage({
      kind: 'media',
      mediaKind: 'audio',
      filePath: 'x',
      voice: true,
    });
    const photo = parseClientMessage({
      kind: 'media',
      mediaKind: 'image',
      filePath: 'x',
      voice: true,
    });

    expect(voice.ok === true && voice.message).toMatchObject({ voice: true });
    expect(photo.ok === true && photo.message).toMatchObject({ voice: false });
  });

  /**
   * With the window closed a template is the *only* send available, which is
   * exactly when a rep most needs to say which message they are answering.
   * `buildTemplatePayload` has carried `context` since it was written; nothing
   * passed it, so choosing Reply and then sending a template dropped the quote.
   */
  it('carries a reply target on a template send', () => {
    const result = parseClientMessage({
      kind: 'template',
      templateId: 't1',
      contextWamid: 'wamid.PARENT',
    });

    expect(result.ok === true && result.message).toMatchObject({
      kind: 'template',
      contextWamid: 'wamid.PARENT',
    });

    expect(
      toSendSpec({
        kind: 'template',
        templateId: 't1',
        parameters: { body: [], buttons: [] },
        contextWamid: 'wamid.PARENT',
      }),
    ).toEqual({
      kind: 'template',
      templateId: 't1',
      contextWamid: 'wamid.PARENT',
    });
  });

  it('defaults template parameters and rejects a non-array body', () => {
    expect(parseClientMessage({ kind: 'template', templateId: 't1' }).ok).toBe(true);
    expect(
      parseClientMessage({ kind: 'template', templateId: 't1', parameters: { body: 'Marcos' } }).ok,
    ).toBe(false);
  });

  it('maps each kind to the stored message type', () => {
    expect(messageTypeFor({ kind: 'text', body: 'x' })).toBe(MESSAGE_TYPE.TEXT);
    expect(messageTypeFor({ kind: 'media', mediaKind: 'video', filePath: 'x' })).toBe(
      MESSAGE_TYPE.VIDEO,
    );
    expect(messageTypeFor({ kind: 'template', templateId: 't', parameters: { body: [], buttons: [] } })).toBe(
      MESSAGE_TYPE.TEMPLATE,
    );
    expect(messageTypeFor({ kind: 'reaction', targetWamid: 'w', emoji: '👍' })).toBe(
      MESSAGE_TYPE.REACTION,
    );
  });

  /**
   * The stored spec must not carry the template parameters: those live in their
   * own column, and duplicating them would let the two disagree after a
   * re-render.
   */
  it('stores a template send as an id alone', () => {
    expect(
      toSendSpec({ kind: 'template', templateId: 't1', parameters: { body: ['a'], buttons: [] } }),
    ).toEqual({ kind: 'template', templateId: 't1' });
  });
});

describe('the two lanes', () => {
  const account = {
    id: 'acc-1',
    sendThrottlePerSecond: 20,
    interactiveCursorAt: null,
    campaignCursorAt: null,
  };

  it('reserves a minimum for interactive however small the share', () => {
    process.env.WA_INTERACTIVE_LANE_SHARE = '0.1';

    expect(laneRate(LANE.INTERACTIVE, laneRatesFor({ ...account, sendThrottlePerSecond: 10 }))).toBe(
      5,
    );
  });

  /**
   * D-29. The lanes are a division of the account's ceiling, so they must add
   * up to it — no more, or the pacing that exists to keep us under Meta's limit
   * is handing out permission to exceed our own.
   */
  it.each([1, 2, 3, 5, 8, 10, 20, 50, 80])(
    'divides a ceiling of %s between the lanes without inventing capacity',
    (throttle) => {
      const rates = laneRatesFor({ ...account, sendThrottlePerSecond: throttle });
      const interactive = laneRate(LANE.INTERACTIVE, rates);
      const campaign = laneRate(LANE.CAMPAIGN, rates);

      expect(interactive + campaign).toBeCloseTo(throttle, 10);
      expect(campaign).toBeGreaterThan(0);
      expect(interactive).toBeGreaterThan(0);
    },
  );

  /** A tiny ceiling still favours the person waiting, without starving campaigns. */
  it('prefers interactive when the floor does not fit', () => {
    const rates = laneRatesFor({ ...account, sendThrottlePerSecond: 3 });

    expect(laneRate(LANE.INTERACTIVE, rates)).toBe(2);
    expect(laneRate(LANE.CAMPAIGN, rates)).toBe(1);
  });

  it('reads the account throttle in preference to the variable', () => {
    process.env.WA_SEND_THROTTLE_PER_SECOND = '50';

    expect(laneRatesFor({ ...account, sendThrottlePerSecond: 8 }).throttlePerSecond).toBe(8);
    expect(laneRatesFor({ ...account, sendThrottlePerSecond: null }).throttlePerSecond).toBe(50);
  });

  /**
   * NFR-S5, structurally. A campaign that has booked the next four minutes of
   * its own lane must leave an interactive reply able to go out now — which
   * holds because the two never read the same cursor.
   */
  it('lets an interactive send ignore a saturated campaign cursor', () => {
    const now = 1_800_000_000_000;
    const busy = {
      ...account,
      campaignCursorAt: new Date(now + 4 * 60_000).toISOString(),
      interactiveCursorAt: null,
    };

    const rates = laneRatesFor(busy);

    const interactive = computeSlots({
      cursorAt: cursorValue(busy, LANE.INTERACTIVE),
      now,
      count: 1,
      ratePerSecond: laneRate(LANE.INTERACTIVE, rates),
    });

    const campaign = computeSlots({
      cursorAt: cursorValue(busy, LANE.CAMPAIGN),
      now,
      count: 1,
      ratePerSecond: laneRate(LANE.CAMPAIGN, rates),
    });

    expect(interactive.slots[0]).toBe(now);
    expect(campaign.slots[0]).toBeGreaterThan(now + 3 * 60_000);
  });

  it('reads a cursor from either column and tolerates an unset one', () => {
    const at = new Date('2026-08-16T10:00:00.000Z');

    expect(
      cursorValue({ ...account, interactiveCursorAt: at.toISOString() }, LANE.INTERACTIVE),
    ).toBe(at.getTime());
    expect(cursorValue(account, LANE.CAMPAIGN)).toBeNull();
    expect(cursorValue({ ...account, campaignCursorAt: 'not a date' }, LANE.CAMPAIGN)).toBeNull();
  });
});

describe('the policy gate as the sender re-runs it', () => {
  const base = {
    now: new Date('2026-08-16T12:00:00.000Z'),
    thread: { serviceWindowExpiresAt: new Date('2026-08-16T13:00:00.000Z'), isBlocked: false },
    person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_IN },
    account: { status: ACCOUNT_STATUS.CONNECTED, qualityRating: QUALITY.GREEN },
  };

  /**
   * The defect this re-check exists for: a campaign queued while the window was
   * open, sent after it closed. The composer's verdict was correct when it was
   * made and is wrong by the time the job runs.
   */
  it('denies a free-form send whose window closed while it was queued', () => {
    const atQueueTime = evaluateSendPermission(
      { kind: 'FREEFORM', lane: LANE.INTERACTIVE },
      base,
    );

    const atSendTime = evaluateSendPermission(
      { kind: 'FREEFORM', lane: LANE.INTERACTIVE },
      { ...base, now: new Date('2026-08-16T14:00:00.000Z') },
    );

    expect(atQueueTime.allowed).toBe(true);
    expect(atSendTime).toMatchObject({ allowed: false, reason: DENIAL.WINDOW_CLOSED });
  });

  it('denies a send to someone who opted out after it was queued', () => {
    const verdict = evaluateSendPermission(
      { kind: 'TEMPLATE', lane: LANE.INTERACTIVE },
      { ...base, person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_OUT } },
    );

    expect(verdict).toMatchObject({ allowed: false, reason: DENIAL.OPTED_OUT });
  });

  it('still lets a rep answer inside an open window after an opt-out', () => {
    expect(
      evaluateSendPermission(
        { kind: 'FREEFORM', lane: LANE.INTERACTIVE },
        { ...base, person: { whatsappOptInStatus: CONSENT_STATUS.OPTED_OUT } },
      ).allowed,
    ).toBe(true);
  });
});

describe('re-linking a conversation', () => {
  /** Resolving the ambiguity is what clears the review banner (FR-CID-5). */
  it('opens a needs-review thread once a person is chosen', () => {
    expect(statusAfterLink(THREAD_STATUS.NEEDS_REVIEW, 'person-1')).toBe(THREAD_STATUS.OPEN);
  });

  it('leaves a needs-review thread in review when the link is cleared', () => {
    expect(statusAfterLink(THREAD_STATUS.NEEDS_REVIEW, null)).toBeNull();
  });

  /**
   * Fixing an attribution is not reopening a conversation. A closed thread that
   * silently reopened would reappear in an inbox a rep had finished with.
   */
  it.each([THREAD_STATUS.OPEN, THREAD_STATUS.CLOSED, THREAD_STATUS.AWAITING_REPLY])(
    'leaves a %s thread’s status alone',
    (status) => {
      expect(statusAfterLink(status, 'person-2')).toBeNull();
    },
  );

  /**
   * D-67. Linking to the contact a conversation is already linked to wrote two
   * timeline activities describing a move that did not happen, plus Twenty's
   * own relation entry — which is how a Person's timeline filled with repeated
   * "linked a whatsapp conversation" lines carrying no information.
   */
  it('treats a link to the same person as nothing at all', () => {
    expect(isRedundantLink({ personId: 'p-1', status: THREAD_STATUS.OPEN }, 'p-1')).toBe(true);
  });

  it('treats unlinking an already-unlinked conversation as nothing at all', () => {
    expect(isRedundantLink({ personId: null, status: THREAD_STATUS.OPEN }, null)).toBe(true);
  });

  it.each([
    ['a different person', { personId: 'p-1', status: THREAD_STATUS.OPEN }, 'p-2'],
    ['a first link', { personId: null, status: THREAD_STATUS.OPEN }, 'p-2'],
    ['an unlink', { personId: 'p-1', status: THREAD_STATUS.OPEN }, null],
  ])('is a real change for %s', (_label, thread, personId) => {
    expect(isRedundantLink(thread, personId)).toBe(false);
  });

  /** Resolving the review *is* the change, even when the person is the same. */
  it('is a real change while the thread awaits review', () => {
    expect(
      isRedundantLink({ personId: 'p-1', status: THREAD_STATUS.NEEDS_REVIEW }, 'p-1'),
    ).toBe(false);
  });
});

describe('the hourly health check', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');

  /**
   * A number connected this morning that nobody has messaged is not broken.
   * Reporting it would teach the operator to ignore the only alerting channel
   * the platform gives us.
   */
  it('does not call a never-used webhook stale', () => {
    expect(isWebhookStale({ lastEventAt: null, now, stalenessHours: 24 })).toBe(false);
  });

  it('calls a webhook stale once it passes the threshold', () => {
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

    expect(isWebhookStale({ lastEventAt: hoursAgo(23), now, stalenessHours: 24 })).toBe(false);
    expect(isWebhookStale({ lastEventAt: hoursAgo(25), now, stalenessHours: 24 })).toBe(true);
  });

  it('rolls the tier window after 24 hours, and on a fresh account', () => {
    expect(shouldRollTierWindow({ startedAt: null, now })).toBe(true);
    expect(
      shouldRollTierWindow({ startedAt: new Date(now.getTime() - 23 * 3_600_000), now }),
    ).toBe(false);
    expect(
      shouldRollTierWindow({ startedAt: new Date(now.getTime() - 25 * 3_600_000), now }),
    ).toBe(true);
  });

  /**
   * Re-enqueue once, then fail. Recorded on `statusTimestamps` so it survives a
   * cache eviction and an operator can see the system already tried.
   */
  it('re-enqueues a stuck message once and fails it the second time', () => {
    expect(stuckAction({ statusTimestamps: {} })).toBe('requeue');
    expect(stuckAction({ statusTimestamps: null })).toBe('requeue');
    expect(stuckAction({ statusTimestamps: { requeuedAt: 1_786_810_070 } })).toBe('fail');
  });

  it('reads Meta’s throughput level as a number, and leaves an unknown one alone', () => {
    expect(throughputPerSecond('STANDARD')).toBe(80);
    expect(throughputPerSecond('high')).toBe(1000);
    expect(throughputPerSecond('EXTREME')).toBeNull();
    expect(throughputPerSecond(null)).toBeNull();
  });

  it('gives a stuck message longer than a stale claim', () => {
    expect(STUCK_MESSAGE_MS).toBeGreaterThan(STALE_CLAIM_MS);
  });

  /**
   * D-31. `ERROR` is read by the policy gate as "send nothing", so deciding it
   * from a single failed probe meant one refused connection to Meta silenced a
   * working number for an hour — an outage produced by the monitoring itself.
   */
  describe('what a failed probe decides', () => {
    const transient = new MetaApiError('Meta is having a moment', { httpStatus: 503 });
    const credential = new MetaApiError('Bad token', { httpStatus: 401 });

    it('keeps sending through the first transient failures', () => {
      expect(probeVerdict(transient, 0)).toBe('degraded');
      expect(probeVerdict(transient, 1)).toBe('degraded');
      expect(probeVerdict(transient, 2)).toBe('degraded');
    });

    it('stops the account once a transient failure stops being transient', () => {
      expect(probeVerdict(transient, PROBE_FAILURES_BEFORE_ERROR)).toBe('error');
    });

    /** A rejected credential is about the account, not about the minute. */
    it('stops the account immediately on a rejected credential', () => {
      expect(probeVerdict(credential, 0)).toBe('error');
    });

    it('stops the account on an error it cannot classify', () => {
      expect(probeVerdict(new Error('something else entirely'), 0)).toBe('error');
    });
  });
});

/**
 * D-30. The grace window was computed, logged as `retryable`, and then the
 * status was dropped — the webhook event was marked `PROCESSED` regardless. A
 * `delivered` that beat our own POST response was lost, and its message went on
 * reporting `accepted` for ever.
 */
describe('statuses that arrive before their message', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');
  const at = (secondsAgo: number) => ({
    id: `wamid.${secondsAgo}`,
    status: 'delivered',
    timestamp: String(Math.floor(now.getTime() / 1000) - secondsAgo),
  });

  it('hands on a status still inside the grace window', () => {
    expect(orphansToDefer([at(10)], 0, now)).toHaveLength(1);
  });

  it('gives up on one older than the window', () => {
    expect(orphansToDefer([at(10 * 60)], 0, now)).toEqual([]);
  });

  it('gives up after the attempt cap, however recent', () => {
    expect(orphansToDefer([at(1)], MAX_ORPHAN_ATTEMPTS, now)).toEqual([]);
  });

  /** The retries have to fit inside the window, or the cap decides nothing. */
  it('retries within the grace window it is capped by', () => {
    expect(MAX_ORPHAN_ATTEMPTS * ORPHAN_RETRY_DELAY_MS).toBeLessThan(ORPHAN_GRACE_MS);
  });
});
