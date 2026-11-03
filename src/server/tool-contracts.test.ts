import { describe, expect, it } from 'vitest';
import { TOOL_ACTIONS, TOOL_SCHEMAS, isRead, needsConfirmation, requiredRole } from './tool-contracts';
import { validateToolInput } from './tool-schema';
import type { WhatsappToolName } from './tool-contracts';

describe('AI action matrix', () => {
  for (const [name, actions] of Object.entries(TOOL_ACTIONS)) {
    it.each(actions)(`${name}/%s has a validated, closed schema and explicit permissions`, (action) => {
      const tool = name as WhatsappToolName;
      const input = { action, ...(name === 'whatsapp-thread-action' ? { threadId: 'thread' } : {}) };
      expect(() => validateToolInput(TOOL_SCHEMAS[tool], input)).not.toThrow();
      expect(['agent', 'admin']).toContain(requiredRole(tool, action));
      if (needsConfirmation(tool, action)) {
        expect(isRead(tool, action)).toBe(false); expect(requiredRole(tool, action)).toBe('admin');
      }
      expect(() => validateToolInput(TOOL_SCHEMAS[tool], { ...input, actorId: 'forged' })).toThrow();
    });
    it(`${name} rejects unknown actions`, () => expect(() => validateToolInput(TOOL_SCHEMAS[name as WhatsappToolName], { action: 'doAnything' })).toThrow());
  }
  it('keeps campaign mutations and administrative actions separate from operator reads', () => {
    expect(requiredRole('whatsapp-campaigns', 'launch')).toBe('admin');
    expect(requiredRole('whatsapp-campaigns', 'preview')).toBe('agent');
    expect(requiredRole('whatsapp-consent', 'set')).toBe('agent');
    expect(requiredRole('whatsapp-consent', 'import')).toBe('admin');
    expect(requiredRole('whatsapp-templates', 'list')).toBe('agent');
    expect(requiredRole('whatsapp-templates', 'publish')).toBe('admin');
    expect(requiredRole('whatsapp-webhooks', 'list')).toBe('admin');
  });
});

describe('message schemas', () => {
  const messages = [
    { kind: 'text', body: 'Hello', contextWamid: 'quoted' },
    { kind: 'template', templateId: 'template', parameters: { body: ['Ana'] }, contextWamid: 'quoted' },
    ...['image', 'video', 'audio', 'document', 'sticker'].map((mediaKind) => ({ kind: 'media', mediaKind, fileId: 'file', filePath: '/files/media' })),
    { kind: 'media', mediaKind: 'audio', fileId: 'file', voice: true },
    { kind: 'interactive', interactive: { type: 'button' } },
    { kind: 'reaction', targetWamid: 'message', emoji: '👍' },
    { kind: 'location', latitude: -8.8, longitude: 13.2 },
    { kind: 'contacts', contacts: [{ name: { formatted_name: 'Ana' } }] },
  ];
  it.each(messages)('accepts supported message $kind/$mediaKind', (message) => {
    expect(() => validateToolInput(TOOL_SCHEMAS['whatsapp-send-message'], { requestId: 'request', threadId: 'thread', message })).not.toThrow();
  });
  it.each([{ kind: 'text' }, { kind: 'media', mediaKind: 'unknown' }, { kind: 'reaction', targetWamid: 'message' },
    { kind: 'location', latitude: 999, longitude: 10 }, { kind: 'text', body: 'Hi', sentById: 'forged' }])('rejects invalid message %j', (message) => {
    expect(() => validateToolInput(TOOL_SCHEMAS['whatsapp-send-message'], { requestId: 'request', message })).toThrow();
  });
  it.each([0, 51, 1.5, '50'])('rejects invalid page size %s', (first) => {
    expect(() => validateToolInput(TOOL_SCHEMAS['whatsapp-list-threads'], { first })).toThrow();
  });
  it('accepts null for explicit unassignment and unsnoozing', () => {
    expect(() => validateToolInput(TOOL_SCHEMAS['whatsapp-thread-action'], { action: 'assign', threadId: 'thread', assigneeId: null })).not.toThrow();
  });
});
