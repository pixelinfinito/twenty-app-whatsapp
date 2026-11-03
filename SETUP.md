# Setup

Follow these steps to get your app running locally.

## Prerequisites

- Node.js (version specified in `.nvmrc`)
- Yarn 4
- Docker (to run the local Twenty server)

## Steps

1. Install dependencies:

   ```bash
   yarn install
   ```

2. Start a disposable Twenty **2.54.0** workspace:

   ```bash
   docker run -d --name twenty-whatsapp-dev -p 2021:2021 \
     -e NODE_PORT=2021 -e SERVER_URL=http://localhost:2021 \
     -e MARKETPLACE_CATALOG_SYNC_CRON_ENABLED=false \
     twentycrm/twenty-app-dev:v2.54.0
   ```

3. Sign in at [localhost:2021](http://localhost:2021) using the image's demo account. Configure the CLI with `yarn twenty auth login --url http://localhost:2021`.

4. Sync the app and watch:

   ```bash
   yarn twenty app apply --create
   yarn twenty app dev
   ```

The server, SDKs, and standalone `twenty` CLI are pinned to 2.54.0. Uploads use the native file chooser and Twenty's host upload API. Template and campaign media headers use the same control. S3 configuration and manual file URLs are no longer supported.

## Verifying your setup

- `yarn lint` - Lint the project with oxlint
- `yarn typecheck` - Type-check the project
- `yarn test:unit` - Run unit tests
- `yarn twenty app build` - Build the app
- `yarn test` - Apply, test, and uninstall the app in a disposable workspace; set `TWENTY_API_URL` and `TWENTY_API_KEY` for that workspace first. Never use production credentials.

## Troubleshooting

See the [troubleshooting guide](https://docs.twenty.com/developers/extend/apps/getting-started/troubleshooting) or ask on [Discord](https://discord.gg/cx5n4Jzs57).

## WhatsApp through Twenty MCP and AI agents

The app exposes twelve WhatsApp tools, including the existing template tools, through Twenty’s own MCP and AI registry. Operators can work conversations and send every supported message type; admins can also manage templates, campaigns, consent, accounts and webhook recovery. Bulk/destructive operations require preview and explicit user approval.

A tested local Docker setup uses `http://localhost:2021` (MCP `/mcp`); see the [verification report](reports/mcp-ai-tools-2026-11-03.md) and the prerequisite guide below.

Install the [caller delegation v1 platform prerequisite](tools/twenty-caller-delegation/README.md) before applying the app. Stock Twenty 2.54 lacks the delegated identity required for restricted keys and autonomous agents; calls fail closed with `PLATFORM_UPGRADE_REQUIRED`. No new MCP server or Meta credentials in prompts are needed. Assign the appropriate WhatsApp role to each key/agent, refresh MCP discovery, and start with `app_whatsapp_get_capabilities`.

See [the complete contracts and rollout procedure](specs/17-twenty-mcp-agent-messaging.md). The app includes a reusable WhatsApp skill. Offline checks never send messages; live validation needs a designated test recipient and campaign.
