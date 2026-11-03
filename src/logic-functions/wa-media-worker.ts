import { createHash } from 'node:crypto';

import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_MEDIA_WORKER, OBJ_MESSAGE } from '../constants/universal-identifiers';
import { MetaApiError } from '../providers/whatsapp/errors';
import { getProvider } from '../providers/whatsapp';
import { metadataClient } from '../server/clients';
import { resolveFieldUniversalIdentifier } from '../server/metadata-ids';
import { config } from '../server/config';
import { enqueue } from '../server/jobs';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { asJson } from '../server/repositories/base';
import { findMessageById, patchMessage } from '../server/repositories/messages';

/**
 * Inbound media download (AR-15, AR-16, D-8).
 *
 * Meta hosts inbound media for 7 days and hands us two ways to reach it: a URL
 * inlined on the webhook, which lives about **five minutes** (measured: `ext`
 * 301 s after the message timestamp), and `GET /{media_id}`, which lives 7
 * days. The inline URL is used when it is still valid and the resolution path
 * is used otherwise — the fallback is not an optimisation, it is the only thing
 * that makes a retry, a deferred download or a replayed webhook work at all.
 */

export type MediaWorkerPayload = {
  messageId: string;
  /** Set by the UI's "Retry download" affordance; overrides the size ceiling. */
  force?: boolean;
  attempt?: number;
};

export type MediaWorkerResult = {
  outcome: 'downloaded' | 'deferred' | 'skipped' | 'failed';
  reason?: string;
  bytes?: number;
};

export type StoredMediaMeta = {
  mediaId?: string | null;
  mimeType?: string | null;
  sha256?: string | null;
  fileSize?: number | null;
  filename?: string | null;
  inlineUrl?: string | null;
  inlineUrlExpiresAt?: string | null;
  deferred?: boolean;
  downloadFailed?: boolean;
  downloadAttempts?: number;
};

export const MAX_ATTEMPTS = 4;

/** 2 s, 8 s, 32 s, 128 s — quadrupling, because media failures cluster. */
export const retryDelayMs = (attempt: number): number => 2_000 * 4 ** attempt;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
};

/**
 * Storage filenames are derived from the WAMID and the mime type, **never** from
 * the sender-supplied name: a filename arriving from an untrusted device is the
 * classic path-traversal vector. The original is preserved in `mediaMeta` and
 * shown in the UI, so nothing is lost but the risk.
 */
export const storageFilename = (wamid: string, mimeType: string | null): string => {
  const base = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = EXTENSIONS[base] ?? base.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? 'bin';
  const safeWamid = wamid.replace(/[^A-Za-z0-9._-]/g, '');

  return `${safeWamid || 'media'}.${extension}`;
};

