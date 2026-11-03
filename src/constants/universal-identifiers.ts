/**
 * Every hand-assigned universal identifier for this app.
 *
 * These values are permanent (AR-4, specs/appendix-c-uuid-registry.md). Twenty
 * matches manifest entities to existing metadata by `universalIdentifier`, so
 * changing one orphans production data: a new object appears empty beside the
 * old one, and a changed logic-function id silently changes the Meta callback
 * URL.
 *
 * Field identifiers are NOT here — they are derived in `field-identifiers.ts`
 * via `getFieldUniversalIdentifier` (specs/00 D-11).
 */

export const APP_DISPLAY_NAME = 'WhatsApp';
export const APP_DESCRIPTION =
  'Two-way WhatsApp messaging inside your CRM: a shared inbox, conversations on the Person record, approved templates, consent tracking and marketing campaigns — powered by the Meta WhatsApp Cloud API.';

export const APPLICATION_UNIVERSAL_IDENTIFIER = 'c2c78378-ef25-465b-8aec-811dd72294e2';
export const DEFAULT_ROLE_UNIVERSAL_IDENTIFIER = 'dc3b8f39-06c0-4b60-b53d-0dabc4fe6046';

// ─── Objects ────────────────────────────────────────────────────────────────
export const OBJ_ACCOUNT = 'cd160140-588c-4228-a5b2-bc4eacd98c7a';
export const OBJ_THREAD = '9a056cfe-e761-4f52-a108-dbd4768cb649';
export const OBJ_MESSAGE = 'ba252191-22d5-40f4-b742-8b903722578a';
export const OBJ_TEMPLATE = 'ba47db24-593a-47c1-8ca3-5b4300296060';
export const OBJ_CONSENT_EVENT = '3800b122-6d3c-4a18-9511-21c69885bd5e';
export const OBJ_CAMPAIGN = '4ce9aed9-ea3c-44b6-9c32-1f2ea78f1dde';
export const OBJ_CAMPAIGN_RECIPIENT = '23d2ea06-96ce-464f-a26a-57f7ce3f719a';
export const OBJ_WEBHOOK_EVENT = '1df82127-1cf2-472c-9eee-968c233eff48';

// ─── Logic functions ────────────────────────────────────────────────────────
/** The Meta callback URL is `/webhooks/server/{this}` — see specs/00 D-1. */
export const LF_WEBHOOK_RESOLVER = 'bb76f114-7843-4a09-af64-9ceca78479cd';
export const LF_WEBHOOK_VERIFY = '5f0a6d21-9c34-4bd0-9a4e-7c1f0b3d8e42';
export const LF_WEBHOOK_INGEST = 'f0ea2b51-fee4-48f5-be82-ab53f17084d4';
export const LF_INBOUND_PROCESSOR = '465dc426-fb48-46c8-9617-3005c9d3126b';
export const LF_STATUS_PROCESSOR = '2368666b-845f-45d5-8a36-c47f5d938aa9';
export const LF_TEMPLATE_EVENT = '0cfb67ed-bf67-4d79-9426-b89881a81bdb';
export const LF_ACCOUNT_EVENT = '32308b5c-2f63-400d-bd63-36eb92c5ea77';
export const LF_MEDIA_WORKER = '411818b2-ddfb-417b-8935-950eb5e25d91';
export const LF_OUTBOUND_SENDER = '317c4b9a-8a01-4813-b085-9874b5502457';
export const LF_SEND_MESSAGE_ROUTE = '7dfb20e7-f1bc-4a1a-8dfb-a8106007f31a';
export const LF_SEND_TEMPLATE_ACTION = 'eae099e6-aa2a-4d17-ab28-46ff3ab7b2e7';
export const LF_LIST_SENDABLE_TEMPLATES_TOOL = '35216977-0ac5-47ce-9610-f3e47fd37d37';
export const LF_SEND_TEMPLATE_TOOL = 'fb044e6d-5195-4c71-98c0-d5f60ad18cf4';
export const LF_TEMPLATE_SYNC = '4640b582-2185-4c2b-95f0-af63a52cf893';
export const LF_TEMPLATE_SUBMIT = '7b31c0da-6e48-4a2f-9d15-3ac8e2f47b90';
export const LF_WINDOW_SWEEPER = 'd673bc2e-a865-42c5-a230-48e213e37c95';
export const LF_HEALTH_CHECK = '841025d1-5a05-4a12-9180-753d7f7f5292';
export const LF_CAMPAIGN_SNAPSHOT = 'e0fdfbaf-cf80-4390-9252-d8c64c1cad20';
export const LF_CAMPAIGN_RUNNER = 'eb3bac37-7607-4a51-bdf9-71064a8fe765';
export const LF_CAMPAIGN_CONTROL = 'a6f8c3d0-5ce8-4ca4-ac04-75606c255ad0';
export const LF_ACCOUNT_ADMIN_ROUTE = 'a0ce5bf6-0461-476a-9d99-52f6fde6019e';
export const LF_THREAD_ACTIONS_ROUTE = 'a34163dd-e1f2-4b44-8fcf-47f8c5dec37e';
export const LF_CONSENT_ROUTE = 'ea75ba39-8fde-4559-bb51-81a12ee67b14';
export const LF_CONSENT_KEYWORD = 'c8e4a7b6-1d52-4f39-8a07-2b6e5d90c134';
export const LF_CONSENT_BACKFILL = '90904cd6-e3ff-4778-9678-54fc10bf30aa';
export const LF_INBOX_FEED_ROUTE = '75d66009-e7ba-473b-9995-08abe6fe2cbd';
export const LF_STATS_ROLLUP = 'a570be45-9bd2-491f-9405-6e1c681cf67f';
export const LF_RETENTION_PURGE = '9f112ebd-68c1-478f-956b-285333a41e12';
export const LF_WEBHOOK_REPLAY_ROUTE = '416e05c5-968a-462a-b0b8-48cc34c63d7f';
export const LF_POST_INSTALL = 'dcea2279-13e2-491d-83b1-74387ff4e872';
export const LF_UNINSTALL = '4f0711c1-5bfe-49b5-995c-cdbc1680820f';

