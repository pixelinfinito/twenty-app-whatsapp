import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_CONSENT } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-consent'], input, context, (values) => executeWhatsappTool('whatsapp-consent', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_CONSENT,
  name: 'whatsapp-consent',
  description: TOOL_DESCRIPTIONS['whatsapp-consent'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-consent'], false),
  handler,
});
