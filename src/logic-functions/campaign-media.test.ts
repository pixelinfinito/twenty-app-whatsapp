import { expect, it } from 'vitest';
import { campaignMediaAssociation } from './wa-campaign-control';
it('saves the uploaded header reference with its original filename', () => {
  expect(campaignMediaAssociation({ header: { kind: 'media', fileId: 'file', filePath: 'stored/header.png', filename: 'header.png' } })).toEqual({ headerMediaFile: [{ fileId: 'file', label: 'header.png' }] });
});
it('removes the association when the mapping no longer has media', () => {
  expect(campaignMediaAssociation({ body: [] })).toEqual({ headerMediaFile: [] });
  expect(campaignMediaAssociation({ header: { kind: 'media', fileUrl: null } })).toEqual({ headerMediaFile: [] });
});
it('keeps historical URL mappings usable without inventing a file ID', () => {
  expect(campaignMediaAssociation({ header: { kind: 'media', fileUrl: '/files/legacy.pdf' } })).toEqual({});
});
