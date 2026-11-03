import { definePermissionFlag } from 'twenty-sdk/define';
import { PERMISSION_WHATSAPP_OPERATOR } from '../constants/tool-identifiers';

export default definePermissionFlag({
  universalIdentifier: PERMISSION_WHATSAPP_OPERATOR,
  key: 'WHATSAPP_OPERATOR',
  label: 'WhatsApp operator',
  description: 'Use WhatsApp operator AI tools',
  permissionType: 'tool',
});
