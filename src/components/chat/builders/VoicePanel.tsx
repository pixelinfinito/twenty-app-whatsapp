import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { Translate } from '../../common/copy';
import { duration as formatDuration, fileSize } from '../../common/format';
import { Glyph } from '../../common/icons';
import { createUploadGeneration, FileUploadError, uploadDeviceFile, type SelectedFile } from './upload';

/** Native recording, host upload, and server-authorized sending. */
export type VoicePanelProps = {
  fieldMetadataId?: string | null;
  t: Translate;
  isSending: boolean;
  /**
   * No `onCancel`: the panel's frame owns closing it, and unmounting is what
   * stops the microphone (see `release`). A second cancel inside the body would
   * be a second way to do the same thing, one of which would eventually forget
   * to release the stream.
   */
  onSend: (input: { fileId: string; fileUrl: string; filePath: string; filename: string }) => Promise<boolean>;
};

type Phase = 'idle' | 'recording' | 'review' | 'uploading' | 'unavailable' | 'denied';

/**
 * Only formats Meta accepts as audio.
 *
 * The obvious list would start with `audio/webm;codecs=opus`, which is what
 * Chrome's `MediaRecorder` produces most readily — and WhatsApp does not accept
 * WebM. Recording it anyway and declaring it `audio/ogg` is tempting because
 * the codec inside is the same Opus; it is also a lie about the container, and
 * the failure lands either at Meta's validator or, worse, on the customer's
 * device as audio that will not play.
 *
 * So the recorder is offered only when the browser can produce something
 * sendable, and says plainly that it cannot when it cannot. A voice note that
 * silently arrives broken is a far worse outcome than a button that is honest
 * about being unavailable.
 */
const CANDIDATE_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
];

const supportedType = (): string | null => {
  const recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;

  if (recorder === undefined) return null;

  return (
    CANDIDATE_TYPES.find((type) => {
      try {
        return recorder.isTypeSupported(type);
      } catch {
        return false;
      }
    }) ?? null
  );
};

/** `audio/ogg;codecs=opus` → `audio/ogg`: Meta validates the base type. */
const declaredType = (recorded: string): string =>
  (recorded.split(';')[0] ?? recorded).trim();

const EXTENSION: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
};

