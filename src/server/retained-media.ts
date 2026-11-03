import { OBJ_MESSAGE } from '../constants/universal-identifiers';
import { validateOutboundMedia, type OutboundMediaKind } from '../domain/media-limits';
import { metadataClient } from './clients';
import { downloadWorkspaceFile, WorkspaceFileError } from './files';
import { resolveFieldUniversalIdentifier } from './metadata-ids';
import { query } from './repositories/base';

/** Reading the FILES field mints a fresh signed URL, including on delayed sends. */
export const retainedMediaUrl = async (messageId: string, fileId: string): Promise<string> => {
  const selection = { fileId: true, url: true } as const;
  const result = await query(
    (client) =>
      client.query({
        whatsappMessages: {
          __args: { filter: { id: { eq: messageId } }, first: 1 },
          edges: { node: { mediaFile: selection } },
        },
        whatsappCampaignRecipients: {
          __args: { filter: { messageId: { eq: messageId } }, first: 1 },
          edges: { node: { campaign: { headerMediaFile: selection } } },
        },
      }),
    'media.refreshUrl',
  );
  const files = [
    ...(result.whatsappMessages?.edges?.[0]?.node.mediaFile ?? []),
    ...(result.whatsappCampaignRecipients?.edges?.[0]?.node.campaign?.headerMediaFile ?? []),
  ];
  const file = files.find((candidate) => candidate.fileId === fileId);
  if (!file?.url) throw new WorkspaceFileError('The retained attachment is no longer available');
  return file.url;
};

/** Twenty permits a permanent file to belong to one record; reuse creates an independent copy. */
export const copyMessageMedia = async (
  handle: { url?: string | null; path?: string | null },
  filename: string,
  kind: OutboundMediaKind,
) => {
  const file = await downloadWorkspaceFile(handle);
  const verdict = validateOutboundMedia({
    kind,
    mimeType: file.mimeType,
    sizeBytes: file.buffer.length,
  });
  if (!verdict.ok) throw new WorkspaceFileError(verdict.detail);
  const fieldMetadataUniversalIdentifier = await resolveFieldUniversalIdentifier(
    OBJ_MESSAGE,
    'mediaFile',
  );
  if (!fieldMetadataUniversalIdentifier)
    throw new WorkspaceFileError('The message media field is unavailable');
  const uploaded = await metadataClient().uploadFile({
    fileBuffer: file.buffer,
    filename,
    fieldMetadataUniversalIdentifier,
  });
  return { ...uploaded, mimeType: file.mimeType };
};
