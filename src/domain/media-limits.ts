/**
 * Outbound media validation (AR-16, appendix A §3).
 *
 * Meta's limits differ per kind and are stricter than most people expect —
 * an image is 5 MB, not the 16 MB of audio and video. Checking here rather
 * than letting Meta answer matters because the failure arrives *after* the
 * upload: a 12 MB photo would be read from storage, pushed to Meta's media
 * endpoint, and only then rejected, having spent the time and the bandwidth of
 * a successful send to produce an error.
 *
 * The mime allow-list is equally deliberate. WhatsApp accepts only jpeg and png
 * as `image`; a webp sent as an image is rejected, while the same bytes sent as
 * a `sticker` are fine. Naming the kind wrong is the most common composer bug
 * and it is worth a specific message rather than Meta's 131051.
 */

const MB = 1024 * 1024;

export type OutboundMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export type MediaLimit = {
  maxBytes: number;
  /** Empty means any type is accepted (documents). */
  mimeTypes: string[];
};

export const MEDIA_LIMITS: Record<OutboundMediaKind, MediaLimit> = {
  image: { maxBytes: 5 * MB, mimeTypes: ['image/jpeg', 'image/png'] },
  audio: {
    maxBytes: 16 * MB,
    mimeTypes: [
      'audio/aac',
      'audio/amr',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'audio/opus',
    ],
  },
  video: { maxBytes: 16 * MB, mimeTypes: ['video/mp4', 'video/3gpp'] },
  document: { maxBytes: 100 * MB, mimeTypes: [] },
  /**
   * 100 KB static, 500 KB animated. Distinguishing them means decoding the
   * WebP container for an `ANIM` chunk, so an unknown sticker is measured
   * against the higher ceiling: rejecting a legitimate animated sticker for
   * lack of a header parse would be the worse error, and Meta's own rejection
   * of an oversized static one is specific enough to act on.
   */
  sticker: { maxBytes: 500 * 1024, mimeTypes: ['image/webp'] },
};

export const MEDIA_REJECTION = {
  TOO_LARGE: 'MEDIA_TOO_LARGE',
  WRONG_TYPE: 'MEDIA_WRONG_TYPE',
  UNKNOWN_KIND: 'MEDIA_UNKNOWN_KIND',
} as const;
export type MediaRejection = (typeof MEDIA_REJECTION)[keyof typeof MEDIA_REJECTION];

export type MediaValidation =
  | { ok: true }
  | { ok: false; reason: MediaRejection; detail: string };

/** `image/jpeg; charset=binary` and `IMAGE/JPEG` both denote `image/jpeg`. */
export const normaliseMimeType = (raw: string | null | undefined): string =>
  (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

export const validateOutboundMedia = ({
  kind,
  mimeType,
  sizeBytes,
  isAnimatedSticker,
}: {
  kind: string;
  mimeType: string | null | undefined;
  sizeBytes: number;
  isAnimatedSticker?: boolean;
}): MediaValidation => {
  /**
   * `Object.hasOwn`, not a bare lookup: `MEDIA_LIMITS['constructor']` answers
   * with a function rather than `undefined`, so a media kind of `constructor`
   * or `toString` — and the kind arrives from a request body — sailed past the
   * unknown-kind branch and threw on `limit.mimeTypes.length` (D-36).
   */
  const limit = Object.prototype.hasOwnProperty.call(MEDIA_LIMITS, kind)
    ? MEDIA_LIMITS[kind as OutboundMediaKind]
    : undefined;

  if (limit === undefined) {
    return {
      ok: false,
      reason: MEDIA_REJECTION.UNKNOWN_KIND,
      detail: `Unsupported media kind "${kind}"`,
    };
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return {
      ok: false,
      reason: MEDIA_REJECTION.WRONG_TYPE,
      detail: 'The attachment is empty or has an invalid size',
    };
  }

  const mime = normaliseMimeType(mimeType);

  if (limit.mimeTypes.length > 0 && !limit.mimeTypes.includes(mime)) {
    return {
      ok: false,
      reason: MEDIA_REJECTION.WRONG_TYPE,
      detail: `WhatsApp accepts ${limit.mimeTypes.join(', ')} as ${kind}, received ${mime || 'an unknown type'}`,
    };
  }

  const maxBytes =
    kind === 'sticker' && isAnimatedSticker === false ? 100 * 1024 : limit.maxBytes;

  if (sizeBytes > maxBytes) {
    return {
      ok: false,
      reason: MEDIA_REJECTION.TOO_LARGE,
      detail: `${sizeBytes} bytes exceeds the ${maxBytes}-byte limit for ${kind}`,
    };
  }

  return { ok: true };
};

/**
 * The header format a template declares maps onto a media kind. `spec.header.format`
 * speaks Meta's uppercase component language; the send payload speaks lowercase
 * type names, and the two are joined here rather than at four call sites.
 */
export const mediaKindForHeaderFormat = (
  format: string | null | undefined,
): 'image' | 'video' | 'document' | null => {
  switch ((format ?? '').toUpperCase()) {
    case 'IMAGE':
      return 'image';
    case 'VIDEO':
      return 'video';
    case 'DOCUMENT':
      return 'document';
    default:
      return null;
  }
};
