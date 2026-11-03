/**
 * What a renderer needs to know about an attachment (specs/08 §2).
 *
 * Split out of `projection.ts` so `content.ts` can name it without the two
 * modules importing each other — `projection.ts` builds the union, the union
 * references the media, and a cycle between them is the kind of thing that
 * works until a bundler reorders the modules.
 *
 * The shape grew when the renderer registry arrived. `kind`, `url` and a size
 * were enough for "a link and maybe an `<img>`"; they are not enough to tell a
 * voice note from an MP3 somebody attached, to reserve the right box for a
 * portrait video before it loads, or to say how long a recording is without
 * downloading it. Every field below is read from stored media meta on the
 * server, never re-derived in the browser (AR-17).
 */
export type MediaProjection = {
  fileId?: string | null;
  kind: string | null;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  /** Signed, short-lived, and only ever handed to an authenticated caller. */
  url: string | null;
  /** D-8: too large to have been fetched automatically; the UI offers a download. */
  deferred: boolean;
  downloadFailed: boolean;
  /**
   * A recording, not a music file.
   *
   * Meta sets `voice: true` on audio captured with the microphone, and the two
   * deserve different cards: a voice note is a turn in the conversation, an
   * attached MP3 is a file. Both used to render as the same bare `<audio>`.
   */
  isVoice: boolean;
  /** Stickers Meta marks as animated; rendered without the still-image treatment. */
  isAnimated: boolean;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
};

export const EMPTY_MEDIA: MediaProjection = {
  kind: null,
  mimeType: null,
  fileName: null,
  sizeBytes: null,
  url: null,
  deferred: false,
  downloadFailed: false,
  isVoice: false,
  isAnimated: false,
  durationSeconds: null,
  width: null,
  height: null,
};

/**
 * What the media *actually is*, as opposed to the type Meta labelled it.
 *
 * An audio file sent from the device's document picker arrives as
 * `type: document` with `mime_type: audio/mpeg` (observed 2026-08-15), and a
 * renderer keyed on the stored `messageType` alone gives it a download link.
 * The same rule lives in `inbound-normalise` for the thread preview; this is
 * its projection-side twin, working from what the projection actually carries.
 */
export const effectiveKind = (
  media: MediaProjection | null,
): 'image' | 'video' | 'audio' | 'sticker' | 'file' | null => {
  if (media === null) return null;

  const kind = media.kind ?? '';

  if (kind === 'STICKER') return 'sticker';

  const mime = media.mimeType ?? '';

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  if (kind === 'IMAGE') return 'image';
  if (kind === 'VIDEO') return 'video';
  if (kind === 'AUDIO') return 'audio';

  return 'file';
};

/**
 * The icon family a document should wear, as a key the icon map owns.
 *
 * Returning a key rather than a component keeps this pure and testable, and
 * keeps the one place that decides "which picture means which thing"
 * (`icons.tsx`) unchallenged.
 */
export const documentFamily = (
  media: MediaProjection | null,
): 'pdf' | 'sheet' | 'doc' | 'slides' | 'archive' | 'code' | 'file' => {
  const mime = (media?.mimeType ?? '').toLowerCase();
  const name = (media?.fileName ?? '').toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.includes('spreadsheet') || ['xls', 'xlsx', 'csv', 'ods'].includes(extension)) {
    return 'sheet';
  }
  if (mime.includes('presentation') || ['ppt', 'pptx', 'odp'].includes(extension)) {
    return 'slides';
  }
  if (
    mime.includes('word') ||
    mime === 'application/rtf' ||
    ['doc', 'docx', 'odt', 'rtf', 'txt'].includes(extension)
  ) {
    return 'doc';
  }
  if (
    mime.includes('zip') ||
    mime.includes('compressed') ||
    ['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)
  ) {
    return 'archive';
  }
  if (['json', 'xml', 'js', 'ts', 'html', 'css', 'sql'].includes(extension)) return 'code';

  return 'file';
};
