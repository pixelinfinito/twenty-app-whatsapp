import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_THREAD_ACTIONS_ROUTE } from '../constants/universal-identifiers';
import { handler } from '../server/operation-thread-actions-route';
export * from '../server/operation-thread-actions-route';

export default defineLogicFunction({
  universalIdentifier: LF_THREAD_ACTIONS_ROUTE,
  name: 'wa-thread-actions-route',
  description:
    'Assign, close, block, re-link and mark-read actions on a WhatsApp conversation.',
  timeoutSeconds: 30,
  httpRouteTriggerSettings: {
    path: '/whatsapp/thread',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
