import { PERMISSION_WHATSAPP_OPERATOR } from '../constants/tool-identifiers';
import { SystemPermissionFlag, STANDARD_OBJECT, defineRole } from 'twenty-sdk/define';

import {
  OBJ_ACCOUNT,
  OBJ_CAMPAIGN,
  OBJ_CAMPAIGN_RECIPIENT,
  OBJ_CONSENT_EVENT,
  OBJ_MESSAGE,
  OBJ_TEMPLATE,
  OBJ_THREAD,
  ROLE_AGENT,
} from 'src/constants/universal-identifiers';

const readOnly = (objectUniversalIdentifier: string, universalIdentifier: string) => ({
  universalIdentifier,
  objectUniversalIdentifier,
  canReadObjectRecords: true,
  canUpdateObjectRecords: false,
  canSoftDeleteObjectRecords: false,
  canDestroyObjectRecords: false,
});

/**
 * A sales rep (SEC-5).
 *
 * Can work conversations and send within policy; cannot publish templates,
 * connect numbers, or touch campaigns. Messages are read-only even for agents —
 * they are written by the app, and a hand-edited record would desynchronise
 * from Meta.
 *
 * Object permissions protect the Core API. They do **not** protect the app's own
 * HTTP routes, which run as the app: every route re-checks the caller's role
 * server-side. A hidden button is a convenience, never a control.
 */
export default defineRole({
  universalIdentifier: ROLE_AGENT,
  label: 'WhatsApp Agent',
  description:
    'Work WhatsApp conversations: read and reply within the service window, send published templates, assign and close threads.',
  icon: 'IconHeadset',
  canBeAssignedToUsers: true,
  canBeAssignedToAgents: true,
  canBeAssignedToApiKeys: true,
  canUpdateAllSettings: false,
  canAccessAllTools: false,
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  permissionFlagUniversalIdentifiers: [PERMISSION_WHATSAPP_OPERATOR, SystemPermissionFlag.UPLOAD_FILE, SystemPermissionFlag.DOWNLOAD_FILE],
  objectPermissions: [
    { universalIdentifier: 'f922e6c1-7466-40ac-a39f-9d28c412e0bb', objectUniversalIdentifier: STANDARD_OBJECT.messageList.universalIdentifier, canReadObjectRecords: true, canUpdateObjectRecords: false, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
    { universalIdentifier: '10d4a813-778c-4bc5-aa76-3a76c0004c2e', objectUniversalIdentifier: STANDARD_OBJECT.messageListMember.universalIdentifier, canReadObjectRecords: true, canUpdateObjectRecords: false, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
    { universalIdentifier: '636188ff-a006-4e26-a089-4c750d1352a4', objectUniversalIdentifier: STANDARD_OBJECT.person.universalIdentifier, canReadObjectRecords: true, canUpdateObjectRecords: false, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
    { universalIdentifier: '3eeab926-70ae-47fb-b5c3-bc9edc5ddb2e', objectUniversalIdentifier: STANDARD_OBJECT.workspaceMember.universalIdentifier, canReadObjectRecords: true, canUpdateObjectRecords: false, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false },
    /**
     * Threads are **read-only even for agents**, and this is a security
     * control rather than tidiness: the outbound sender's binding re-check
     * trusts `serviceWindowExpiresAt`, `isBlocked` and `personId`, so a direct
     * Core-API write to any of them would let an agent reopen a closed window,
     * unblock a suppressed conversation or detach an opted-out contact without
     * any route's validation or audit. Every legitimate mutation goes through
     * `wa-thread-actions-route`, which runs as the app.
     */
    readOnly(OBJ_THREAD, 'e1b4f0a7-3c62-4d95-8f27-6a3e9c1b5d80'),
    readOnly(OBJ_MESSAGE, 'b7c2e5d9-8a14-4f36-9b50-2d7f1a4c6e93'),
    readOnly(OBJ_TEMPLATE, '4f9a1c6b-2e58-4703-8d1f-5b8c3a7e2d46'),
    readOnly(OBJ_ACCOUNT, '8d3e7b2a-5f19-4c84-9a06-1e4b7d9c3f52'),
    readOnly(OBJ_CAMPAIGN, '2c6f9d4e-7b03-4a51-8e39-6f1a5c8b2d74'),
    readOnly(OBJ_CAMPAIGN_RECIPIENT, '5a8b3f1c-9d67-4e20-8c74-3b6e2a9f5d18'),
    readOnly(OBJ_CONSENT_EVENT, '9e4c1a7d-6b38-4f52-8017-7d2c5b9e3a64'),
  ],
});
