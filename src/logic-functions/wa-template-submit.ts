import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_TEMPLATE_SUBMIT } from '../constants/universal-identifiers';
import { handler } from '../server/operation-template-submit';
export * from '../server/operation-template-submit';

export default defineLogicFunction({
  universalIdentifier: LF_TEMPLATE_SUBMIT,
  name: 'wa-template-submit',
  description:
    'Submits a new template to Meta for review, with example validation and a local hourly cap.',
  timeoutSeconds: 60,
  httpRouteTriggerSettings: {
    path: '/whatsapp/template',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
