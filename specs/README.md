# twenty-whatsapp — Implementation Specifications

Implementation-level specs derived from **TRD v1.1 (2026-08-15)**, grounded in the SDK
actually installed in this repo (`twenty-sdk@2.54.0`, `twenty-client-sdk@2.54.0`) and in the
first-party Twenty apps that use the same surfaces (`packages/twenty-apps/public/slack`,
`.../examples/postcard`).

The TRD says *what* and *why*. These specs say *what file, what signature, what algorithm,
what test*. Where the TRD's assumptions did not survive contact with the SDK, the deviation is
recorded in [`00-architecture-decisions.md`](00-architecture-decisions.md) — read that first.

## Reading order

| # | Document | Covers |
|---|---|---|
| 00 | [Architecture decisions & TRD deltas](00-architecture-decisions.md) | D-1…D-14: the binding technical decisions, and every place the TRD must be amended |
| 01 | [Project layout & conventions](01-project-layout.md) | Directory structure, naming, UUID strategy, config, build/CI |
| 02 | [Data model](02-data-model.md) | All 8 objects, every field, relations, indexes, Person extensions |
| 03 | [Webhook ingestion](03-webhook-ingestion.md) | Resolver, dispatch, raw log, inbound/status/template/account processors, media worker |
| 04 | [Outbound pipeline](04-outbound-pipeline.md) | Policy gate, pacing, send, retry, media upload, status reconciliation |
| 05 | [Identity, threads & the service window](05-identity-threads-window.md) | Phone normalisation, matching, thread lifecycle, CSW policy module |
| 06 | [Templates & consent](06-templates-and-consent.md) | Sync, publishing gate, variable binding, opt-in/opt-out |
| 07 | [Campaigns](07-campaigns.md) | Builder, snapshot, exclusions, pre-flight, runner, tier ledger, guardrails |
| 08 | [Front components](08-front-components.md) | All 5 UI surfaces, sandbox constraints, data access, polling budget |
| 09 | [Workflows, timeline & notifications](09-workflows-timeline-notifications.md) | Workflow action, DB-event triggers, timeline activities, notification gap |
| 10 | [Security, roles & permissions](10-security-roles.md) | Secrets, HMAC, roles, consent hard-block, retention, erasure |
| 11 | [Observability & operations](11-observability-operations.md) | Logging, metrics, health, runbook, replay, reverse-proxy config |
| 12 | [Test plan](12-testing.md) | Test matrix mapped to every MUST/SHOULD requirement |
| 13 | [Delivery plan](13-delivery-plan.md) | Workstreams, task breakdown, sequencing, week-1 probes, release gate |
| 14 | [Open questions](14-open-questions.md) | Q-1…Q-16 with owners and deadlines |
| 15 | [Implementation task plan](15-implementation-tasks.md) | **Live build status** — what is done, what remains, critical path, remaining probes |
| 16 | [Release checklist](16-release-checklist.md) | The signed, human-run part: install rehearsal, the scripted E2E loop, the operational procedures, the load run |
| 17 | [Twenty MCP agent messaging](17-twenty-mcp-agent-messaging.md) | Full WhatsApp AI/MCP capabilities, caller delegation, scoped access, idempotency, confirmations and rollout |
| A | [Meta Cloud API surface](appendix-a-meta-api.md) | Exact requests, payloads and webhook shapes used |
| B | [Error catalog](appendix-b-error-catalog.md) | Meta error codes → system behaviour → user-facing copy |
| C | [UUID registry](appendix-c-uuid-registry.md) | Every hand-assigned universal identifier |

## Requirement traceability

Every spec section cites the TRD requirement IDs it implements (`FR-IN-2`, `AR-11`, …).
[`12-testing.md`](12-testing.md) closes the loop: each MUST/SHOULD requirement maps to at least
one named test. A requirement with no test in that table is not release-ready.

## Status conventions used in these documents

- **SPECIFIED** — decided, implementable as written.
- **PROBE** — depends on platform behaviour that must be verified empirically in week 1
  (see [13-delivery-plan.md § Week-1 probes](13-delivery-plan.md#week-1-de-risking-probes)).
  Each PROBE carries a specified fallback so the probe cannot block the workstream.
- **OPEN** — needs a decision from a named owner; tracked in [14-open-questions.md](14-open-questions.md).

## Verified platform facts these specs rely on

These were checked against the installed SDK and the docs, not assumed:

| Fact | Source |
|---|---|
| Server-route webhooks are exposed at `POST /webhooks/server/{resolverUniversalIdentifier}` — the path is **not** author-chosen | `docs/.../logic-functions.md`; `ServerRouteTriggerSettings` has only `forwardedRequestHeaders` |
| A resolver returns `{workspaceId, targetLogicFunctionUniversalIdentifier, payload}` **or** a `Response`; the platform then answers `202 {queued:true}` and runs the target asynchronously | `twenty-sdk/logic-function` `ServerRouteResolverResult`; `slack-events-resolver.ts` |
| `rawBody` is available to the resolver; signature headers must be listed in `forwardedRequestHeaders` | `LogicFunctionEvent.rawBody`; `slack-events-resolver.ts` |
| Node `crypto` (`createHmac`, `timingSafeEqual`) works inside logic functions | `slack/src/logic-functions/utils/verify-slack-request-signature.ts` |
| Cross-workspace routing state lives in `kv` with `scope: 'SERVER'` | `slack/.../find-claimed-workspace-id.ts` |
| Secrets reach logic functions as `process.env.<NAME>`, declared via `serverVariables` in the app config; secrets are never sent to front components | `docs/.../config/application.md`; `slack/src/application.config.ts` |
| Background work is queued with `enqueueJob({logicFunctionUniversalIdentifier, payload, retryLimit, delayMs})` | `twenty-sdk/logic-function` |
| Files are stored via `MetadataApiClient.uploadFile({ fileBuffer, filename, fieldMetadataUniversalIdentifier })` → `{id, path, size, url}` | `twenty-client-sdk/metadata` |
| Field universal identifiers can be **derived deterministically** with `getFieldUniversalIdentifier({applicationUniversalIdentifier, objectUniversalIdentifier, name})` (UUID v5) | `twenty-sdk/define`, verified by execution |
| A tab can be added to the stock Person record page via `definePageLayoutTab({pageLayoutUniversalIdentifier: STANDARD_PAGE_LAYOUT.personRecordPage.universalIdentifier, …})` | `docs/.../page-layouts.md`; constant verified present |
| Front components run in a Web Worker sandbox: no `IntersectionObserver`/`ResizeObserver`, no portals, no canvas, native readable file inputs and host uploads; `scrollTop` assignment is a **no-op**, `document`/`window` listeners never fire | `docs/.../front-components.md` |
| `timelineActivity` is a writable standard object with `targetPerson`, `linkedRecordId`, `linkedObjectMetadataId`, `name`, `happensAt`, `properties` | `STANDARD_OBJECT.timelineActivity` field list |
| Twenty now ships `messageCampaign` / `messageList` / `messageListMember` standard objects (email-oriented) | `STANDARD_OBJECT` — newer than the TRD's platform survey; see D-13 |
| There is **no** notification standard object exposed to apps | Full `STANDARD_OBJECT` enumeration; see D-10 |
| `toolTriggerSettings` exposes a logic function to Twenty chat, MCP and function calling; in SDK 2.31.0 it accepts a JSON input schema and no output schema/caller-header settings | `twenty-sdk/define` declarations; Twenty logic-functions documentation; see 17 |
