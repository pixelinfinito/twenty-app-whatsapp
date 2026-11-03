import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_INBOX_FEED_ROUTE } from '../constants/universal-identifiers';
import { handler } from '../server/operation-inbox-feed-route';
export * from '../server/operation-inbox-feed-route';

export default defineLogicFunction({
  universalIdentifier: LF_INBOX_FEED_ROUTE,
  name: 'wa-inbox-feed-route',
  description:
    'The single aggregated read every WhatsApp front component polls: thread, inbox, campaign and bootstrap scopes.',
  timeoutSeconds: 20,
  httpRouteTriggerSettings: {
    path: '/whatsapp/feed',
    httpMethod: 'GET',
    isAuthRequired: true,
  },
  handler,
});
