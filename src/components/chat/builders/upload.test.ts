import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from 'twenty-sdk/front-component';
import { createUploadGeneration, describeUpload, uploadDeviceFile } from './upload';
vi.mock('twenty-sdk/front-component', () => ({ uploadFile: vi.fn() }));
const host = vi.mocked(uploadFile);
beforeEach(() => { host.mockReset(); });
describe('native uploads', () => {
  it('uploads bytes through the host and preserves its durable handle', async () => {
    const blob = new Blob(['image'], { type: 'image/png' });
    host.mockResolvedValue({ status: 'uploaded', file: { fileId: 'file', path: 'stored/image.png', url: '/files/stored/image.png', size: 5, mimeType: 'image/png' } });
    expect(await uploadDeviceFile({ blob, filename: 'photo.png', fieldMetadataId: 'field' })).toMatchObject({ fileId: 'file', path: 'stored/image.png', filename: 'photo.png', mediaKind: 'image' });
    expect(host).toHaveBeenCalledWith(blob, { fieldMetadataId: 'field', fileName: 'photo.png' });
  });
  it('infers supported kinds and lets the Document action override them', () => {
    expect(describeUpload(new Blob(['x'], { type: 'audio/mpeg' }), 'song.mp3').mediaKind).toBe('audio');
    expect(describeUpload(new Blob(['x'], { type: 'video/mp4' }), 'clip.mp4').mediaKind).toBe('video');
    expect(describeUpload(new Blob(['x']), 'photo.png').mimeType).toBe('image/png');
    expect(describeUpload(new Blob(['x'], { type: 'image/png' }), 'photo.png', 'document').mediaKind).toBe('document');
  });
  it('rejects empty, oversized and mismatched header files before uploading', async () => {
    expect(() => describeUpload(new Blob([]), 'empty.pdf')).toThrow('empty');
    expect(() => describeUpload(new Blob(['x'], { type: 'application/pdf' }), 'paper.pdf', 'image')).toThrow('MEDIA_WRONG_TYPE');
    expect(() => describeUpload(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png')).toThrow('MEDIA_TOO_LARGE');
    await expect(uploadDeviceFile({ blob: new Blob(['x']), filename: 'x', fieldMetadataId: null })).rejects.toThrow('unavailable');
    expect(host).not.toHaveBeenCalled();
  });
  it('surfaces failure and permits a retry of the same file', async () => {
    host.mockResolvedValueOnce({ status: 'failed', reason: 'upload-failed' });
    host.mockResolvedValueOnce({ status: 'uploaded', file: { fileId: 'file', path: 'stored/x.pdf', url: '', size: 1, mimeType: 'application/pdf' } });
    const input = { blob: new Blob(['x'], { type: 'application/pdf' }), filename: 'x.pdf', fieldMetadataId: 'field' };
    await expect(uploadDeviceFile(input)).rejects.toThrow('upload-failed');
    await expect(uploadDeviceFile(input)).resolves.toMatchObject({ fileId: 'file' });
  });
  it('invalidates late results after replacement and dismissal', () => {
    const generation = createUploadGeneration();
    const first = generation.next();
    const replacement = generation.next();
    expect(generation.current(first)).toBe(false);
    expect(generation.current(replacement)).toBe(true);
    generation.invalidate();
    expect(generation.current(replacement)).toBe(false);
  });
});
