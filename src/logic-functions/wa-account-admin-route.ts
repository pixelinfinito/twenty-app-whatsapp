import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_ACCOUNT_ADMIN_ROUTE } from '../constants/universal-identifiers';
import { handler } from '../server/operation-account-admin-route';
export * from '../server/operation-account-admin-route';

export default defineLogicFunction({
  universalIdentifier: LF_ACCOUNT_ADMIN_ROUTE,
  name: 'wa-account-admin-route',
  description:
    'Connects, tests and disconnects WhatsApp numbers, writing the workspace routing claim.',
  timeoutSeconds: 30,
  httpRouteTriggerSettings: {
    path: '/whatsapp/account',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
