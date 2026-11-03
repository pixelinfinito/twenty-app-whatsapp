import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_WEBHOOKS } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-webhooks'], input, context, (values) => executeWhatsappTool('whatsapp-webhooks', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_WEBHOOKS,
  name: 'whatsapp-webhooks',
  description: TOOL_DESCRIPTIONS['whatsapp-webhooks'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-webhooks'], true),
  handler,
});
