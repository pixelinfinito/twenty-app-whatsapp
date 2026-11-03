import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_WEBHOOK_REPLAY_ROUTE } from '../constants/universal-identifiers';
import { handler } from '../server/operation-webhook-replay-route';
export * from '../server/operation-webhook-replay-route';

export default defineLogicFunction({
  universalIdentifier: LF_WEBHOOK_REPLAY_ROUTE,
  name: 'wa-webhook-replay-route',
  description:
    'Lists the raw webhook log and re-drives stored deliveries through the original processors.',
  timeoutSeconds: 120,
  httpRouteTriggerSettings: {
    path: '/whatsapp/replay',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
