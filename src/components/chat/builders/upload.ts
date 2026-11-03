import { uploadFile, type UploadedFrontComponentFile } from 'twenty-sdk/front-component';
import {
  MEDIA_LIMITS,
  normaliseMimeType,
  validateOutboundMedia,
} from '../../../domain/media-limits';

export type UploadMediaKind = 'image' | 'video' | 'audio' | 'document';
export type SelectedFile = UploadedFrontComponentFile & {
  filename: string;
  mediaKind: UploadMediaKind;
};
export type UploadTargets = {
  messageMediaFieldMetadataId: string | null;
  campaignHeaderMediaFieldMetadataId: string | null;
};
export class FileUploadError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const describeUpload = (blob: Blob, filename: string, requiredKind?: UploadMediaKind) => {
  if (blob.size === 0) throw new FileUploadError('empty');
  const mimeType =
    normaliseMimeType(blob.type) ||
    MIME_BY_EXTENSION[filename.split('.').pop()?.toLowerCase() ?? ''] ||
    'application/octet-stream';
  const inferred =
    (['image', 'video', 'audio'] as const).find((kind) =>
      MEDIA_LIMITS[kind].mimeTypes.includes(mimeType),
    ) ?? 'document';
  const mediaKind = requiredKind ?? inferred;
  const verdict = validateOutboundMedia({ kind: mediaKind, mimeType, sizeBytes: blob.size });
  if (!verdict.ok) throw new FileUploadError(verdict.reason);
  return { mediaKind, mimeType };
};
/** Host owns credentials and storage transport; file bytes never pass through an app route. */
export const uploadDeviceFile = async ({
  blob,
  filename,
  fieldMetadataId,
  requiredKind,
}: {
  blob: Blob;
  filename: string;
  fieldMetadataId: string | null | undefined;
  requiredKind?: UploadMediaKind;
}): Promise<SelectedFile> => {
  if (!fieldMetadataId) throw new FileUploadError('unavailable');
  const { mediaKind, mimeType } = describeUpload(blob, filename, requiredKind);
  const result = await uploadFile(
    blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }),
    { fieldMetadataId, fileName: filename },
  );
  if (result.status !== 'uploaded') throw new FileUploadError(result.reason);
  return { ...result.file, filename, mediaKind };
};
/** Dismissal invalidates results; it does not abort the host transfer. */
export const createUploadGeneration = () => {
  let generation = 0;
  return {
    next: () => ++generation,
    current: (ticket: number) => ticket === generation,
    invalidate: () => {
      generation++;
    },
  };
};
