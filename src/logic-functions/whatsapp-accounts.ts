import { defineLogicFunction } from 'twenty-sdk/define';
import { WHATSAPP_ACCOUNTS } from '../constants/tool-identifiers';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '../server/tool-contracts';
import { executeWhatsappTool } from '../server/tool-operations';
import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';

export const handler = (input: unknown, context?: WhatsappToolContext) =>
  authenticatedTool(TOOL_SCHEMAS['whatsapp-accounts'], input, context, (values) => executeWhatsappTool('whatsapp-accounts', values));

export default defineLogicFunction({
  universalIdentifier: WHATSAPP_ACCOUNTS,
  name: 'whatsapp-accounts',
  description: TOOL_DESCRIPTIONS['whatsapp-accounts'],
  timeoutSeconds: 60,
  toolTriggerSettings: toolTrigger(TOOL_SCHEMAS['whatsapp-accounts'], false),
  handler,
});
