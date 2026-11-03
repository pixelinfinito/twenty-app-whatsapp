import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_CONSENT_ROUTE } from '../constants/universal-identifiers';
import { handler } from '../server/operation-consent-route';
export * from '../server/operation-consent-route';

export default defineLogicFunction({
  universalIdentifier: LF_CONSENT_ROUTE,
  name: 'wa-consent-route',
  description:
    'Records consent decisions, imports them in batches, reads the evidence trail, and performs subject erasure.',
  timeoutSeconds: 60,
  httpRouteTriggerSettings: {
    path: '/whatsapp/consent',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
