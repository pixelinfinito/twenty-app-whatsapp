# WhatsApp for Twenty CRM

Two-way WhatsApp messaging inside [Twenty](https://twenty.com): a shared team inbox, conversations on every Person record, approved templates, consent tracking and marketing campaigns — powered by the official **Meta WhatsApp Cloud API**.

Developed by **Marcos Lisboa** at [Pixel Infinito](https://pixel.ao) · published as [`@pixelinfinito/twenty-app-whatsapp`](https://www.npmjs.com/package/@pixelinfinito/twenty-app-whatsapp).

![WhatsApp for Twenty](public/cover-whatsapp-v1.png)

## Features

- **Shared team inbox and Person conversations:** filter by assignment, unread, closed and campaign replies; assign, close/reopen, block/unblock, mark read, snooze and link contacts. Keyboard navigation, responsive widgets and action feedback keep the conversation usable in narrow panels.
- **Full messaging:** send and receive text, images, video, audio, voice notes, documents, stickers, locations, contact cards, interactive messages, reactions and quoted replies. Track queued, accepted, sent, delivered, read and failed states.
- **Native Twenty attachments:** choose a device file, preview it, add a caption and send. Reuse recent conversation files, upload voice recordings, and attach template/campaign media headers. Files remain in Twenty storage with retained associations; no separate bucket or manual file URL is required.
- **Consent and send policy:** enforce opt-in, opt-out, blocking, account health, template eligibility, pacing and the 24-hour service window on the server, with another eligibility check before delivery. Record consent wording and evidence, import consent, inspect history and erase contact data through reviewed admin actions.
- **Templates:** synchronize Meta approvals, submit templates, publish/unpublish them for CRM use, fill header/body/button variables from CRM fields and preview the result before sending.
- **Campaigns:** select a saved view, message list or explicit contacts; save and resume drafts, bind recipient variables, build an audience snapshot, inspect exclusions and cost estimates, run preflight/test sends, launch or schedule, pause/resume, cancel, archive and delete drafts. Daily tier reservations and failure circuit breakers protect ordinary conversations.
- **Accounts and recovery:** connect multiple numbers, inspect health and delivery diagnostics, edit nonsecret settings, provision notification workflows, inspect/replay webhook events and resynchronize conversations. Meta credentials remain in secret storage.
- **Workflow automation:** use the WhatsApp template action inside Twenty workflows and branch on structured policy denials. Configurable notifications, retention and audit history support day-to-day operations.
- **MCP and AI agents:** twelve WhatsApp tools cover conversation reads, every supported send type and app administration. Operator/admin grants, caller-scoped reads, UUID request IDs, retry protection, previews and expiring confirmations apply to external MCP clients and built-in agents.
- **English, Portuguese and Spanish:** follow the user's locale, with a configurable conversation time zone, accessible controls, preserved drafts after failures and clear upload/send feedback.

![Shared inbox](public/gallery-inbox-v1.png)

![Template management](public/gallery-templates-v1.png)

![Campaigns](public/gallery-campaigns-v1.png)

## WhatsApp through Twenty MCP and AI agents

**AI tools require the [caller delegation v1 platform prerequisite](tools/twenty-caller-delegation/README.md).** Stock Twenty 2.54 supports the inbox, uploads and workflows; it does not supply the trusted identity needed for these AI tools. Calls fail closed with `PLATFORM_UPGRADE_REQUIRED` until the supporting runtime is installed.

The tools use Twenty's existing MCP endpoint and AI registry. Assign **WhatsApp Agent** for operator access or **WhatsApp Admin** for administrative access, refresh discovery, and start with `app_whatsapp_get_capabilities`. Both roles can be assigned to members, API keys and AI agents. A reusable `whatsapp` skill explains discovery, recipient resolution, media uploads, consent, retries, confirmation and delivery tracking.

| MCP tool | Features |
| --- | --- |
| `app_whatsapp_get_capabilities` | Discover permissions, available accounts, supported operations and confirmation requirements. |
| `app_whatsapp_list_threads` | Filter and paginate the inbox by contact, account, status and assignment. |
| `app_whatsapp_get_thread` | Read messages, attachments, delivery status and the current send-policy verdict. |
| `app_whatsapp_send_message` | Queue any supported message type, including media, voice notes, reactions and quoted replies. |
| `app_whatsapp_thread_action` | Assign, close/reopen, block/unblock, link/relink, mark read, snooze and create a Person from reviewed details. |
| `app_whatsapp_list_sendable_templates` | Find approved, published templates eligible for a specific Person and account. |
| `app_whatsapp_send_template` | Queue an exact template using the existing compatible inputs. |
| `app_whatsapp_templates` | List, submit, publish/unpublish and synchronize templates. |
| `app_whatsapp_campaigns` | Work with audiences, drafts, builds, previews, preflight, test sends, scheduling and the campaign lifecycle. |
| `app_whatsapp_consent` | Record consent, read evidence history, import and preview/execute erasure. |
| `app_whatsapp_accounts` | List, connect, test, configure and disconnect accounts; inspect diagnostics and provision notifications. |
| `app_whatsapp_webhooks` | Inspect events, replay selected/failed events and resynchronize a thread. |

New sends select exactly one thread, Person or exact phone number with an account. Mutations require a UUID-v4 request ID; identical retries replay their result. Queued messages are tracked separately from provider acceptance and delivery. Campaign launch/resume/cancel/delete, consent imports/erasure, account disconnect and webhook recovery require a preview and explicit user approval before execution with a confirmation token.

See the [complete contracts](specs/17-twenty-mcp-agent-messaging.md), [local Docker setup](tools/twenty-caller-delegation/README.md) and [verification report](reports/mcp-ai-tools-2026-11-03.md). The tools expose user operations; installing the skill does not start an automatic responder.

## Requirements

- A Twenty **2.54.0 or newer (2.x)** workspace (cloud or self-hosted) whose public URL is reachable over HTTPS — Meta must be able to call your webhook.
- A Meta Business account with an approved **WhatsApp Business phone number**.
- A Meta app with the WhatsApp product and a system-user access token.

## Installation

Install from **Settings → Apps** in your Twenty workspace, then work through the steps below **in order**. The order matters: you cannot test the callback before the route exists, and the route does not exist before the app is claimed.

### The three silent failures, first

Three setup steps produce a webhook that is configured **perfectly in Meta**, verifies successfully, and still delivers nothing. Each has its own status code, none is guessable, and Meta reports only an undetailed delivery failure. They are steps 1–3 below.

| If `POST <base>/webhooks/server/bb76f114-…` answers | Cause | Fix |
| --- | --- | --- |
| `404 LOGIC_FUNCTION_NOT_FOUND` | The app registration is unclaimed, so its server route has no workspace to run in | Step 1 |
| `403 LOGIC_FUNCTION_DISABLED` | The server refuses to run any logic function | Step 2 |
| `500 MissingConfigError` | `META_APP_SECRET` is unset; the resolver fails closed rather than verify against an empty key | Step 3 |
| `401 {"error":"invalid signature"}` | **Correct.** The route is live and refusing an unsigned request | — |

The health panel's **Webhook route (POST)** row runs exactly this probe and names whichever of these it finds, so you can check it at any point rather than guessing.

### 1. Claim the app registration

Open **Settings → Applications → WhatsApp → Danger zone** and click **Claim ownership**.

The webhook's `POST` half is a *server route*, and a server route runs in the workspace that owns the application registration. While the registration is unclaimed there is no such workspace, so the platform has nowhere to dispatch it and the route does not exist. Everything else looks fine when this is wrong — the app is installed, all its logic functions are registered, the settings page renders.

> If you don't see the button, the claim control only renders on the **admin panel** route: `<base>/settings/admin-panel/applications/registrations/<registrationId>`. It requires a signed-in user with full admin-panel access — an API key cannot do it.

### 2. Enable logic functions on the server

Set this in the **Twenty server's** environment (not an app variable) and restart:

```
LOGIC_FUNCTION_TYPE=LOCAL
```

`LAMBDA` is the alternative if you run functions on AWS. With neither, Twenty loads a driver that refuses every logic function — no routes, no scheduled jobs, nothing in this app works.

### 3. Create and configure a Meta app

- In [Meta for Developers](https://developers.facebook.com), create an app of type **Business** and add the **WhatsApp** product.
- From **App Dashboard → Settings → Basic**, copy the **App ID** and **App Secret**.

### 4. Create credentials

- In **Business Manager → System Users**, create a system user with access to your WhatsApp Business Account.
- Generate a long-lived token with exactly these scopes:
  - `whatsapp_business_management`
  - `whatsapp_business_messaging`
- Generate a random verify token (for example `openssl rand -hex 32`).

### 5. Add the secrets in Twenty

Open **Settings → Apps → WhatsApp → Settings → Variables** and set all four:

| Variable | Value |
| --- | --- |
| `META_APP_ID` | App ID from step 3 |
| `META_APP_SECRET` | App Secret from step 3 |
| `META_ACCESS_TOKEN` | System-user token from step 4 |
| `META_VERIFY_TOKEN` | Your random verify token |

All four are required. The resolver fails closed on a missing `META_APP_SECRET` rather than verifying every signature against an empty key — which is correct, and shows up only as a `500`.

### 6. Configure the webhook in Meta

**From app 0.1.3 on Twenty 2.35.0 or newer, no reverse-proxy alias or method-splitting rewrite is required for the webhook.** Use the direct URL below. Your Twenty instance must still be publicly reachable over HTTPS.

Meta takes **one** callback URL and uses it for two things: a `GET` carrying `hub.challenge` to verify the endpoint, and `POST` to deliver events. This app answers **both** on one URL — the webhook resolver's server route:

```
<your Twenty base URL>/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd
```

Open **Webhooks** in the Meta app's WhatsApp product and paste that URL as the callback. The app's settings health panel prints it ready to copy, alongside the verify token fields.

You can sanity-check the endpoint yourself with
`curl "<base>/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd?hub.mode=subscribe&hub.challenge=probe&hub.verify_token=<your token>"` —
it must return `probe`. A wrong token returns `Forbidden`, a Twenty without server-route GET support returns HTML.

**Upgrading from the proxy setup:** replace the old `/whatsapp/webhook` callback in Meta with the direct `/webhooks/server/…` URL above, then verify it and confirm an event reaches Diagnostics. After that, the old webhook-specific proxy rewrite rules can be removed. Keep your normal HTTPS routing to Twenty.

For app 0.1.2 on older Twenty servers, see the [legacy proxy setup instructions](https://github.com/pixelinfinito/twenty-app-whatsapp/blob/v0.1.2/README.md#6-configure-the-webhook-in-meta).

### 7. Subscribe the webhook fields

Subscribe all seven: `messages`, `message_template_status_update`, `message_template_quality_update`, `message_template_components_update`, `account_update`, `phone_number_quality_update`, `business_capability_update`.

> Meta's **"Send to my server"** button reports success without looking at the status code — a green test there is not proof of delivery. Confirm delivery by watching for new rows in `whatsappWebhookEvent` (or the health panel's webhook row), not by that button.

The app's **health panel** shows the callback URLs and the required fields for your workspace, and verifies each piece of the setup once a number is connected.

Without `message_template_status_update`, template approvals never arrive.

### 8. Connect your number, then test

In the app settings, connect your WABA and phone number, run the health check, and sync templates.

**Connect the number before testing the webhook.** Meta's **"Send to my server"** sample carries a `phone_number_id` nobody has claimed. The resolver answers it `200` and discards it — deliberately, since a non-2xx would earn a week of Meta retries for a number you do not host — so it leaves **no row at all** in Diagnostics. Run against an unconnected number, a perfectly working webhook and a broken one look identical.

Once your number is connected, a test delivery appears under **Diagnostics**, and the health panel verifies each remaining piece.

### Troubleshooting

Seeing `unverified webhook`, `signature failed`, or no events?

- **Nothing in the logs at all?** If a real delivery leaves no trace — no `signature_rejected`, no `unclaimed`, no row — then it never reached your server, and the cause is in front of it. On Cloudflare, check **Security → Events** for `AI Labyrinth Served` or a bot challenge on `/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd` (the callback in step 6). Silence in your own logs is evidence about the edge, not about the app.
- **Start with the Webhook route (POST) row in the health panel.** It probes the route directly and names the cause — see the table at the top of Installation for what each status means. This is the single most likely explanation of "verification passed but no events ever arrive".
- **Is your number connected?** An unclaimed number's delivery is accepted and discarded with no row (step 8). Test with a connected number or you cannot tell success from failure.
- Paste the exact server-route URL from step 6. A callback URL that verifies but delivers nothing is the classic symptom of a hand-typed URL — Meta's "Send to my server" test hits a 404 and still shows you a green tick.
- Re-copy the callback URL and verify token into Meta from the latest save.
- Confirm the endpoint is reachable over HTTPS and not behind an IP/VPC block.
- Confirm all webhook fields above are subscribed.
- Confirm the system-user token still has both WhatsApp scopes.

The health panel diagnoses each of these individually.

## Configuration

Beyond the Meta secrets, the app exposes ~30 application variables so operational behavior never requires a deploy — send throttles and pacing, campaign batch sizes and failure thresholds, opt-in/opt-out keywords and confirmation wording (English and Portuguese), the rendered time zone (`WA_TIME_ZONE`), retention windows, timeline verbosity, per-category pricing for cost estimates, and more. Each variable is documented in place under **Settings → Apps → WhatsApp**.

Per-number settings (throttle, default calling code, auto-assignment, contact auto-creation) live on the WhatsApp account record, so numbers can differ.

## Development

```bash
yarn install
yarn twenty app dev        # sync to a configured development workspace
```

See `SETUP.md` for the full local guide, `specs/` for design and architecture notes, and `CHANGELOG.md` for notable changes. `yarn test:unit` runs the local test suite and `yarn test:platform` checks the companion delegation service; `yarn test` runs integration tests against a disposable workspace.

### CI and releases

- [CI](.github/workflows/ci.yml) checks pull requests and pushes to `main`: it installs the app in a disposable Twenty instance, generates the typed client, and runs lint, typecheck, unit tests and integration tests.
- [Compatibility checks](.github/workflows/compat.yml) run weekly against the latest Twenty release and can also be started manually for a chosen version.
- [Publish](.github/workflows/publish.yml) releases the app to npm when a `vX.Y.Z` tag is pushed, or when started manually. Release tags must match `package.json`. Follow the [release checklist](specs/16-release-checklist.md) and push the source commit before tagging it.

Merging to `main` does not publish to npm or deploy to a live Twenty workspace. Workspace administrators install or update the released package through **Settings → Apps**.

## Learn more

- [Twenty Apps documentation](https://docs.twenty.com/developers/extend/apps/getting-started/quick-start)
- [Pixel Infinito](https://pixel.ao)
- [Twenty Discord](https://discord.gg/cx5n4Jzs57)

## License

MIT © [Pixel Infinito](https://pixel.ao)
