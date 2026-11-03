import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_SEND_MESSAGE_ROUTE } from '../constants/universal-identifiers';
import { handler } from '../server/operation-send-message-route';
export * from '../server/operation-send-message-route';

export default defineLogicFunction({
  universalIdentifier: LF_SEND_MESSAGE_ROUTE,
  name: 'wa-send-message-route',
  description:
    'Accepts a message from the composer, applies the policy gate, and queues it for the sender.',
  timeoutSeconds: 30,
  httpRouteTriggerSettings: {
    path: '/whatsapp/send',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
