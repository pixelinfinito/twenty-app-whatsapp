# 17 — Full WhatsApp access through Twenty MCP and AI tools

**Implementation:** application tools and companion platform patch installed and smoke-tested on the local Docker server at `http://localhost:2021`; see `reports/mcp-ai-tools-2026-11-03.md` for evidence and production gates.

## 1. Contract

Twenty's own MCP and AI tool registry is the orchestration surface. App-owned tool wrappers call shared server operations. Only the existing outbound worker calls Meta's messaging API. Workflows and internal workers are not exposed as AI tools. This supersedes the earlier template-only non-goals in this specification and D-54.

The two existing tools retain their names and input contracts: `whatsapp-list-sendable-templates` and `whatsapp-send-template`. The template send still requires one exact Person/template, approved publication, parameters and a UUID-v4 request id. Success still means queued rather than delivered.

New tools are `whatsapp-get-capabilities`, `whatsapp-list-threads`, `whatsapp-get-thread`, `whatsapp-send-message`, `whatsapp-thread-action`, `whatsapp-templates`, `whatsapp-campaigns`, `whatsapp-consent`, `whatsapp-accounts` and `whatsapp-webhooks`. MCP prefixes/sanitizes these as `app_whatsapp_*`.

The closed schemas and action/role/confirmation matrices live in `src/server/tool-contracts.ts` and are runtime-validated by `tool-schema.ts`. Management action enums mirror the app's existing operations; campaign list/get and template sync are explicit adapters to existing reads/synchronization. No arbitrary handler dispatch is accepted.

## 2. Recipient, message and read interfaces

- `whatsapp-send-message` accepts exactly one of `threadId`, `personId`, or `phone` plus `accountId`. A phone must be exact E.164, including `+`. Multiple contacts/accounts require disambiguation; there is no first-account fallback.
- Supported message kinds: text, template, media, interactive, reaction, location and contacts. Media supports image, video, audio, document and sticker; audio supports `voice:true`. Applicable message kinds carry `contextWamid` for quoted replies.
- Upload through Twenty's native file tools and provide the newly completed workspace `fileId` (optionally its path). To reuse an already attached file, provide an accessible `fileUrl`/`filePath` without `fileId`; the app retains an independent copy. Cross-workspace signed file tokens are refused. Download uses the caller credential; retained copies and app-owned writes use application credentials after validation.
- Inbox selectors include Person, account, assignee, status and the existing inbox filters. Filters apply before pagination. New list tools default to 20 and cap at 50; continue with the returned cursor.
- Thread reads return the existing feed projections, attachment references, delivery states, capability matrix and policy verdicts. They do not mark messages read automatically.
- `whatsapp-get-capabilities` returns effective operator/admin access, available accounts, supported message/media kinds, action availability and confirmation requirements.

## 3. Platform prerequisite and authorization

The stock SDK 2.54 context identifies workspace members, but lacks delegated API-key/autonomous-agent identity. The companion implementation is `tools/twenty-caller-delegation/twenty-caller-delegation-v1.patch`; its target revision and installation/check commands are documented beside it.

The platform checks manifest permission requirements during discovery and execution, and rejects protected direct function invocation without trusted delegation. The handler receives engine-owned `toolCaller` and a separately injected five-minute caller token. Operator requirements accept either operator or admin. Explicitly protected delegated tools support cross-application agent discovery. Application-backed delegated reads retain the originating application, member and agent role intersection, and are restricted to core read APIs; ordinary interpreter credentials remain MCP-only. Neither identity, role flags nor credentials are accepted as tool arguments. Function context and caller workspace must match. Missing delegation is `PLATFORM_UPGRADE_REQUIRED`, with no WhatsApp operation executed.

Two app-owned tool flags are granted through the shipped roles:

- **Operator:** conversation reads, all one-to-one message kinds, thread actions, template reads, campaign reads/previews, individual consent evidence and account list.
- **Admin:** operator capabilities plus template management, campaign mutations, consent import/erasure, account administration/settings and webhook inspection/recovery.