export const isInlineUrlUsable = (
  meta: StoredMediaMeta,
  now: Date = new Date(),
): boolean => {
  if (typeof meta.inlineUrl !== 'string' || meta.inlineUrl.length === 0) return false;
  if (typeof meta.inlineUrlExpiresAt !== 'string') return false;

  const expiresAt = new Date(meta.inlineUrlExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;

  // A margin, because the download itself takes time and a URL that expires
  // mid-transfer costs a full retry cycle.
  return expiresAt.getTime() - now.getTime() > 15_000;
};

/**
 * Meta reports the same `sha256` field in **two different encodings**, and
 * documents neither:
 *
 * - the webhook's `messages[].image.sha256` is **base64**
 *   (`63juxiuEcBW/0zL4fohL7BAe1wPQAZrR55NInYcG8qA=`)
 * - `GET /{media_id}`'s `sha256` is **hex**
 *   (`e5c85e2520f9a46ad476e3e8f9df238edc421308d3f0734eaecff5915c44122d`)
 *
 * Both observed on the same image, 2026-08-15. Comparing against one encoding
 * rejected every media that took the resolution path — a byte-perfect 282 214-byte
 * download failing on a string comparison. So the comparison is over the digest
 * *bytes*, and the encoding of the declared value is inferred.
 */
export const digestMatches = (declared: string, buffer: Buffer): boolean => {
  const actual = createHash('sha256').update(buffer).digest();
  const trimmed = declared.trim();

  const expected = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  return expected.length === actual.length && expected.equals(actual);
};

export const processMedia = async (
  payload: MediaWorkerPayload,
): Promise<MediaWorkerResult> => {
  const log = logger.child({ fn: 'wa-media-worker', correlationId: payload.messageId });

  const message = await findMessageById(payload.messageId);

  if (message === null) {
    log.warn('wa.media.message_missing');

    return { outcome: 'skipped', reason: 'message not found' };
  }

  const meta = asJson<StoredMediaMeta>(message.mediaMeta, {});

  if (typeof meta.mediaId !== 'string' || meta.mediaId.length === 0) {
    return { outcome: 'skipped', reason: 'no media id' };
  }

  /**
   * D-8: a large file is *deferred*, not failed. The record keeps its metadata
   * and the UI offers a download, so a 90 MB video is a deliberate click rather
   * than an automatic hit on the workspace's storage and the queue's time.
   */
  const ceiling = config.mediaAutoDownloadMaxBytes();

  if (
    payload.force !== true &&
    typeof meta.fileSize === 'number' &&
    meta.fileSize > ceiling
  ) {
    await patchMessage(message.id, {
      mediaMeta: { ...meta, deferred: true } as Record<string, unknown>,
    });
    count(METRIC.MEDIA_DEFERRED);
    log.info('wa.media.deferred', { fileSize: meta.fileSize, ceiling });

    return { outcome: 'deferred', reason: 'over size ceiling' };
  }

  const attempt = payload.attempt ?? 0;
  const provider = getProvider();

  try {
    let url: string;
    let mimeType = meta.mimeType ?? null;
    let expectedSha = meta.sha256 ?? null;
    let expectedSize = meta.fileSize ?? null;

    if (isInlineUrlUsable(meta)) {
      url = meta.inlineUrl!;
    } else {
      const handle = await provider.fetchMediaUrl(meta.mediaId);
      url = handle.url;
      mimeType = handle.mimeType || mimeType;
      expectedSha = handle.sha256 || expectedSha;
      expectedSize = handle.fileSize || expectedSize;
    }

    let download: { buffer: Buffer; mimeType: string };

    try {
      download = await provider.downloadMedia(url);
    } catch (error) {
      /**
       * 404/410 means the short-lived URL expired between resolution and
       * download. One re-resolve is worth trying inline — the media id is still
       * valid for 7 days, and a full retry cycle for a 5-minute URL would be
       * absurd.
       */
      const status = error instanceof MetaApiError ? error.httpStatus : null;

      if (status !== 404 && status !== 410) throw error;

      log.debug('wa.media.url_expired_reresolving');
      const handle = await provider.fetchMediaUrl(meta.mediaId);
      download = await provider.downloadMedia(handle.url);
      mimeType = handle.mimeType || mimeType;
      expectedSha = handle.sha256 || expectedSha;
    }

    /**
     * Integrity is checked because we are about to attach this file to a
     * customer record. A truncated download that silently became a corrupt
     * attachment would be discovered by a rep, months later, with no way to
     * recover it — Meta's copy is long gone by then.
     */
    if (expectedSha !== null && expectedSha.length > 0) {
      if (!digestMatches(expectedSha, download.buffer)) {
        count(METRIC.MEDIA_INTEGRITY_FAIL);
        log.error('wa.media.integrity_fail', {
          expectedBytes: expectedSize,
          actualBytes: download.buffer.length,
        });

        throw new Error('media sha256 mismatch');
      }
    }

    /**
     * The ceiling again, this time against the bytes we actually received.
     *
     * The check before the download trusts Meta's declared `file_size`, which
     * is absent on some payloads and merely advisory on the rest — so a file
     * over the limit was deferred only if Meta had said how big it was. The
     * policy is about what lands in workspace storage (D-8), and that is this
     * number, not that one (D-46).
     */
    if (payload.force !== true && download.buffer.length > ceiling) {
      await patchMessage(message.id, {
        mediaMeta: {
          ...meta,
          fileSize: download.buffer.length,
          deferred: true,
        } as Record<string, unknown>,
      });

      count(METRIC.MEDIA_DEFERRED);
      log.info('wa.media.deferred', {
        fileSize: download.buffer.length,
        declaredSize: meta.fileSize ?? null,
        ceiling,
      });

      return { outcome: 'deferred', reason: 'over size ceiling once downloaded' };
    }

    const storedFilename = storageFilename(
      message.wamid ?? message.id,
      mimeType ?? download.mimeType,
    );

    /**
     * The **metadata** client, not the core one. Both expose `uploadFile`, but
     * `uploadFilesFieldFileByUniversalIdentifier` is only implemented on the
     * metadata endpoint — calling it through the core client fails with
     * 'Unknown type "Upload"'. The method existing on a client is not evidence
     * that its endpoint serves the mutation.
     */
    /**
     * Asked of the server, not derived. `getFieldUniversalIdentifier` is a
     * build-time helper that the logic-function bundler replaces with a stub,
     * so a derived constant is `undefined` here — see `server/metadata-ids.ts`.
     */
    const mediaFileFieldId = await resolveFieldUniversalIdentifier(OBJ_MESSAGE, 'mediaFile');

    if (mediaFileFieldId === null) {
      throw new Error('Could not resolve the mediaFile field identifier');
    }

    const file = await metadataClient().uploadFile({
      fileBuffer: download.buffer,
      filename: storedFilename,
      fieldMetadataUniversalIdentifier: mediaFileFieldId,
    });

    await patchMessage(message.id, {
      mediaMeta: {
        ...meta,
        mimeType: mimeType ?? download.mimeType,
        fileSize: download.buffer.length,
        deferred: false,
        downloadFailed: false,
        downloadAttempts: attempt,
      } as Record<string, unknown>,
      ...(typeof file?.id === 'string'
        ? { mediaFile: [{ fileId: file.id, label: storedFilename }] }
        : {}),
    });

    count(METRIC.MEDIA_DOWNLOADED);
    log.info('wa.media.downloaded', { bytes: download.buffer.length });

    return { outcome: 'downloaded', bytes: download.buffer.length };
  } catch (error) {
    const nextAttempt = attempt + 1;

    if (nextAttempt < MAX_ATTEMPTS) {
      count(METRIC.MEDIA_RETRY);
      log.warn('wa.media.retry', { attempt: nextAttempt, ...describeError(error) });

      await patchMessage(message.id, {
        mediaMeta: { ...meta, downloadAttempts: nextAttempt } as Record<string, unknown>,
      });

      await enqueue({
        logicFunctionUniversalIdentifier: LF_MEDIA_WORKER,
        payload: { messageId: message.id, force: payload.force, attempt: nextAttempt },
        delayMs: retryDelayMs(attempt),
        correlationId: message.wamid ?? message.id,
      });

      return { outcome: 'failed', reason: 'retrying' };
    }

    /**
     * Exhausted. The flag drives a "Retry download" affordance that stays
     * meaningful for 7 days, after which the UI changes the copy to "media
     * expired on Meta's servers" — because by then it has.
     */
    count(METRIC.MEDIA_FAILED);
    log.error('wa.media.failed', { attempts: nextAttempt, ...describeError(error) });

    await patchMessage(message.id, {
      mediaMeta: {
        ...meta,
        downloadFailed: true,
        downloadAttempts: nextAttempt,
      } as Record<string, unknown>,
    });

    return { outcome: 'failed', reason: 'attempts exhausted' };
  }
};

export const handler = async (
  payload: MediaWorkerPayload,
): Promise<MediaWorkerResult> => processMedia(payload);

export default defineLogicFunction({
  universalIdentifier: LF_MEDIA_WORKER,
  name: 'wa-media-worker',
  description: 'Downloads inbound WhatsApp media and attaches it to the message record.',
  timeoutSeconds: 120,
  handler,
});
