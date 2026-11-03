import { definePermissionFlag } from 'twenty-sdk/define';
import { PERMISSION_WHATSAPP_ADMIN } from '../constants/tool-identifiers';

export default definePermissionFlag({
  universalIdentifier: PERMISSION_WHATSAPP_ADMIN,
  key: 'WHATSAPP_ADMIN',
  label: 'WhatsApp admin',
  description: 'Use WhatsApp admin AI tools',
  permissionType: 'tool',
});