Both roles are assignable to users, API keys and AI agents. Person, workspace-member, message-list and list-membership reads are included. WhatsApp records are read-only for both roles through generic CRM APIs; validated operations own writes. The hidden request ledger is not granted to either role.

Repository reads during tool operations use the delegated caller client, preserving object, field and row restrictions. Privileged identity checks may see hidden contact/suppression records, but the wrapper refuses inaccessible identities rather than treating them as unknown. Files use the caller token. Application credentials write only through existing checked operations.

Campaign builds capture caller-visible Person ids before enqueueing the privileged snapshot worker and carry that authorization set through every continuation. Launch/resume verify that all accepted recipient rows and their People are visible to the caller. Normal send-time policy rechecks still apply.

HTTP routes retain their existing member authentication and explicit machine-automation opt-in. `WA_ALLOW_API_KEY_ADMIN` never grants AI-tool access. Member-backed agent runs retain member attribution; autonomous/key actions carry their trusted principal in structured audit logs. Campaign and workflow source kinds remain intact; one-to-one AI sends use `AI_AGENT`.

## 4. Request ledger and results

Every mutation requires a UUID-v4 `requestId`. A hidden `whatsappToolRequest` object has a unique `requestKey`, fingerprint, state and JSON result. The key binds workspace/request id; the fingerprint binds principal, operation and exact inputs.

Creating the unique row atomically claims execution. Identical completed requests replay the original result. Changed inputs, principals or operations return `IDEMPOTENCY_CONFLICT`. Concurrent/incomplete attempts return `OUTCOME_UNKNOWN`. A lost claim/completion response never causes an automatic second provider action. RUNNING rows deliberately do not expire into permission to repeat a request; an operator must reconcile the target state.

New results distinguish `ready`, `accepted`, `denied`, and `confirmation_required`, with stable reason codes, identifiers, warnings and pagination information where relevant. Message-send results retain only message/thread identifiers and delivery state in the request ledger, not message bodies. `accepted` plus `delivery:queued` does not imply provider acceptance, delivery or reading.

## 5. Preview and confirmation

Confirmation is required for campaign launch/resume/cancel/delete, consent imports/erasure, account disconnect, and webhook replay/resynchronization. These actions default to `phase:preview`. Ordinary mutations execute directly and reject confirmation-only fields.

Preview validates the caller and targets, reads current impact/preflight information, and performs no target action. It returns a token expiring in ten minutes. Tokens bind workspace, principal, operation/inputs and target revisions; erasure/recovery also bind impact and selected events. Execution revalidates authorization, recomputes the revision, consumes the token through an atomic unique claim, and runs the existing operation. Expired, changed, stale and already-consumed tokens are refused.

A preview and its approved execution are separate intents with separate request ids. Retries of either step reuse that step's original request id. The reusable `whatsapp` skill instructs both MCP and built-in agents to show the preview and obtain explicit user approval before execution. The token enforces binding and single use; user approval is an agent interaction requirement, not a claim that arbitrary MCP clients supply cryptographic proof of human approval.

## 6. Verification and rollout

Offline checks: `yarn typecheck`, `yarn lint`, `yarn test:unit`, `yarn test:platform`, and `yarn twenty app build --no-input`. The platform patch must pass `git apply --check` and native Twenty tests/typecheck/build against the target checkout. The platform fixture tests exercise the actual new delegation service but do not stand in for a server deployment.

Deploy/pin the reviewed patched Twenty build first. Then apply the WhatsApp app, including its internal ledger, flags, role changes and skill. Reconnect MCP to refresh discovery. Verify operator/admin discovery, forbidden actions, scoped reads/files, revoked keys/roles, member-backed/autonomous agents, replay/conflict handling, and stale confirmations.

Live messaging validation requires a designated test account/recipient and campaign. Verify all message kinds and eventual statuses; no offline check contacts a customer. The local Docker rollout and native registry/credential checks are complete. Production rollout still requires resolving the unchanged upstream typecheck gate and validating a designated Meta test recipient/campaign. A new MCP server, Meta-secret exposure and an automatic responder are outside this change.
