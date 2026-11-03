# Twenty caller delegation v1

This prerequisite is implemented and running on the local Docker development server at **http://localhost:2021** (MCP: `/mcp`). The WhatsApp app and reusable `whatsapp` skill are installed. The previous `twenty-app-dev` container and its volumes are preserved, stopped as originally found.

The patch targets the released source ref `twenty/v2.54.0`, commit `c75ef7bfd0589219bd22e8f134df458af0af3445`, and base image `twentycrm/twenty-app-dev:v2.54.0`. The local supporting image is `twenty-whatsapp-mcp-dev:2.54.0-caller-v1`; its labels record the source commit and patch SHA-256. See [verification](../../reports/mcp-ai-tools-2026-11-03.md) for checks and limitations. No published npm/server release containing this prerequisite is assumed.

## Contract

- `ToolTriggerSettings.requiredPermissionFlagUniversalIdentifiers` requires every listed grant. `requiredAnyPermissionFlagUniversalIdentifiers` additionally requires at least one listed grant. Operator tools accept operator **or** admin; admin tools require admin.
- `callerDelegationVersion: 1` requests engine-owned `LogicFunctionExecutionContext.toolCaller` and a separate five-minute `TWENTY_TOOL_CALLER_ACCESS_TOKEN`. Identity, agent attribution, workspace, effective grants and invocation surface come from authentication/execution, never arguments.
- API keys retain their key identity, expiry/revocation and roles. Member executions retain their member/application restrictions. Autonomous and member-backed agents retain the originating application and agent role intersection. Agent attribution is included even when the principal is a member.
- Application-backed agents can discover another app's tools only when those tools opt into delegation v1 **and** explicit permission requirements. Discovery, catalog, learning and execution use the same trusted context; execution checks permissions again. Protected direct function execution without delegation fails.
- Delegated application credentials permit caller-scoped core GraphQL queries and REST reads only. Metadata, mutations, routes and MCP calls reject these credentials. Ordinary interpreter agent tokens remain MCP-only. Native object, field, row and agent-role checks still apply to every read.
- Application credentials perform app-owned mutations through the shared validated operations. A reserved environment key prevents application variables from replacing the caller credential.
- The shared SDK types and `twenty-sdk/logic-function` export include `ToolCaller`. The app's structural manifest adapter remains compatible with npm SDK 2.54.0; the server prerequisite is mandatory.

## Build and run locally

Apply to a clean checkout without resetting other work:

```sh
git clone --branch twenty/v2.54.0 --depth 1 https://github.com/twentyhq/twenty /path/to/twenty
node tools/twenty-caller-delegation/apply.mjs /path/to/twenty --check
node tools/twenty-caller-delegation/apply.mjs /path/to/twenty
```

Use a separate compiler prefix so the app's dependency tree is unchanged:

```sh
npm install --prefix /path/to/caller-compiler --no-audit --no-fund @swc/core@1.16.0 @lingui/swc-plugin@6.7.1
node tools/twenty-caller-delegation/build-docker.mjs /path/to/twenty /path/to/caller-compiler
docker compose -f tools/twenty-caller-delegation/compose.yaml up -d
```

The development image overlays the changed server modules onto the matching prebuilt 2.54.0 image; shared/SDK additions are types. It uses persistent PostgreSQL/storage volumes and port 2021. The builder rejects a different source commit. Rebuild `twenty-shared` before native tests. For a production image or another Twenty revision, use the complete upstream build pipeline, resolve the baseline typecheck issues documented in the report, and pin the reviewed server/SDK artifacts before production rollout.

Install the app after the server is healthy:

```sh
yarn twenty app apply --create --no-prune --remote whatsapp-mcp-local --no-input --json
```

The saved `whatsapp-mcp-local` remote targets port 2021. The workspace's original default remote is unchanged. For a new machine, configure that remote using Twenty's normal authentication flow first. Assign **WhatsApp Agent** to operator keys/agents or **WhatsApp Admin** to administrators, refresh MCP, and begin with `app_whatsapp_get_capabilities`. The validation agent is named `whatsappMcpValidation`; it has the operator role and starts no automatic responder. The local image does not configure an LLM provider.

## Verification

```sh
yarn test:platform
yarn typecheck
yarn lint
yarn test:unit
yarn twenty app build --no-input
node tools/twenty-caller-delegation/smoke.mjs /path/to/local-smoke-config.json
```

The smoke script is read-only. The JSON configuration contains `url`, optional `threadId`, and `identities`, for example:

```json
{
  "url": "http://localhost:2021",
  "identities": [
    { "label": "operator", "tokenFile": "/private/operator-token", "kind": "apiKey", "operator": true, "admin": false },
    { "label": "admin", "tokenFile": "/private/admin-token", "kind": "apiKey", "operator": true, "admin": true },
    { "label": "none", "tokenFile": "/private/no-access-token", "kind": "apiKey", "operator": false, "admin": false }
  ]
}
```

Keep credentials outside the repository. Agent/member-backed credentials can be included with `kind: "agent"`/`"member"`. Native Jest tests are included in the companion patch; offline `test:platform` executes the actual delegation service with framework dependencies stubbed.

Local smoke tests use synthetic records. Verify provider acceptance, delivered/read status, every media kind and a campaign against a designated Meta test account/recipient before production use. No real outbound delivery was attempted. Without this patched runtime, wrappers fail closed with `PLATFORM_UPGRADE_REQUIRED`; `WA_ALLOW_API_KEY_ADMIN` never authorizes AI tools.
