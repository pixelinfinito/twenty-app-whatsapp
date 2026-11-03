import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_KIND } from '../domain/constants';
const mocks = vi.hoisted(() => ({ create: vi.fn(), schedule: vi.fn() }));
vi.mock('./repositories/messages', () => ({ createMessage: mocks.create }));
vi.mock('./schedule', () => ({ scheduleSend: mocks.schedule }));
vi.mock('./retained-media', () => ({
  copyMessageMedia: async () => ({ id: 'copied-file', path: 'stored/copied.pdf' }),
}));
import { queueOutbound } from './outbound';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 'message' });
});
const base = { thread: { id: 'thread' }, account: { id: 'account' } };
describe('durable outbound uploads', () => {
  it('attaches a device file while creating the message, before scheduling', async () => {
    await queueOutbound({
      ...base,
      spec: {
        kind: 'media',
        mediaKind: 'image',
        fileId: 'file',
        filePath: 'stored/photo.png',
        filename: 'photo.png',
      },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaFile: [{ fileId: 'file', label: 'photo.png' }],
        payload: expect.objectContaining({ filePath: 'stored/photo.png' }),
      }),
    );
    expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.schedule.mock.invocationCallOrder[0]!,
    );
  });
  it('attaches an interactive template header without granting users record writes', async () => {
    await queueOutbound({
      ...base,
      spec: { kind: 'template', templateId: 'template' },
      template: {
        id: 'template',
        parameters: {
          body: [],
          buttons: [],
          header: {
            kind: 'media',
            mediaId: null,
            fileId: 'file',
            filePath: 'stored/header.png',
            filename: 'header.png',
          },
        },
      },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ mediaFile: [{ fileId: 'file', label: 'header.png' }] }),
    );
  });
  it('leaves campaign media on its campaign and accepts historical URL sends', async () => {
    await queueOutbound({
      ...base,
      spec: {
        kind: 'media',
        mediaKind: 'document',
        fileId: 'campaign-file',
        filePath: 'stored/a.pdf',
      },
      sourceKind: SOURCE_KIND.CAMPAIGN,
    });
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('mediaFile');
    await queueOutbound({
      ...base,
      spec: { kind: 'media', mediaKind: 'document', fileUrl: '/files/old.pdf' },
    });
    expect(mocks.create.mock.calls[1]![0]).toMatchObject({
      mediaFile: [{ fileId: 'copied-file', label: 'Media' }],
    });
  });
  it('does not schedule a message if retaining the file fails', async () => {
    mocks.create.mockRejectedValueOnce(new Error('file unavailable'));
    await expect(
      queueOutbound({
        ...base,
        spec: { kind: 'media', mediaKind: 'document', fileId: 'file', filePath: 'stored/a.pdf' },
      }),
    ).rejects.toThrow('file unavailable');
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});
