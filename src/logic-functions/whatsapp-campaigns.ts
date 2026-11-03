import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_CAMPAIGNS } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-campaigns'], input, context, (values) => executeWhatsappTool('whatsapp-campaigns', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_CAMPAIGNS,
  name: 'whatsapp-campaigns',
  description: TOOL_DESCRIPTIONS['whatsapp-campaigns'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-campaigns'], false),
  handler,
});
