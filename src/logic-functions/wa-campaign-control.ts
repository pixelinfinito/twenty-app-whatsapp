import { defineLogicFunction } from 'twenty-sdk/define';
import { LF_CAMPAIGN_CONTROL } from '../constants/universal-identifiers';
import { handler } from '../server/operation-campaign-control';
export * from '../server/operation-campaign-control';

export default defineLogicFunction({
  universalIdentifier: LF_CAMPAIGN_CONTROL,
  name: 'wa-campaign-control',
  description:
    'Builds, previews, pre-flights, launches, pauses, resumes, cancels, archives and unarchives campaigns, and deletes ones that never launched — admin-only and audited.',
  timeoutSeconds: 60,
  httpRouteTriggerSettings: {
    path: '/whatsapp/campaign',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
