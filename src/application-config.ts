import { defineApplication, FieldType } from 'twenty-sdk/define';

import {
  APP_DESCRIPTION,
  APP_DISPLAY_NAME,
  APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

/**
 * Meta credentials are `serverVariables` marked secret (AR-2, SEC-1): Twenty
 * encrypts them at rest, injects them into logic functions as `process.env`, and
 * never sends them to front components. They are read only through
 * `requireSecret()`, which fails closed — there is no default, no `?? ''`, and
 * no "development fallback".
 *
 * Everything operationally tunable is an `applicationVariable` rather than a
 * code literal (NFR-M1). Values always arrive as strings, so every read parses
 * explicitly.
 *
 * Per-account settings that must differ between numbers (throttle, calling code,
 * auto-creation, test flag) are record fields on `whatsappAccount`, not
 * variables — resolution is account field → application variable → constant.
 */
export default defineApplication({
  universalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER,
  displayName: APP_DISPLAY_NAME,
  description: APP_DESCRIPTION,
  /**
   * The filename carries the cache bust, and it has to.
   *
   * Public assets are served from a path-derived URL with
   * `Cache-Control: public, max-age=3600` and no content hash, so replacing the
   * bytes at `public/logo.svg` leaves every browser that had already loaded it
   * showing the old icon for up to an hour — with the server serving the new one
   * the whole time, which is an unfalsifiable bug report. A new filename is a new
   * URL. Rename this file whenever the logo actually changes.
   *
   * The logo matters more than a marketplace tile: Twenty renders it in the
   * header of every workflow step this app contributes, so it is what an author
   * sees above "Send WhatsApp template". `workflowActionTriggerSettings.icon` is
   * *not* used there.
   */
  logo: 'public/logo-whatsapp.svg',
  author: 'Pixel Infinito',
  websiteUrl: 'https://pixel.ao',
  /**
   * 8:5 ratio (3200×2000), rendered from live product screenshots. Like the
   * logo, the filenames carry a version suffix as the cache bust — bump the
   * suffix when the artwork changes.
   */
  galleryImages: [
    'public/cover-whatsapp-v1.png',
    'public/gallery-inbox-v1.png',
    'public/gallery-campaigns-v1.png',
    'public/gallery-templates-v1.png',
  ],
  category: 'Communication',
  serverVariables: {
    META_APP_ID: {
      description:
        'Meta app ID (App Dashboard → Settings → Basic). Public in OAuth flows; shown in the settings health panel.',
      isSecret: false,
      isRequired: true,
      type: FieldType.TEXT,
    },
    META_APP_SECRET: {
      description:
        'Meta App Secret. Used to verify the X-Hub-Signature-256 on every webhook, over the raw request body. Stored encrypted; never exposed in API responses.',
      isSecret: true,
      isRequired: true,
      type: FieldType.TEXT,
    },
    META_ACCESS_TOKEN: {
      description:
        'System User token with exactly whatsapp_business_messaging and whatsapp_business_management. Rotating it is a settings edit — no redeploy, no downtime.',
      isSecret: true,
      isRequired: true,
      type: FieldType.TEXT,
    },
    META_VERIFY_TOKEN: {
      description:
        'Random string echoed during Meta’s GET verification handshake. Generate with `openssl rand -hex 32` and paste the same value into the Meta webhook configuration.',
      isSecret: true,
      isRequired: true,
      type: FieldType.TEXT,
    },
  },
  applicationVariables: {
    META_GRAPH_VERSION: {
      universalIdentifier: '5c2f5cf1-a3a6-4b93-9c53-5b1ef0f7d2a1',
      description: 'Pinned Graph API version. Review at least annually — versions live ~2 years.',
      value: 'v26.0',
      type: FieldType.TEXT,
    },
    WA_DEFAULT_COUNTRY_CALLING_CODE: {
      universalIdentifier: '0b8dbe0c-2f2e-4a35-8b64-3c6d0d21f4a7',
      description:
        'The country calling code only — 1 to 3 digits, e.g. +244 — applied as a prefix when normalising nationally-formatted numbers (FR-CID-1). A full phone number here breaks every send to a contact stored without a country code.',
      value: '+244',
      type: FieldType.TEXT,
    },
    WA_SEND_THROTTLE_PER_SECOND: {
      universalIdentifier: 'a2f2f0f7-3f5f-42e6-9f2f-6a4a8f0e5d31',
      description: 'Default per-number send ceiling, kept well below Meta’s 80/s (AR-12).',
      value: '20',
      type: FieldType.NUMBER,
    },
    WA_INTERACTIVE_LANE_SHARE: {
      universalIdentifier: 'd2c0a4b6-7f1a-4a2b-9e8c-1d5f3a7b9c02',
      description:
        'Share of the throttle reserved for interactive 1:1 sends, so a running campaign can never delay a rep (AR-19, NFR-S5).',
      value: '0.4',
      type: FieldType.NUMBER,
    },
    WA_RECIPIENT_MIN_SPACING_MS: {
      universalIdentifier: '6a1c9f4d-8b2e-4c7a-9d13-2e8f5b0a7c64',
      description: 'Minimum gap between two sends to the same contact, avoiding Meta error 131056.',
      value: '250',
      type: FieldType.NUMBER,
    },
    WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES: {
      universalIdentifier: 'f4b7d2a1-5c93-4e6f-8a20-9b1d3c7e5f48',
      description:
        'Inbound media at or under this size is downloaded automatically; larger media is stored deferred with a download-on-demand action (specs/00 D-8).',
      value: '26214400',
      type: FieldType.NUMBER,
    },
    WA_SERVICE_WINDOW_HOURS: {
      universalIdentifier: '3e5a8c02-9d47-4b1f-8e6a-7c2b4d9f1a53',
      description: 'Customer service window. Meta’s rule is 24h; configurable for staging tests.',
      value: '24',
      type: FieldType.NUMBER,
    },
    WA_FEP_WINDOW_HOURS: {
      universalIdentifier: '8c4f1b7e-2a69-4d35-9f8b-0e3a6c5d2b91',
      description: 'Free-entry-point window for Click-to-WhatsApp conversations (FR-IN-6).',
      value: '72',
      type: FieldType.NUMBER,
    },
    WA_OPT_OUT_KEYWORDS: {
      universalIdentifier: '1d7e3a9c-4f82-4b56-9c1e-8a5d2f7b3e60',
      description:
        'Exact-token matches (accent- and case-insensitive) that opt a contact out and trigger one confirmation (FR-CON-3). Removing a word here that WA_OPT_IN_CONFIRMATION_* still tells customers to reply leaves a consent path that fails silently; the health panel flags it.',
      value: ['STOP', 'SAIR', 'PARAR', 'CANCELAR'],
      type: FieldType.ARRAY,
    },
    WA_OPT_IN_KEYWORDS: {
      universalIdentifier: '9b2c5d8f-3e17-4a94-8d6b-5f1c0a3e7d24',
      description: 'Exact-token matches that opt a contact back in.',
      value: ['START', 'INICIAR', 'SIM'],
      type: FieldType.ARRAY,
    },
    WA_POLL_INTERVAL_THREAD_MS: {
      universalIdentifier: '7f3a1c5e-8d24-4b60-9e17-3c8b5a2d6f09',
      description: 'Chat refresh while a conversation is open and focused (specs/00 D-6).',
      value: '3000',
      type: FieldType.NUMBER,
    },
    WA_POLL_INTERVAL_INBOX_MS: {
      universalIdentifier: '2a8d6b3f-1c95-4e72-8b40-6d9f3a1c5e87',
      description: 'Inbox list refresh while focused.',
      value: '8000',
      type: FieldType.NUMBER,
    },
    WA_POLL_INTERVAL_BLURRED_MS: {
      universalIdentifier: 'c5e2f9a7-6b30-4d18-9a52-1f7c4b8e3d06',
      description: 'Refresh interval once the window loses focus.',
      value: '20000',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_BATCH_SIZE: {
      universalIdentifier: 'e9c1a7d5-4f83-462b-8d09-7a3e5c2b1f48',
      description: 'Recipients claimed per runner tick (AR-20).',
      value: '200',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_TIER_RESERVE_PCT: {
      universalIdentifier: '4b7d0e2a-9c56-4318-8f7b-2e5a1d9c6f03',
      description:
        'Share of the daily messaging tier held back for 1:1 sends, so a campaign cannot consume the whole allowance (AR-21).',
      value: '10',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_FAILURE_WINDOW: {
      universalIdentifier: 'a3f6c9b2-5d47-40e1-9c83-6b2f8d1a5e79',
      description: 'How many terminal outcomes the circuit breaker considers (AR-22).',
      value: '100',
      type: FieldType.NUMBER,
    },
    WA_CAMPAIGN_MAX_FAILURE_RATE_PCT: {
      universalIdentifier: '0d5b8e1c-7a24-4f93-8e6d-3c9a2f7b4d15',
      description: 'Failure rate over that window which auto-pauses a campaign (AR-22).',
      value: '10',
      type: FieldType.NUMBER,
    },
    WA_RETENTION_WEBHOOK_EVENT_DAYS: {
      universalIdentifier: 'b8e4a2d6-1f75-4c39-9b02-5d7c3a8f6e14',
      description:
        'Raw webhook log retention. Hard floor of 7 days: Meta retries for 7 days and offers no replay API afterwards, so this table is the only source for reprocessing.',
      value: '30',
      type: FieldType.NUMBER,
    },
    WA_RETENTION_MESSAGE_MONTHS: {
      universalIdentifier: '6c9f2b7a-3e18-4d54-8a71-9b4e0c2d5f83',
      description:
        'Months after which message bodies and media are purged; 0 keeps everything. Purging blanks content but keeps status and cost data, so reporting survives (SEC-9).',
      value: '0',
      type: FieldType.NUMBER,
    },
    WA_TIMELINE_MODE: {
      universalIdentifier: 'f1a7c3e9-8b52-4670-9d34-2a6f5c1b8e07',
      description:
        'How much WhatsApp activity reaches the Person timeline. `summary` (default) records the first message of a conversation, daily firsts, template sends, failures, consent and assignment changes — `all` would add ~50 000 rows/day at the design volume and make the timeline unusable (specs/09 §4.2).',
      value: 'summary',
      type: FieldType.SELECT,
      options: [
        { label: 'All messages', value: 'all' },
        { label: 'Summary', value: 'summary' },
        { label: 'Off', value: 'off' },
      ],
    },
    WA_RATE_MARKETING_USD: {
      universalIdentifier: '5e8b1d4f-2c96-4a73-8f01-7d3a9e6c2b58',
      description:
        'Per delivered marketing message, Rest-of-Africa. Third-party mirrored — verify against Meta’s official rate card (Q-1).',
      value: '0.0225',
      type: FieldType.NUMBER,
    },
    WA_RATE_UTILITY_USD: {
      universalIdentifier: 'c2d7f5a8-9e31-4b64-8c07-1a5e3b9d6f42',
      description: 'Per delivered utility message outside the service window.',
      value: '0.0040',
      type: FieldType.NUMBER,
    },
    WA_RATE_AUTHENTICATION_USD: {
      universalIdentifier: '9a4e7c2b-6f18-4d05-8b93-5c1f2a7e4d69',
      description: 'Per delivered authentication message.',
      value: '0.0040',
      type: FieldType.NUMBER,
    },
    WA_TIME_ZONE: {
      universalIdentifier: '7a1e20e5-4c17-4b3d-9f21-0e6b2c8d5417',
      description:
        'IANA time zone for every rendered date and every day boundary: chat and thread timestamps, the day separators, the {{now.*}} campaign variables, and the "created today" audience filter. Deliberately not the reader\u2019s browser \u2014 a rep must see the customer\u2019s day, or a message sent at 23:30 files itself under tomorrow. An unrecognised name falls back to the default rather than failing to render.',
      value: 'Africa/Luanda',
      type: FieldType.TEXT,
    },
    WA_CONFIRMATION_LOCALE: {
      universalIdentifier: 'ccab3fbb-40a7-4042-bbfb-f4df1f135588',
      description:
        'Language of the automatic opt-in/opt-out confirmation. Not inferred from the keyword the contact typed — the keyword lists are editable, so “STOP” says nothing reliable about the language someone reads (FR-CON-3).',
      value: 'pt',
      type: FieldType.SELECT,
      options: [
        { label: 'Português', value: 'pt' },
        { label: 'English', value: 'en' },
      ],
    },
    WA_OPT_OUT_CONFIRMATION_PT: {
      universalIdentifier: '6ee7ee18-74ad-4843-bab6-1b66f5eded6f',
      description:
        'The single reply sent when a contact opts out in Portuguese. Wording is configurable because counsel reviews it (Q-4) and a legal review must never require a deploy; whatever was sent is stored on the consent event as evidence. Any keyword you name here must still be in WA_OPT_IN_KEYWORDS, or you are telling customers to reply a word that no longer works — write {optInKeyword} instead and it always follows the list. The health panel flags the mismatch.',
      value: 'Não voltará a receber mensagens nossas. Para voltar a receber, responda INICIAR.',
      type: FieldType.TEXT,
    },
    WA_OPT_OUT_CONFIRMATION_EN: {
      universalIdentifier: 'c9140776-6f7c-4882-a624-5437bc56ca97',
      description: 'The same reply in English.',
      value: 'You will not receive further messages from us. Reply START to resume.',
      type: FieldType.TEXT,
    },
    WA_OPT_IN_CONFIRMATION_PT: {
      universalIdentifier: '90115df8-3b79-46a5-8bf2-ad2a92197f8a',
      description:
        'The single reply sent when a contact opts back in, in Portuguese. Any keyword you name here must still be in WA_OPT_OUT_KEYWORDS, or you are telling customers to reply a word that no longer works — write {optOutKeyword} instead and it always follows the list. The health panel flags the mismatch.',
      value: 'Obrigado! Voltará a receber as nossas mensagens. Para parar, responda SAIR.',
      type: FieldType.TEXT,
    },
    WA_OPT_IN_CONFIRMATION_EN: {
      universalIdentifier: '18fd442a-a5f7-46d6-9263-8838cff2408a',
      description: 'The same reply in English.',
      value: 'Thank you! You will receive our messages again. Reply STOP to unsubscribe.',
      type: FieldType.TEXT,
    },
    WA_TEMPLATE_SUBMIT_HOURLY_CAP: {
      universalIdentifier: '25ef2ce1-73ca-40bc-b68b-b099f252d705',
      description:
        'Local ceiling on template submissions per hour. Meta allows 100 per WABA and answers the 101st with an opaque error, so refusing at 90 leaves headroom and produces a message that says what to do (FR-TPL-6).',
      value: '90',
      type: FieldType.NUMBER,
    },
    WA_SEND_READ_RECEIPTS: {
      universalIdentifier: 'baba913a-fb16-4bd2-bfd2-e005bdecbf99',
      description:
        'Marks a conversation read on WhatsApp — the customer sees blue ticks — when a rep opens it. Off by default: it promises the customer a human is present, which is a commitment the business should make deliberately (FR-OUT-8).',
      value: false,
      type: FieldType.BOOLEAN,
    },
    WA_ALLOW_API_KEY_ADMIN: {
      universalIdentifier: '9703dacf-6ba6-4e18-9e09-a8d1b87c1933',
      description:
        'Allow API keys (machine callers) to use the WhatsApp routes with admin authority. Off by default: a key’s assigned role cannot be read, so enabling this promotes every key in the workspace — scope automation to a dedicated, trusted key before turning it on (SEC-5).',
      value: false,
      type: FieldType.BOOLEAN,
    },
    WA_WEBHOOK_STALENESS_HOURS: {
      universalIdentifier: '15259fd1-f7a0-46e6-b337-f77a7dda7541',
      description:
        'Hours without a webhook after which the hourly health check warns. Only applies to numbers that have received an event before, so a newly connected quiet number is not reported as broken (NFR-O3).',
      value: '24',
      type: FieldType.NUMBER,
    },
    WA_AUTO_CLOSE_DAYS: {
      universalIdentifier: '15df15e6-20e0-43f6-a64e-e7c3534473d0',
      description:
        'Days of silence after which the sweeper closes a conversation. `0` disables it. Closing is a CRM label only — it never affects the service window or the ability to send (Q-3).',
      value: '0',
      type: FieldType.NUMBER,
    },
    WA_PROVIDER: {
      universalIdentifier: '7d1c4a9e-5b83-4267-9f0a-3e8b6d2c5a71',
      description:
        'Selects the messaging provider. Only the direct Cloud API driver ships; the seam exists so a BSP driver or a future native channel can replace the transport without touching business logic (AR-18).',
      value: 'META_CLOUD_API',
      type: FieldType.SELECT,
      options: [{ label: 'Meta Cloud API', value: 'META_CLOUD_API' }],
    },
  },
});