// ─── Front components ───────────────────────────────────────────────────────
export const FC_PERSON_THREAD = '9552182f-3626-425e-a63b-31cd56ee7cd1';
export const FC_SIDE_PANEL_CHAT = '8b1df744-2ab3-4239-981f-61e5e6284d47';
export const FC_INBOX = '02d97231-2f41-457f-add2-e56c5c8cd3c3';
export const FC_CAMPAIGNS = 'feb002a1-ee1e-4ecd-8d82-1bcbfd031bef';
export const FC_SETTINGS = '1ef57cdd-06aa-430e-aa67-f789b7cd9bfa';
export const FC_INBOX_TOASTER = '2d9c81ae-40f7-4bb6-9a55-6e3f01c7d8b2';

// ─── Page layouts, tabs, widgets ────────────────────────────────────────────
export const PL_INBOX = '24620700-45ae-49aa-b686-879b22ca8cbf';
export const PL_INBOX_TAB = 'f3cf1e47-4050-41f9-97c9-6d90695cbab6';
export const PL_INBOX_WIDGET = '22b6b6ff-cdda-4ca1-bd06-c06e309ac6ef';
export const PL_CAMPAIGNS = '87b470e5-832e-4fcf-8762-6e10482570e1';
export const PL_CAMPAIGNS_TAB = '08d96133-9e3c-4167-91ee-54295691108e';
export const PL_CAMPAIGNS_WIDGET = 'c1054099-011f-4a17-8e77-aa046f97aad9';
export const PLT_PERSON_WHATSAPP = '137e43b2-9c3b-4545-a423-a869b9132d9a';
export const PLT_PERSON_WHATSAPP_WIDGET = '2fc5c224-0b0e-4d38-b286-fa49bfbde311';

// ─── Navigation and command menu ────────────────────────────────────────────
export const NAV_WHATSAPP_FOLDER = '4d7b8b2b-237b-4abb-8a09-1aa311540654';
export const NAV_INBOX = '40dac02c-cdcb-4d72-8235-b0d2d45ad578';
export const NAV_CAMPAIGNS = '24b7fa8a-1e64-4b55-8fa0-eaddf2aa9514';
export const CMI_OPEN_CHAT = '60230d67-8b27-4fa7-af25-f482f0215615';

// ─── Twenty's own objects, as literals ──────────────────────────────────────
/**
 * `person`, copied from `STANDARD_OBJECT.person.universalIdentifier`.
 *
 * The same value, deliberately duplicated: the logic-function bundler replaces
 * everything imported from `twenty-sdk/define` with a stub, so reading it from
 * there inside a running function yields `undefined` — and nothing warns. The
 * symptom is a lookup that quietly returns nothing, which is exactly how the
 * campaign builder's view list came back empty. A test asserts the two stay
 * equal (specs/00 D-11, server/metadata-ids.ts).
 */
export const PERSON_OBJECT_UID = '20202020-e674-48e5-a542-72570eee7213';

/**
 * The Person record page's Fields-panel view
 * (`STANDARD_OBJECT.person.views.personRecordPageFields`), as a literal for the
 * same bundler-stub reason as `PERSON_OBJECT_UID`. Post-install patches this
 * view's rows to hide the app's plumbing relations; the identifiers test holds
 * the copy equal to the SDK's value.
 */
export const PERSON_FIELDS_VIEW_UID = '7f34ab76-9b33-595a-bd22-d8d434147c8e';

// ─── Roles ──────────────────────────────────────────────────────────────────
export const ROLE_AGENT = '8a466b1b-a44e-48fb-9864-63af63b3edc3';
export const ROLE_ADMIN = 'b97f72bf-83f7-4327-9024-c6b625de3f38';

// ─── Composite indexes ──────────────────────────────────────────────────────
/**
 * Single-column uniqueness (`phoneNumberId`, `wamid`, `dedupKey`) is declared
 * with `isUnique: true` on the field itself, which provisions the index; only
 * composite indexes are declared here (deviation noted in specs/02 §12).
 */
export const IDX_THREAD_ACCOUNT_WAID = 'f5070de9-8e6d-4156-90c1-3aebdb49c3f7';
export const IDX_MESSAGE_THREAD_TS = '7a2406d4-873a-4c0a-b4f3-f1e1894c1fbb';
export const IDX_TEMPLATE_ACCOUNT_META = 'e5992578-a239-4e76-b487-0984a72d5d7d';
export const IDX_RECIPIENT_CAMPAIGN_PERSON = '1409fbe9-5357-44b0-acde-87c81d2bb8fc';
export const IDX_RECIPIENT_CAMPAIGN_STATUS = '0ffa72a9-8c24-4fc6-bcc2-c5437c1ed43f';
