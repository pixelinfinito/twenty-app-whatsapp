# WhatsApp for Twenty CRM

Two-way WhatsApp messaging inside [Twenty](https://twenty.com): a shared team inbox, conversations on every Person record, approved templates, consent tracking and marketing campaigns — powered by the official **Meta WhatsApp Cloud API**.

Developed by **Marcos Lisboa** at [Pixel Infinito](https://pixel.ao) · published as [`@pixelinfinito/twenty-app-whatsapp`](https://www.npmjs.com/package/@pixelinfinito/twenty-app-whatsapp).

![WhatsApp for Twenty](public/cover-whatsapp-v1.png)

## What you get

**A shared team inbox.** Filter by yours, unassigned, everyone's, unread or closed. Assignment, blocking and closing are one click, keyboard navigation included, and every action lands on the contact's timeline.

![Shared inbox](public/gallery-inbox-v1.png)

**The 24-hour rule, enforced server-side.** The composer always knows whether you may type: window state, consent, blocking, number quality and template availability are decided by the server and explained in the interface — never silently hidden.

**Templates you can actually use.** Sync from Meta, see which are approved, publish the ones the CRM may render, and fill their parameters from CRM fields with a live preview before sending.

![Template management](public/gallery-templates-v1.png)

**Campaigns with brakes.** Build an audience from a saved view, bind template parameters per recipient, get a cost estimate before launch — while a share of the daily tier is held back for 1:1 traffic and a circuit breaker pauses any campaign whose failure rate climbs.

![Campaigns](public/gallery-campaigns-v1.png)

**Consent that holds up.** Opt-out and opt-in keywords, a single confirmation reply whose wording is a setting rather than a deploy, and an audit event recorded for every change.

**Operations you can see.** A health panel that names which of six things is wrong and what to do about it, the exact callback URL and webhook fields to paste into Meta, and diagnostics for failed deliveries and stuck sends.

**Everything WhatsApp sends, handled.** Text, images, audio, video, documents, stickers, locations, contact cards, reactions and replies all render; anything Meta invents next is stored and shown as an unsupported message rather than dropped.

The interface ships in **English and Portuguese**, following each user's locale.

## Sending attachments

Choose **Photo or video** or **Document**, select a device file, review it, add an optional caption, and send. Recent conversation files can also be reused. Template and campaign media headers use the same upload control; voice recordings upload directly through Twenty.

No bucket setup or file URLs are needed. Files remain in Twenty storage and follow the app's existing sending and consent rules. Upload/download permissions are included in the WhatsApp Agent and Admin roles.

## Requirements

- A Twenty **2.54.0 or newer** workspace (cloud or self-hosted) whose public URL is reachable over HTTPS — Meta must be able to call your webhook.
- A Meta Business account with an approved **WhatsApp Business phone number**.
- A Meta app with the WhatsApp product and a system-user access token.

## Installation

Install from **Settings → Apps** in your Twenty workspace, then connect Meta:

### 1. Create and configure a Meta app

- In [Meta for Developers](https://developers.facebook.com), create an app of type **Business** and add the **WhatsApp** product.
- From **App Dashboard → Settings → Basic**, copy the **App ID** and **App Secret**.

### 2. Create credentials

- In **Business Manager → System Users**, create a system user with access to your WhatsApp Business Account.
- Generate a long-lived token with exactly these scopes:
  - `whatsapp_business_management`
  - `whatsapp_business_messaging`
- Generate a random verify token (for example `openssl rand -hex 32`).

### 3. Add the secrets in Twenty

Open **Settings → Apps → WhatsApp → Settings → Variables** and set:

| Variable | Value |
| --- | --- |
| `META_APP_ID` | App ID from step 1 |
| `META_APP_SECRET` | App Secret from step 1 |
| `META_ACCESS_TOKEN` | System-user token from step 2 |
| `META_VERIFY_TOKEN` | Your random verify token |

### 4. Configure the webhook in Meta

In the Meta app's WhatsApp product, open **Webhooks** and set the callback to:

```
<your Twenty base URL>/s/whatsapp/webhook
```

Use the same verify token, and subscribe these fields: `messages`, `message_template_status_update`, `message_template_quality_update`, `message_template_components_update`, `account_update`, `phone_number_quality_update`, `business_capability_update`.

The app's **health panel** shows the exact callback URL and required fields for your workspace, and verifies each piece of the setup once a number is connected.

### 5. Connect your number

In the app settings, connect your WABA and phone number, run the health check, and sync templates. You're live.

### Troubleshooting

Seeing `unverified webhook`, `signature failed`, or no events?

- Re-copy the callback URL and verify token into Meta from the latest save.
- Confirm the endpoint is reachable over HTTPS and not behind an IP/VPC block.
- Confirm all webhook fields above are subscribed.
- Confirm the system-user token still has both WhatsApp scopes.

The health panel diagnoses each of these individually.

## Configuration

Beyond the Meta secrets, the app exposes ~30 application variables so operational behavior never requires a deploy — send throttles and pacing, campaign batch sizes and failure thresholds, opt-in/opt-out keywords and confirmation wording (English and Portuguese), retention windows, timeline verbosity, per-category pricing for cost estimates, and more. Each variable is documented in place under **Settings → Apps → WhatsApp**.

Per-number settings (throttle, default calling code, auto-assignment, contact auto-creation) live on the WhatsApp account record, so numbers can differ.

## Development

```bash
yarn install
yarn twenty app dev        # sync to a configured development workspace
```

See `SETUP.md` for the full local guide, `specs/` for design and architecture notes, and `CHANGELOG.md` for notable changes. `yarn test:unit` runs the local test suite; `yarn test` runs integration tests against a disposable workspace.

## Learn more

- [Twenty Apps documentation](https://docs.twenty.com/developers/extend/apps/getting-started/quick-start)
- [Pixel Infinito](https://pixel.ao)
- [Twenty Discord](https://discord.gg/cx5n4Jzs57)

## License

MIT © [Pixel Infinito](https://pixel.ao)

## WhatsApp through Twenty MCP and AI agents

The app exposes twelve WhatsApp tools, including the existing template tools, through Twenty’s own MCP and AI registry. Operators can work conversations and send every supported message type; admins can also manage templates, campaigns, consent, accounts and webhook recovery. Bulk/destructive operations require preview and explicit user approval.

A tested local Docker setup uses `http://localhost:2021` (MCP `/mcp`); see the [verification report](reports/mcp-ai-tools-2026-11-03.md) and the prerequisite guide below.

Install the [caller delegation v1 platform prerequisite](tools/twenty-caller-delegation/README.md) before applying the app. Stock Twenty 2.54 lacks the delegated identity required for restricted keys and autonomous agents; calls fail closed with `PLATFORM_UPGRADE_REQUIRED`. No new MCP server or Meta credentials in prompts are needed. Assign the appropriate WhatsApp role to each key/agent, refresh MCP discovery, and start with `app_whatsapp_get_capabilities`.

See [the complete contracts and rollout procedure](specs/17-twenty-mcp-agent-messaging.md). The app includes a reusable WhatsApp skill. Offline checks never send messages; live validation needs a designated test recipient and campaign.
