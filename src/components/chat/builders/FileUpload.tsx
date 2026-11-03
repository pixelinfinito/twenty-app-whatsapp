import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';
import type { Translate } from '../../common/copy';
import { fileSize } from '../../common/format';
import { MEDIA_LIMITS } from '../../../domain/media-limits';
import {
  createUploadGeneration,
  FileUploadError,
  uploadDeviceFile,
  type SelectedFile,
  type UploadMediaKind,
} from './upload';

export type FileUploadProps = {
  fieldMetadataId?: string | null;
  value: SelectedFile | null;
  onChange: (file: SelectedFile | null) => void;
  requiredKind?: UploadMediaKind;
  disabled?: boolean;
  t: Translate;
};

export const FileUpload = ({
  fieldMetadataId,
  value,
  onChange,
  requiredKind,
  disabled = false,
  t,
}: FileUploadProps) => {
  const theme = useTheme();
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(createUploadGeneration());
  const picked = useRef<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => () => generation.current.invalidate(), []);
  useEffect(() => {
    const file = previewFile;
    if (error || !file || !file.type.startsWith('image/')) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [previewFile, error]);

  const upload = async (file: File) => {
    const ticket = generation.current.next();
    picked.current = file;
    setPreviewFile(file);
    setPreviewFailed(false);
    setBusy(true);
    setError(null);
    onChange(null);
    try {
      const stored = await uploadDeviceFile({
        blob: file,
        filename: file.name,
        fieldMetadataId,
        requiredKind,
      });
      if (generation.current.current(ticket)) onChange(stored);
    } catch (caught) {
      if (generation.current.current(ticket))
        setError(caught instanceof FileUploadError ? caught.code : 'upload-failed');
    } finally {
      if (generation.current.current(ticket)) setBusy(false);
    }
  };
  const clear = () => {
    generation.current.invalidate();
    picked.current = null;
    setPreviewFile(null);
    setPreviewFailed(false);
    setBusy(false);
    setError(null);
    onChange(null);
  };
  const button = {
    padding: '6px 10px',
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: 'transparent',
    color: theme.font.color.primary,
    cursor: 'pointer',
    font: 'inherit',
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        minWidth: 0,
        minHeight: 0,
        flex: '1 1 auto',
      }}
      aria-busy={busy}
    >
      <input
        ref={input}
        type="file"
        tabIndex={-1}
        aria-label={t('upload.choose')}
        style={{ display: 'none' }}
        accept={requiredKind && requiredKind !== 'document' ? MEDIA_LIMITS[requiredKind].mimeTypes.join(',') : undefined}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
      {!previewFailed && (preview || (value?.mediaKind === 'image' && value.url)) ? (
        <img
          src={preview ?? value!.url}
          onError={() => setPreviewFailed(true)}
          alt={value?.filename ?? picked.current?.name ?? ''}
          style={{
            maxWidth: '100%',
            maxHeight: 120,
            minHeight: 0,
            flex: '1 1 auto',
            objectFit: 'contain',
            alignSelf: 'flex-start',
          }}
        />
      ) : null}
      {value || picked.current ? (
        <span
          title={value?.filename ?? picked.current?.name}
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            fontSize: theme.font.size.sm,
          }}
        >
          {value?.filename ?? picked.current?.name}
          {(value?.size ?? picked.current?.size ?? 0) > 0 ? ` · ${fileSize(value?.size ?? picked.current!.size)}` : ''}
        </span>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing[1], flexShrink: 0 }}>
        <button
          type="button"
          style={button}
          disabled={disabled || !fieldMetadataId}
          onClick={() => input.current?.click()}
        >
          {t(value || picked.current ? 'upload.replace' : 'upload.choose')}
        </button>
        {value || picked.current ? (
          <button type="button" style={button} disabled={disabled} onClick={clear}>
            {t('upload.remove')}
          </button>
        ) : null}
        {(error === 'upload-failed' || error === 'invalid-params') && picked.current ? (
          <button
            type="button"
            style={button}
            disabled={disabled || busy || !fieldMetadataId}
            onClick={() => {
              if (picked.current) void upload(picked.current);
            }}
          >
            {t('upload.retry')}
          </button>
        ) : null}
      </div>
      {!value && !picked.current ? (
        <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {t(`upload.hint.${requiredKind ?? 'auto'}`)}
        </span>
      ) : null}
      {busy ? <span role="status">{t('upload.uploading')}</span> : null}
      {error || !fieldMetadataId ? (
        <span role="alert" style={{ color: theme.font.color.danger }}>
          {t(`upload.error.${error ?? 'unavailable'}`)}
        </span>
      ) : null}
    </div>
  );
};
