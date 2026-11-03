import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_GET_CAPABILITIES } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-get-capabilities'], input, context, (values) => executeWhatsappTool('whatsapp-get-capabilities', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_GET_CAPABILITIES,
  name: 'whatsapp-get-capabilities',
  description: TOOL_DESCRIPTIONS['whatsapp-get-capabilities'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-get-capabilities'], false),
  handler,
});