export const VoicePanel = ({ fieldMetadataId, t, isSending, onSend }: VoicePanelProps) => {
  const theme = useTheme();
  const uploadGeneration = useRef(createUploadGeneration());
  const uploading = useRef(false);
  const submitted = useRef(false);
  const active = useRef(true);
  const starting = useRef(false);
  useEffect(() => () => uploadGeneration.current.invalidate(), []);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [stored, setStored] = useState<SelectedFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The one piece of cleanup that must never be skipped. Everything else here
   * is recoverable; a live microphone is not.
   */
  const release = useCallback(() => {
    if (ticker.current !== null) clearInterval(ticker.current);
    ticker.current = null;

    if (recorder.current !== null) {
      recorder.current.ondataavailable = null;
      recorder.current.onstop = null;
      if (recorder.current.state !== 'inactive') recorder.current.stop();
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, []);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      release();
    };
  }, [release]);

  useEffect(
    () => () => {
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const start = async () => {
    if (starting.current || recorder.current !== null) return;
    const type = supportedType();

    if (type === null || globalThis.navigator?.mediaDevices === undefined) {
      setPhase('unavailable');

      return;
    }

    starting.current = true;
    try {
      const media = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
      if (!active.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }

      stream.current = media;
      chunks.current = [];

      const instance = new MediaRecorder(media, { mimeType: type });
      const startedAt = Date.now();

      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };

      instance.onstop = () => {
        const recorded = new Blob(chunks.current, { type });
        const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

        setBlob(recorded);
        setSeconds(duration);
        setPreviewUrl(URL.createObjectURL(recorded));
        release();
        void upload(recorded, duration);
      };

      recorder.current = instance;
      instance.start();

      setSeconds(0);
      setPhase('recording');
      ticker.current = setInterval(() => setSeconds((current) => current + 1), 1000);
    } catch {
      // Both "the rep said no" and "there is no microphone" land here, and the
      // browser deliberately does not distinguish them. The recoverable one is
      // the likelier one, so that is what the message says.
      if (active.current) setPhase('denied');
      release();
    } finally {
      starting.current = false;
    }
  };

  const stop = () => recorder.current?.stop();

  const discard = () => {
    uploadGeneration.current.invalidate();
    uploading.current = false;
    release();
    setBlob(null);
    setStored(null);
    setPreviewUrl(null);
    setSeconds(0);
    setError(null);
    setPhase('idle');
  };

  const upload = async (recorded: Blob, duration: number) => {
    if (uploading.current || isSending) return;
    const ticket = uploadGeneration.current.next();
    uploading.current = true;

    setPhase('uploading');
    setError(null);
    setStored(null);

    try {
      const contentType = declaredType(recorded.type);
      const filename = `voice-${duration}s.${EXTENSION[contentType] ?? 'ogg'}`;

      const stored = await uploadDeviceFile({
        fieldMetadataId,
        blob: recorded,
        filename,
        requiredKind: 'audio',
      });

      if (uploadGeneration.current.current(ticket)) {
        setStored(stored);
        setPhase('review');
      }
    } catch (caught) {
      if (!uploadGeneration.current.current(ticket)) return;
      setError(caught instanceof FileUploadError ? t(`upload.error.${caught.code}`) : t('chat.recordUploadFailed'));
      setPhase('review');
    } finally {
      if (uploadGeneration.current.current(ticket)) uploading.current = false;
    }
  };

  const send = async () => {
    if (!stored || isSending || submitted.current) return;
    submitted.current = true;
    try {
      await onSend({ fileId: stored.fileId, fileUrl: stored.url, filePath: stored.path, filename: stored.filename });
    } finally {
      submitted.current = false;
    }
  };

  const primary: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '32px',
    border: '1px solid transparent',
    borderRadius: theme.border.radius.sm,
    background: theme.color.blue,
    color: theme.font.color.inverted,
    cursor: 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: `0 ${theme.spacing[2]}`,
  };

  const quiet: React.CSSProperties = {
    ...primary,
    border: `1px solid ${theme.border.color.medium}`,
    background: 'transparent',
    color: theme.font.color.secondary,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        flex: '1 1 auto',
        minHeight: 0,
      }}
    >

      {phase === 'unavailable' || phase === 'denied' ? (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'flex-start',
            gap: theme.spacing[1],
            fontSize: theme.font.size.sm,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {t(phase === 'denied' ? 'chat.recordDenied' : 'chat.recordUnavailable')}
        </span>
      ) : null}

      {phase === 'recording' ? (
        <span
          role="status"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.sm,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="record" />
          {t('chat.recording', { duration: formatDuration(seconds) })}
        </span>
      ) : null}

      {(phase === 'review' || phase === 'uploading') && previewUrl !== null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
          <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
            {t('chat.recordReview')}
          </span>
          <audio controls src={previewUrl} style={{ width: '100%' }} />
          {stored ? (
            <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
              {stored.filename} · {fileSize(stored.size)}
            </span>
          ) : null}
        </div>
      ) : null}

      {phase === 'uploading' ? (
        <span
          role="status"
          style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}
        >
          {t('chat.recordUploading')}
        </span>
      ) : null}

      {error === null ? null : (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {error}
        </span>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: theme.spacing[2],
          flexWrap: 'wrap',
        }}
      >
        {phase === 'idle' || phase === 'denied' || phase === 'unavailable' ? (
          <button type="button" onClick={() => void start()} style={primary}>
            <Glyph name="record" size="md" />
            {t('chat.recordStart')}
          </button>
        ) : null}

        {phase === 'recording' ? (
          <button type="button" onClick={stop} style={primary}>
            <Glyph name="stopRecording" size="md" />
            {t('chat.recordStop')}
          </button>
        ) : null}

        {phase === 'review' || phase === 'uploading' ? (
          <>
            <button type="button" disabled={isSending} onClick={discard} style={quiet}>
              {t('chat.recordDiscard')}
            </button>
            {error !== null && blob !== null ? (
              <button type="button" onClick={() => void upload(blob, seconds)} style={quiet}>
                {t('upload.retry')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void send()}
              disabled={isSending || stored === null}
              style={primary}
            >
              <Glyph name="send" size="md" />
              {t('chat.send')}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
};
