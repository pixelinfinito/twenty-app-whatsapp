import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_SEND_MESSAGE } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-send-message'], input, context, (values) => executeWhatsappTool('whatsapp-send-message', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_SEND_MESSAGE,
  name: 'whatsapp-send-message',
  description: TOOL_DESCRIPTIONS['whatsapp-send-message'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-send-message'], false),
  handler,
});
