import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_TEMPLATES } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-templates'], input, context, (values) => executeWhatsappTool('whatsapp-templates', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_TEMPLATES,
  name: 'whatsapp-templates',
  description: TOOL_DESCRIPTIONS['whatsapp-templates'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-templates'], false),
  handler,
});
