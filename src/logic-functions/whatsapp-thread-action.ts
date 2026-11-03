import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_THREAD_ACTION } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-thread-action'], input, context, (values) => executeWhatsappTool('whatsapp-thread-action', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_THREAD_ACTION,
  name: 'whatsapp-thread-action',
  description: TOOL_DESCRIPTIONS['whatsapp-thread-action'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-thread-action'], false),
  handler,
});
