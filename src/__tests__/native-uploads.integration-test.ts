import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { describe, expect, it } from 'vitest';
import { downloadWorkspaceFile } from '../server/files';
import { retainedMediaUrl } from '../server/retained-media';
import { OBJ_CAMPAIGN, OBJ_MESSAGE } from '../constants/universal-identifiers';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=',
  'base64',
);
const metadata = new MetadataApiClient();
const core = new CoreApiClient();
const field = async (objectId: string, name: string) => {
  const result = await metadata.query({
    objects: {
      __args: { paging: { first: 500 }, filter: {} },
      edges: {
        node: { universalIdentifier: true, fieldsList: { name: true, universalIdentifier: true } },
      },
    },
  });
  const found = result.objects.edges
    .find((edge) => edge.node.universalIdentifier === objectId)
    ?.node.fieldsList.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing upload field ${name}`);
  return found.universalIdentifier;
};

describe('Twenty 2.54 native upload storage', () => {
  it('retains message files, mints fresh signed URLs and creates independent copies for reuse', async () => {
    const target = await field(OBJ_MESSAGE, 'mediaFile');
    const uploaded = await metadata.uploadFile({
      fileBuffer: png,
      filename: 'native.png',
      fieldMetadataUniversalIdentifier: target,
    });
    const created = await core.mutation({
      createWhatsappMessage: {
        __args: {
          data: {
            body: 'Native upload test',
            status: 'FAILED',
            direction: 'OUTBOUND',
            messageType: 'IMAGE',
            mediaFile: [{ fileId: uploaded.id, label: 'native.png' }],
          },
        },
        id: true,
        mediaFile: { fileId: true, url: true },
      },
    });
    const id = created.createWhatsappMessage!.id;
    let copyId: string | null = null;
    try {
      const reread = await core.query({
        whatsappMessages: {
          __args: { first: 1, filter: { id: { eq: id } } },
          edges: { node: { mediaFile: { fileId: true, label: true, url: true } } },
        },
      });
      const file = reread.whatsappMessages!.edges[0]!.node.mediaFile![0]!;
      expect(file.fileId).toBe(uploaded.id);
      expect(file.label).toBe('native.png');
      expect(file.url).toContain('/file/files-field/');
      const downloaded = await downloadWorkspaceFile({
        url: await retainedMediaUrl(id, uploaded.id),
      });
      expect(downloaded.buffer).toEqual(png);
      const copied = await metadata.uploadFile({
        fileBuffer: downloaded.buffer,
        filename: 'native.png',
        fieldMetadataUniversalIdentifier: target,
      });
      expect(copied.id).not.toBe(uploaded.id);
      const second = await core.mutation({
        createWhatsappMessage: {
          __args: {
            data: {
              body: 'Reused file',
              status: 'FAILED',
              direction: 'OUTBOUND',
              messageType: 'IMAGE',
              mediaFile: [{ fileId: copied.id, label: 'native.png' }],
            },
          },
          id: true,
        },
      });
      copyId = second.createWhatsappMessage!.id;
    } finally {
      if (copyId)
        await core.mutation({ destroyWhatsappMessage: { __args: { id: copyId }, id: true } });
      await core.mutation({ destroyWhatsappMessage: { __args: { id }, id: true } });
    }
  });

  it('persists, replaces and removes a campaign header and its mapping together', async () => {
    const target = await field(OBJ_CAMPAIGN, 'headerMediaFile');
    const uploaded = await metadata.uploadFile({
      fileBuffer: png,
      filename: 'campaign.png',
      fieldMetadataUniversalIdentifier: target,
    });
    const mapping = {
      header: {
        kind: 'media',
        fileId: uploaded.id,
        filePath: uploaded.path,
        filename: 'campaign.png',
      },
      body: [],
    };
    const created = await core.mutation({
      createWhatsappCampaign: {
        __args: {
          data: {
            name: 'Native upload draft',
            status: 'DRAFT',
            variableMapping: mapping,
            headerMediaFile: [{ fileId: uploaded.id, label: 'campaign.png' }],
          },
        },
        id: true,
      },
    });
    const id = created.createWhatsappCampaign!.id;
    let messageId: string | null = null;
    let recipientId: string | null = null;
    try {
      const reread = await core.query({
        whatsappCampaigns: {
          __args: { first: 1, filter: { id: { eq: id } } },
          edges: { node: { variableMapping: true, headerMediaFile: { fileId: true, url: true } } },
        },
      });
      expect(reread.whatsappCampaigns!.edges[0]!.node.variableMapping).toMatchObject(mapping);
      const url = reread.whatsappCampaigns!.edges[0]!.node.headerMediaFile![0]!.url;
      expect((await downloadWorkspaceFile({ url })).buffer).toEqual(png);
      // Scheduled deliveries keep the campaign association, not a second FILES owner.
      const queued = await core.mutation({
        createWhatsappMessage: {
          __args: { data: { status: 'FAILED', direction: 'OUTBOUND', messageType: 'TEMPLATE' } },
          id: true,
        },
      });
      messageId = queued.createWhatsappMessage!.id;
      const recipient = await core.mutation({
        createWhatsappCampaignRecipient: {
          __args: { data: { campaignId: id, messageId, status: 'FAILED' } },
          id: true,
        },
      });
      recipientId = recipient.createWhatsappCampaignRecipient!.id;
      expect((await downloadWorkspaceFile({ url: await retainedMediaUrl(messageId, uploaded.id) })).buffer).toEqual(png);
      const replacement = await metadata.uploadFile({
        fileBuffer: png,
        filename: 'replacement.png',
        fieldMetadataUniversalIdentifier: target,
      });
      const updated = await core.mutation({
        updateWhatsappCampaign: {
          __args: {
            id,
            data: {
              headerMediaFile: [{ fileId: replacement.id, label: 'replacement.png' }],
              variableMapping: {
                header: { kind: 'media', fileId: replacement.id, filePath: replacement.path },
                body: [],
              },
            },
          },
          headerMediaFile: { fileId: true },
        },
      });
      expect(updated.updateWhatsappCampaign!.headerMediaFile![0]!.fileId).toBe(replacement.id);
      const cleared = await core.mutation({
        updateWhatsappCampaign: {
          __args: { id, data: { headerMediaFile: [], variableMapping: { body: [] } } },
          headerMediaFile: { fileId: true },
          variableMapping: true,
        },
      });
      expect(cleared.updateWhatsappCampaign!.headerMediaFile ?? []).toEqual([]);
      expect(cleared.updateWhatsappCampaign!.variableMapping).toEqual({ body: [] });
    } finally {
      if (recipientId) await core.mutation({ destroyWhatsappCampaignRecipient: { __args: { id: recipientId }, id: true } });
      if (messageId) await core.mutation({ destroyWhatsappMessage: { __args: { id: messageId }, id: true } });
      await core.mutation({ destroyWhatsappCampaign: { __args: { id }, id: true } });
    }
  });
});
