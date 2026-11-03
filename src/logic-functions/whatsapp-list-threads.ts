import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_LIST_THREADS } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-list-threads'], input, context, (values) => executeWhatsappTool('whatsapp-list-threads', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_LIST_THREADS,
  name: 'whatsapp-list-threads',
  description: TOOL_DESCRIPTIONS['whatsapp-list-threads'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-list-threads'], false),
  handler,
});
