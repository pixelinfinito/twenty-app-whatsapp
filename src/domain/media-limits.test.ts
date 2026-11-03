import { describe, expect, it } from 'vitest';

import {
  MEDIA_LIMITS,
  MEDIA_REJECTION,
  mediaKindForHeaderFormat,
  normaliseMimeType,
  validateOutboundMedia,
} from './media-limits';

const MB = 1024 * 1024;

describe('outbound media limits', () => {
  it('rejects empty or invalid downloaded sizes before sending', () => {
    for (const sizeBytes of [0, -1, Number.NaN]) {
      expect(validateOutboundMedia({ kind: 'document', mimeType: 'application/pdf', sizeBytes }).ok).toBe(false);
    }
  });
  it('accepts a jpeg photo under 5 MB', () => {
    expect(
      validateOutboundMedia({ kind: 'image', mimeType: 'image/jpeg', sizeBytes: 4 * MB }),
    ).toEqual({ ok: true });
  });

  /**
   * The limit people get wrong: an image is 5 MB, not the 16 MB of audio and
   * video. A phone photo from a modern camera clears it easily.
   */
  it('rejects a 12 MB photo that would pass a video-sized assumption', () => {
    const result = validateOutboundMedia({
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 12 * MB,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(MEDIA_REJECTION.TOO_LARGE);
    expect(
      validateOutboundMedia({ kind: 'video', mimeType: 'video/mp4', sizeBytes: 12 * MB }).ok,
    ).toBe(true);
  });

  /** The same bytes are a valid sticker and an invalid image. */
  it('rejects webp as an image and accepts it as a sticker', () => {
    expect(
      validateOutboundMedia({ kind: 'image', mimeType: 'image/webp', sizeBytes: 50_000 }).ok,
    ).toBe(false);
    expect(
      validateOutboundMedia({ kind: 'sticker', mimeType: 'image/webp', sizeBytes: 50_000 }).ok,
    ).toBe(true);
  });

  it('names the accepted types when the type is wrong', () => {
    const result = validateOutboundMedia({
      kind: 'image',
      mimeType: 'image/gif',
      sizeBytes: 1000,
    });

    expect(result.ok === false && result.reason).toBe(MEDIA_REJECTION.WRONG_TYPE);
    expect(result.ok === false && result.detail).toContain('image/jpeg');
  });

  /** A document is any type — an allow-list there would block ordinary work. */
  it('accepts any mime type for a document', () => {
    for (const mimeType of ['application/pdf', 'application/vnd.ms-excel', 'text/csv']) {
      expect(
        validateOutboundMedia({ kind: 'document', mimeType, sizeBytes: 2 * MB }).ok,
        mimeType,
      ).toBe(true);
    }
  });

  it('parses a mime type with parameters and odd casing', () => {
    expect(normaliseMimeType('IMAGE/JPEG; charset=binary')).toBe('image/jpeg');
    expect(normaliseMimeType(null)).toBe('');
  });

  /**
   * An unknown sticker is measured against the animated ceiling: telling the
   * two apart means decoding the WebP container, and rejecting a legitimate
   * animated sticker for want of a header parse is the worse error.
   */
  it('measures an unknown sticker against the animated ceiling', () => {
    expect(
      validateOutboundMedia({ kind: 'sticker', mimeType: 'image/webp', sizeBytes: 300_000 }).ok,
    ).toBe(true);

    expect(
      validateOutboundMedia({
        kind: 'sticker',
        mimeType: 'image/webp',
        sizeBytes: 300_000,
        isAnimatedSticker: false,
      }).ok,
    ).toBe(false);
  });

  it('rejects a kind WhatsApp has no concept of', () => {
    const result = validateOutboundMedia({
      kind: 'spreadsheet',
      mimeType: 'text/csv',
      sizeBytes: 10,
    });

    expect(result.ok === false && result.reason).toBe(MEDIA_REJECTION.UNKNOWN_KIND);
  });

  /**
   * D-36. The kind arrives in a request body, and every object inherits
   * `constructor`, `toString` and friends — so a bare lookup answered with a
   * function instead of `undefined`, walked past the unknown-kind branch, and
   * threw on `limit.mimeTypes.length`.
   */
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'rejects %s as a media kind instead of throwing',
    (kind) => {
      const result = validateOutboundMedia({ kind, mimeType: 'image/jpeg', sizeBytes: 10 });

      expect(result.ok === false && result.reason).toBe(MEDIA_REJECTION.UNKNOWN_KIND);
    },
  );

  it('states each limit exactly once', () => {
    expect(MEDIA_LIMITS.image.maxBytes).toBe(5 * MB);
    expect(MEDIA_LIMITS.audio.maxBytes).toBe(16 * MB);
    expect(MEDIA_LIMITS.video.maxBytes).toBe(16 * MB);
    expect(MEDIA_LIMITS.document.maxBytes).toBe(100 * MB);
  });
});

describe('template header formats', () => {
  it.each([
    ['IMAGE', 'image'],
    ['VIDEO', 'video'],
    ['DOCUMENT', 'document'],
  ])('maps %s to %s', (format, kind) => {
    expect(mediaKindForHeaderFormat(format)).toBe(kind);
  });

  it.each(['TEXT', 'LOCATION', '', null, undefined])(
    'has no media kind for %p',
    (format) => {
      expect(mediaKindForHeaderFormat(format)).toBeNull();
    },
  );
});
