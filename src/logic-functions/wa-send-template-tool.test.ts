import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeTemplateSend } = vi.hoisted(() => ({
  executeTemplateSend: vi.fn(),
}));

vi.mock('../server/template-send', () => ({
  ACTION_REFUSAL: {
    PERSON_UNKNOWN: 'PERSON_UNKNOWN',
    ACCOUNT_UNKNOWN: 'ACCOUNT_UNKNOWN',
    TEMPLATE_UNKNOWN: 'TEMPLATE_UNKNOWN',
    MISSING_VARIABLES: 'MISSING_VARIABLES',
    IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  },
  executeTemplateSend,
}));

import {
  handler,
  INVALID_REQUEST_ID,
  isUuidV4,
  runSendTemplateTool,
  sendTemplateInputSchema,
} from './wa-send-template-tool';

const PERSON_ID = '2a296bab-0ed4-4a4d-8293-513d624e6971';
const TEMPLATE_ID = 'a03833c2-2a76-42c7-829f-d78f61360e0f';
const ACCOUNT_ID = '56136228-bba6-48c4-b738-7b84edebe447';
const REQUEST_ID = 'FB044E6D-5195-4C71-98C0-D5F60AD18CF4';

describe('whatsapp-send-template MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeTemplateSend.mockResolvedValue({
      status: 'accepted',
      messageId: 'message-1',
      threadId: 'thread-1',
      denialReason: null,
      warnings: [],
      replayed: false,
    });
  });

  it('publishes a closed, explicit tool input contract', () => {
    expect(sendTemplateInputSchema.additionalProperties).toBe(false);
    expect(sendTemplateInputSchema.required).toEqual([
      'personId',
      'templateId',
      'parameters',
      'requestId',
    ]);
    expect(sendTemplateInputSchema.properties).not.toHaveProperty('phone');
    expect(sendTemplateInputSchema.properties).not.toHaveProperty('actorId');
    expect(sendTemplateInputSchema.properties).not.toHaveProperty('sourceKind');
  });

  it('requires a real UUID v4 idempotency key before resolving records', async () => {
    expect(isUuidV4(REQUEST_ID)).toBe(true);
    expect(isUuidV4('fb044e6d-5195-1c71-98c0-d5f60ad18cf4')).toBe(false);

    const result = await runSendTemplateTool({
      personId: PERSON_ID,
      templateId: TEMPLATE_ID,
      parameters: {},
      requestId: 'not-a-request-id',
    });

    expect(result.denialReason).toBe(INVALID_REQUEST_ID);
    expect(executeTemplateSend).not.toHaveBeenCalled();
  });

  it('uses exact ids and a server-owned AI-agent source', async () => {
    const result = await runSendTemplateTool({
      personId: PERSON_ID,
      templateId: TEMPLATE_ID,
      accountId: ACCOUNT_ID,
      parameters: { body: ['Ana'] },
      requestId: REQUEST_ID,
    });

    expect(executeTemplateSend).toHaveBeenCalledWith(
      {
        personId: PERSON_ID,
        templateId: TEMPLATE_ID,
        accountId: ACCOUNT_ID,
        parameters: { body: ['Ana'] },
        createThreadIfMissing: undefined,
      },
      {
        sourceKind: 'AI_AGENT',
        sentById: null,
        requestId: REQUEST_ID.toLowerCase(),
        channel: 'TWENTY_MCP',
        accountResolution: 'exact',
        templateResolution: 'exact',
      },
    );
    expect(result).toMatchObject({
      status: 'accepted',
      delivery: 'queued',
      replayed: false,
    });
  });
});

it('preserves the send denial envelope when delegation is unavailable', async () => {
  expect(await handler({
    personId: '33e0a280-8586-4fc4-ae76-ddcd56d420ce',
    templateId: 'ec6c5663-0f92-4dca-8e11-a8dc8e2da690',
    parameters: {}, requestId: 'd5a3cb22-1eea-4bcf-bb3f-e4e25dfd3819',
  })).toMatchObject({ status: 'denied', denialReason: 'PLATFORM_UPGRADE_REQUIRED', messageId: null, threadId: null, replayed: false });
});
