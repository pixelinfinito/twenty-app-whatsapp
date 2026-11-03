import { findPersonById } from '../server/repositories/people';
import { findTemplateById } from '../server/repositories/templates';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';
import { once } from '../server/tool-store';
import { toolScope } from '../server/tool-scope';
import type { InputJsonSchema } from 'twenty-sdk/logic-function';
import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_SEND_TEMPLATE_TOOL } from '../constants/universal-identifiers';
import { SOURCE_KIND } from '../domain/constants';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { isUuid } from '../server/repositories/base';
import {
  ACTION_REFUSAL,
  executeTemplateSend,
  type ActionRefusal,
} from '../server/template-send';

export const sendTemplateInputSchema: InputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    personId: {
      type: 'string',
      description: 'Exact Twenty Person id selected through Twenty MCP; never a phone number.',
    },
    templateId: {
      type: 'string',
      description:
        'Exact template record id returned by whatsapp-list-sendable-templates. Names are not accepted.',
    },
    accountId: {
      type: 'string',
      description:
        'Optional account id. Omit only when exactly one connected WhatsApp account exists.',
    },
    parameters: {
      type: 'object',
      additionalProperties: true,
      description:
        'Template values matching the parameter contract returned by whatsapp-list-sendable-templates.',
    },
    createThreadIfMissing: {
      type: 'boolean',
      description:
        'Defaults to true. Set false only when the request requires an existing conversation.',
    },
    requestId: {
      type: 'string',
      description:
        'Required UUID v4 idempotency key. Reuse it for retries of this intent; never reuse it for different values.',
    },
  },
  required: ['personId', 'templateId', 'parameters', 'requestId'],
};

export const INVALID_REQUEST_ID = 'INVALID_REQUEST_ID' as const;

export type SendTemplateToolInput = {
  personId?: unknown;
  templateId?: unknown;
  accountId?: unknown;
  parameters?: unknown;
  createThreadIfMissing?: unknown;
  requestId?: unknown;
};

type ToolDenial = ActionRefusal | typeof INVALID_REQUEST_ID;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuidV4 = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V4.test(value.trim());

const denied = (denialReason: ToolDenial, threadId: string | null = null) => ({
  status: 'denied' as const,
  messageId: null,
  threadId,
  replayed: false as const,
  denialReason,
  warnings: [] as string[],
});

const objectParameters = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const runSendTemplateTool = async (input: SendTemplateToolInput) => {
  const personId = typeof input.personId === 'string' ? input.personId.trim() : '';
  const templateId = typeof input.templateId === 'string' ? input.templateId.trim() : '';
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : '';
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';

  if (!isUuidV4(requestId)) return denied(INVALID_REQUEST_ID);
  if (!isUuid(personId)) return denied(ACTION_REFUSAL.PERSON_UNKNOWN);
  if (!isUuid(templateId)) return denied(ACTION_REFUSAL.TEMPLATE_UNKNOWN);
  if (accountId.length > 0 && !isUuid(accountId)) {
    return denied(ACTION_REFUSAL.ACCOUNT_UNKNOWN);
  }
  if (!objectParameters(input.parameters)) {
    return denied(ACTION_REFUSAL.MISSING_VARIABLES);
  }

  const result = await executeTemplateSend(
    {
      personId,
      templateId,
      ...(accountId.length === 0 ? {} : { accountId }),
      parameters: input.parameters,
      createThreadIfMissing: input.createThreadIfMissing,
    },
    {
      sourceKind: SOURCE_KIND.AI_AGENT,
      sentById: toolScope()?.caller.workspaceMemberId ?? null,
      requestId: requestId.toLowerCase(),
      channel: toolScope()?.principal.surface === 'AI_TOOL' ? 'TWENTY_AI' : 'TWENTY_MCP',
      accountResolution: 'exact',
      templateResolution: 'exact',
    },
  );

  if (result.status === 'denied') return result;

  return { ...result, delivery: 'queued' as const };
};

const executeHandler = async (input: SendTemplateToolInput) => {
  try {
    const result = await runSendTemplateTool(input ?? {});

    if (result.status === 'accepted') {
      count(
        result.replayed
          ? METRIC.MCP_TEMPLATE_SEND_REPLAYED
          : METRIC.MCP_TEMPLATE_SEND_ACCEPTED,
      );
    } else {
      count(
        result.denialReason === ACTION_REFUSAL.IDEMPOTENCY_CONFLICT
          ? METRIC.MCP_TEMPLATE_SEND_CONFLICT
          : METRIC.MCP_TEMPLATE_SEND_DENIED,
      );
    }

    logger.info('wa.mcp.template_send', {
      requestId:
        typeof input?.requestId === 'string' && isUuidV4(input.requestId)
          ? input.requestId.toLowerCase()
          : null,
      status: result.status,
      messageId: result.messageId,
      threadId: result.threadId,
      replayed: result.replayed,
      ...(result.status === 'denied' ? { reason: result.denialReason } : {}),
    });

    return result;
  } catch (error) {
    count(METRIC.MCP_TEMPLATE_SEND_FAILED);
    logger.error('wa.mcp.template_send_failed', describeError(error));
    throw error;
  }
};

export const handler = (input: SendTemplateToolInput, context?: WhatsappToolContext) =>
  authenticatedTool(sendTemplateInputSchema, input, context, async () => {
    const normalized = { ...input,
      personId: typeof input.personId === 'string' ? input.personId.trim() : input.personId,
      templateId: typeof input.templateId === 'string' ? input.templateId.trim() : input.templateId,
      accountId: typeof input.accountId === 'string' ? input.accountId.trim() : input.accountId,
      requestId: typeof input.requestId === 'string' ? input.requestId.trim().toLowerCase() : input.requestId,
    };
    if (isUuid(normalized.personId) && !(await findPersonById(normalized.personId))) return denied(ACTION_REFUSAL.PERSON_UNKNOWN);
    if (isUuid(normalized.templateId) && !(await findTemplateById(normalized.templateId))) return denied(ACTION_REFUSAL.TEMPLATE_UNKNOWN);
    const result = await once(normalized.requestId, 'whatsapp-send-template', normalized, () => executeHandler(normalized));
    return result;
  }).then((result) => result.status === 'denied' && 'code' in result
    ? { ...result, denialReason: result.code, messageId: null, threadId: null, replayed: false }
    : result);

export default defineLogicFunction({
  universalIdentifier: LF_SEND_TEMPLATE_TOOL,
  name: 'whatsapp-send-template',
  description:
    'Queues one published and Meta-approved WhatsApp template to one exact Twenty CRM Person. This changes external state and may contact a customer. Resolve the Person and call whatsapp-list-sendable-templates first. Never retry with a new requestId when the result is uncertain.',
  timeoutSeconds: 30,
  toolTriggerSettings: toolTrigger(sendTemplateInputSchema),
  handler,
});
