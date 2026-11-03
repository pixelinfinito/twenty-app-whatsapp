import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_GET_THREAD } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-get-thread'], input, context, (values) => executeWhatsappTool('whatsapp-get-thread', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_GET_THREAD,
  name: 'whatsapp-get-thread',
  description: TOOL_DESCRIPTIONS['whatsapp-get-thread'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-get-thread'], false),
  handler,
});
