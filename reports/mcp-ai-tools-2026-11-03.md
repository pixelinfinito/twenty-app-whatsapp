# WhatsApp MCP / AI tools verification — 2026-11-03

Implemented and installed on the local Docker development server: **http://localhost:2021**, MCP **http://localhost:2021/mcp**. All twelve WhatsApp tools and the reusable `whatsapp` skill are present. No automatic responder was created.

## Installed artifacts

- Container: `twenty-whatsapp-mcp-dev`, managed by `tools/twenty-caller-delegation/compose.yaml`; server and worker running, health endpoint OK.
- Image: `twenty-whatsapp-mcp-dev:2.54.0-caller-v1`, ID `sha256:dbb00936c07b29be01f90e68f315168d487dfafdcb1684bbd5db91fa93c5a26b`.
- Source: `twenty/v2.54.0`, commit `c75ef7bfd0589219bd22e8f134df458af0af3445`. The companion patch covers server authorization, shared types and the SDK `ToolCaller` export.
- Patch SHA-256: `69461912eb5567551095f69ea2ebf5b6a0bfdfcab2510165995819e2ed7828ff` (also recorded in image labels).
- App content hash: `f7c50a8fed5b66e865218774a153da8f8e81b04e61c685c2ba2d313a2ce9316e`.
- App apply succeeded through build, preview, installation, upload, synchronization, pull base and typed client generation using remote `whatsapp-mcp-local`, without pruning.
- PostgreSQL/storage volumes: `twenty-whatsapp-mcp-dev-data` and `twenty-whatsapp-mcp-dev-storage`. The original `twenty-app-dev` and its volumes remain preserved and stopped. The original default CLI remote was not changed.

The app keeps npm SDK/CLI 2.54.0 and uses a structural manifest adapter for the prerequisite fields. No published SDK/server release containing the prerequisite is claimed. The reviewed local image and upstream source revision identify the supporting runtime.

## Completed checks

| Check | Result |
|---|---|
| App typecheck | Passed |
| App lint | Passed; no warnings/errors |
| App unit tests | Passed: 91 files, 2,038 tests |
| Offline platform service tests | Passed: 8 tests using the service extracted from the distributable patch |
| Native Twenty Jest | Passed: 3 suites, 28 tests; delegation, cross-application discovery and read-only delegated request scope |
| Native `twenty-shared` build | Passed using Nx; runtime and declarations rebuilt before native tests |
| Native server typecheck | Two unchanged upstream diagnostics; exact match with the unmodified release baseline under the same validation dependencies; no additional diagnostics from the patch |
| Docker module compilation/build | Passed; image recreated from the delivered build script and Compose file |
| App build/install | Passed; all 12 manifests retain explicit permission requirements and delegation v1 |
| Companion patch | `git apply --check` passed against clean files from the pinned release |
| New entity identifiers | UUID v4 |
| Whitespace | App and companion `git diff --check` passed |

The native typecheck diagnostics are `TS2322` (`string` versus `FieldReferenceFilterOperator`) at `filter-arg-processor.service.ts:398` and `graphql-query-filter-field.parser.ts:174`. These reproduce with the unchanged upstream server sources. Native checks used the matching production dependency image supplemented with development types/tools, a project-local `src/*` path and build exclusions for test helpers/embedded seed projects. A clean full-repository SDK/server production build remains a release gate; the local image rebuilds the changed server modules against the matching prebuilt image.

## Live MCP and agent validation

The reusable read-only `smoke.mjs` checked native MCP catalog, execution, capabilities, inbox/thread/template reads and skill discovery after the final image was recreated:

| Caller | Principal | WhatsApp tools | Result |
|---|---|---:|---|
| Restricted operator key | API key | 11 | Passed; webhook recovery hidden |
| Restricted admin key | API key | 12 | Passed |
| Key without WhatsApp grants | API key | 0 | Passed |
| Autonomous operator agent | Agent | 11 | Passed |
| Member-backed operator agent | Member, agent constraint retained | 11 | Passed |
| Workspace administrator member | Member | 12 | Passed |

Additional native checks passed:

- A custom role with **only** the admin permission flag discovers all 12 tools and receives operator/admin capabilities. Operator-or-admin requirements are enforced during discovery and execution.
- Removing the validation agent's WhatsApp role immediately removes access for autonomous and member-backed invocations; restoring the role restores access.
- Operator account disconnect returns `FORBIDDEN`.
- Authenticated direct GraphQL function execution without trusted delegation is refused (`Logic function requires authorized tool delegation`).
- Delegated agent credentials read core GraphQL and REST records, while GraphQL mutations, REST mutations and metadata requests are refused. Ordinary interpreter tokens remain MCP-only.
- Thread mutations work for restricted keys and both agent identities. Audit provenance carries the principal and initiating agent.
- A repeated thread action replays its stored result; changed action inputs with the same request ID return `IDEMPOTENCY_CONFLICT`.
- Two concurrent text sends produce one queued message; the competing attempt reports `OUTCOME_UNKNOWN`, and a later identical retry replays the same message ID.
- An expired service window returns `WINDOW_CLOSED`; a disabled account returns `ACCOUNT_NOT_CONNECTED`.
- Disconnect previews leave the target untouched; expired tokens, different principals, altered inputs and stale target revisions are rejected. A fresh approved synthetic execution succeeds; reuse is refused.
- Campaign create, content preview and preflight work through the restricted admin key. Delete preview preserves the draft; confirmed deletion removes it.

The local validation agent `whatsappMcpValidation` has the shipped operator role. No LLM provider is configured in this disposable image: native agent credentials, role resolution, tool registry/execution and caller-scoped reads were exercised directly, without an LLM generation call.

## Provider and production boundary

No real Meta message, campaign or account operation was attempted. The synthetic queued message was marked failed and its account disabled before the worker was restarted. Synthetic account/contact/template/thread records remain clearly named as MCP local fixtures; the campaign draft was deleted through the confirmed tool flow.

Offline coverage includes every message kind, schemas, new-number recipient resolution, caller/file workspace boundaries, hidden suppression records, field/object/row restrictions, campaign audience authorization, idempotency races/uncertain completion, confirmation expiry/binding/reuse and worker policy rechecks. These tests do not establish real Meta delivery.

Before enabling production, resolve the upstream native build/typecheck gate, publish/pin the reviewed supporting server/SDK artifacts, and validate uploads, provider acceptance, delivered/read status and a campaign using a designated Meta test account and recipient. The repository's destructive app integration installer was not run against the installed workspace. Existing unrelated working-tree changes were retained.
