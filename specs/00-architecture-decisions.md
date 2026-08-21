# 00 — Architecture decisions & TRD deltas

Each decision below is binding for implementation. Decisions marked **Δ TRD** amend the TRD;
the amendment text is what should be folded back into TRD v1.2.

---

## D-1 — The Meta callback URL is platform-assigned, not author-chosen

**Status: SPECIFIED · PROBE P-1 ANSWERED (2026-08-21, Twenty 2.31.1, crm.pixel.ao)**
· Δ TRD §5.1, AR-6, §12.1, §12.2

**P-1 result — split verdict, and both halves matter.**

*Question 1 — does the server-route endpoint accept `GET`?* **No.** With the app installed and
the registration claimed, `GET /webhooks/server/{resolver}` returns the front-end shell, while
`POST` to the same URL reaches the resolver. Confirmed independently on 2.31.6 (issue #1) and
2.31.1. So the **P-1 fail** branch below is the live one: the reverse-proxy alias is required,
not optional, and `wa-webhook-resolver`'s `GET` branch stays as the thing that makes a future
platform version need no change here.

*Question 2 — is a `Response` body returned verbatim or JSON-encoded?* **Verbatim.** The verify
route answers a wrong token with a bare `Forbidden` and `text/plain`, with no `{"statusCode":…}`
envelope around it — and Meta's verification of the real token then passed end to end. The
envelope seen while debugging (`{"statusCode":403,"messages":["Logic function execution failed"]}`)
comes from the platform catching an *exception*, not from wrapping a returned `Response`; it is
the signature of a function that threw, which is a useful thing to be able to tell apart.

The consequence for the handler is that `new Response(challenge, { headers: { 'content-type':
'text/plain' } })` is correct exactly as written, and must not be "fixed" into a JSON body.

The TRD specifies the callback path as `https://{domain}/s/whatsapp/webhook`. That path shape
belongs to `httpRouteTriggerSettings`. `ServerRouteTriggerSettings` accepts **only**
`forwardedRequestHeaders` — the endpoint is derived from the resolver's universal identifier:

```
POST https://{domain}/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd
```

Because `LF_WEBHOOK_RESOLVER` is a compile-time constant (appendix C), the URL is stable and
known at build time. The settings UI (§FR-ACC-2) renders it by concatenating
`window.location.origin` with `/webhooks/server/` + the constant, with a copy button.

### The GET handshake problem

Meta verifies a callback by issuing `GET {callback_url}?hub.mode=subscribe&hub.challenge=…&hub.verify_token=…`
and requires the response body to be **the bare challenge string** (`text/plain`, no JSON
quoting). Two unknowns:

1. Does the server-route endpoint accept `GET` at all? The documentation describes it as `POST`.
2. If it does, is a `Response` body returned verbatim or JSON-encoded? A JSON-encoded body
   (`"1158201444"`) fails Meta's verification.

**Probe P-1** (week 1) answers both. Two specified outcomes:

- **P-1 pass** — single URL, nothing further needed. `wa-webhook-resolver` handles `GET` by
  reading `event.queryStringParameters['hub.verify_token']`, comparing against
  `META_VERIFY_TOKEN` with `timingSafeEqual`, and returning
  `new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })`.
- **P-1 fail** — the reverse proxy in front of Twenty owns one public path and method-splits it:

  ```caddy
  @wa_verify   method GET
  @wa_events   method POST
  handle /whatsapp/webhook {
      reverse_proxy @wa_verify twenty:3000 {
          rewrite /s/whatsapp/verify{uri.query}          # httpRouteTriggerSettings, isAuthRequired:false
      }
      reverse_proxy @wa_events twenty:3000 {
          rewrite /webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd
      }
  }
  ```

  Meta is then configured with `https://{domain}/whatsapp/webhook`. Full Caddy and Nginx
  snippets: [11-observability-operations.md § Reverse proxy](11-observability-operations.md#reverse-proxy-configuration).
  The verification-only HTTP route (`LF_WEBHOOK_VERIFY`, `/s/whatsapp/verify`,
  `isAuthRequired: false`) is implemented **unconditionally** — it costs ~30 lines and removes
  the probe from the critical path.

**Never** point Meta directly at `/webhooks/server/{uuid}` in production docs without also
documenting the proxy alias: rotating the resolver's UUID would silently break ingestion.

---

## D-2 — One webhook POST fans out inside the workspace, not at the resolver

**Status: SPECIFIED** · Δ TRD AR-7

The TRD has the resolver "dispatching to the appropriate processor function
(`wa-inbound-processor` for `value.messages[]`, `wa-status-processor` for `value.statuses[]`)".
A resolver can name exactly **one** target function per request, and a single Meta POST routinely
carries several `entry[]` elements, each with several `changes[]`, and a single `messages`
change carries `messages[]` *and* `statuses[]` *and* `errors[]` simultaneously.

Pipeline:

```
Meta POST
  └─ wa-webhook-resolver        (owner workspace; HMAC verify; resolve workspaceId)
        └─ returns { workspaceId, target: LF_WEBHOOK_INGEST, payload: rawBodyEnvelope }
              → platform answers 202 {queued:true}
        └─ wa-webhook-ingest    (target workspace)
              1. explode entry[]/changes[] → one whatsappWebhookEvent row per change
              2. enqueueJob per work item:
                   value.messages[]  → LF_INBOUND_PROCESSOR   (one job per message)
                   value.statuses[]  → LF_STATUS_PROCESSOR    (one job per status batch of ≤50)
                   message_template_* → LF_TEMPLATE_EVENT
                   account_update / phone_number_quality_update → LF_ACCOUNT_EVENT
```

`wa-webhook-ingest` performs no Meta I/O and no matching logic — it is a pure fan-out so that a
poison payload cannot stall the queue. Its `timeoutSeconds` is 15.

---

## D-3 — Workspace routing uses a SERVER-scoped kv claim keyed by phone number **and** WABA

**Status: SPECIFIED** · New (TRD is silent)

The resolver runs in the app-owner workspace and must produce a `workspaceId`. Mirroring the
Slack app's `slack-team:{team_id}` pattern:

| Key (scope `SERVER`) | Value | Written by | Cleared by |
|---|---|---|---|
| `wa:phone-number:{phone_number_id}` | `workspaceId` | `wa-account-admin-route` on successful connect | disconnect action, `wa-uninstall` |
| `wa:waba:{waba_id}` | `workspaceId` | same | same |

Resolution order in the resolver:

1. `entry[].changes[].value.metadata.phone_number_id` → `wa:phone-number:…`
2. fall back to `entry[].id` (the WABA id, present on template/account events) → `wa:waba:…`
3. no claim → return `new Response({ ok: true, skipped: 'unclaimed' })` **with 200**, so Meta
   stops retrying an event nobody owns. Increment a counter and log at `warn`.

This is required even in the single-workspace self-hosted deployment (A-1): the resolver has no
implicit "the only workspace" handle.

Multi-account (FR-ACC-6) works naturally — each `phone_number_id` writes its own claim.

---

## D-4 — "Persist before ack" is not achievable as written; compensating controls specified

**Status: SPECIFIED (accepted deviation)** · Δ TRD AR-7, NFR-R1

AR-7 requires the raw payload to be persisted **before** returning 200. On this platform the
resolver returns a dispatch instruction and the platform immediately answers `202`; the raw event
row is written by `wa-webhook-ingest` a moment later, in the target workspace. There is no hook
between "verified" and "acked" where a workspace-scoped record can be written.

Accepted, with these compensating controls:

1. `wa-webhook-ingest` writes all `whatsappWebhookEvent` rows **before** enqueueing any
   processing job. The durability gap is therefore only the platform's own dispatch queue, not
   our business logic.
2. Meta retries an unacknowledged or 5xx-answered delivery for up to 7 days. The resolver
   throws (→ non-2xx) on any failure it cannot classify, so Meta keeps retrying.
3. `wa-health-check` (hourly) alerts when `whatsappAccount.webhookLastEventAt` exceeds a
   configurable staleness threshold, catching a silently broken pipeline.
4. `wa-reconcile` behaviour is folded into `wa-health-check`: for every `whatsappMessage` in a
   non-terminal status older than 15 minutes, re-derive status where the API allows and
   otherwise mark `failed` with `errorCode = 'INTERNAL_TIMEOUT'` (NFR-R3).

**TRD amendment text for AR-7:** *"The resolver SHALL verify the signature and return a dispatch
result within 1 s. The dispatched ingest function SHALL persist the raw payload as
`whatsappWebhookEvent` records before performing any further processing."*

---

## D-5 — Pacing is deterministic scheduling, not a contended token bucket

**Status: SPECIFIED** · Δ TRD AR-12, AR-19

`kv` exposes `get`/`set`/`delete` with no compare-and-swap. A token bucket in `kv` read-modify-
written by N concurrent senders will lose updates and either over-send (risking Meta 130429) or
deadlock.

Instead, pacing is assigned **at enqueue time by a single writer**:

- Each `whatsappAccount` carries two cursor fields: `interactiveCursorAt` and `campaignCursorAt`
  (`DATE_TIME`).
- The enqueuing function (`wa-send-message-route` for 1:1, `wa-campaign-runner` for bulk) reads
  its cursor, computes a slot for each message —
  `slot_i = max(now, cursor) + i * (1000 / laneRate) ms` — writes the new cursor back, and calls
  `enqueueJob(LF_OUTBOUND_SENDER, { messageId }, { delayMs: slot_i - now, retryLimit: 0 })`.
- Retries are re-enqueued by the sender itself with its own backoff (`delayMs`), so a retry never
  jumps the queue.

**Lane rates** implement the AR-19 priority split without a priority queue:

| Lane | Default rate | Rule |
|---|---|---|
| interactive (rep-typed, workflow 1:1, template send from a thread) | `sendThrottlePerSecond × 0.4`, minimum 5/s | never blocked by campaign traffic |
| campaign | `sendThrottlePerSecond × 0.6` | paused/slowed by guardrails |

`sendThrottlePerSecond` defaults to 20 (well under Meta's 80/s). The lanes are independent
cursors, so a saturated campaign lane cannot delay an interactive send — satisfying NFR-S5
structurally rather than by best effort.

Per-recipient spacing against error 131056 is enforced separately: `wa-outbound-sender` refuses
to send if the thread's `lastOutboundAt` is under 250 ms old and re-enqueues itself with
`delayMs: 250`.

Concurrency caveat: two *interactive* sends racing on the same cursor can lose one update. That
costs at most one extra message in a second — acceptable at a 40 %-of-ceiling lane rate. The
campaign lane has exactly one writer (the cron runner) and is therefore exact.

---

## D-6 — Front-end freshness is an aggregated polling endpoint with an explicit request budget

**Status: SPECIFIED** · Δ TRD FR-UI-4, NFR-R2, C-1

Naïve 5 s polling from every open surface breaks the 100 req/min API budget:
25 reps × 12 req/min × (thread + inbox) = 600 req/min.

Design:

- **One** app HTTP route serves all UI freshness needs:
  `GET /s/whatsapp/feed?scope=thread|inbox|campaign&id=…&since=<ISO8601>` (`LF_INBOX_FEED_ROUTE`).
  It returns only deltas since the cursor, and the components hold everything else in React state.
- Requests to app HTTP routes are authenticated with `TWENTY_APP_ACCESS_TOKEN`, and the route's
  own reads of workspace records happen server-side in one batched query — so one UI poll costs
  one inbound request plus a bounded number of internal reads, instead of N Core API reads
  from the browser.
- **Adaptive intervals**, configured by `WA_POLL_INTERVAL_*` application variables:

  | Surface state | Interval |
  |---|---|
  | Chat panel, thread open, window focused | 3 s |
  | Chat panel, window blurred | 20 s |
  | Inbox list, focused | 8 s |
  | Campaign stats, running campaign | 10 s |
  | Any surface, 15 min without user interaction | poll suspended; a "Reconnect" chip resumes it |

  Worst realistic case: 25 reps × 20 req/min = 500 req/min against the app route. This still
  exceeds a 100 req/min budget **if that limit applies to app HTTP routes**. → **Probe P-2** must
  measure the limit that actually applies to `/s/*` routes on the target version (Q-5).
  Fallback if the limit binds: raise the focused interval to 10 s, and gate on the
  self-hosted instance's configurable rate-limit env var (R-7).
- Overlap guard: the sandbox drops `AbortSignal`, so each component keeps an `inFlight` ref and
  skips a tick rather than stacking requests.
- Optimistic rendering on send masks the interval for the action that matters most (FR-OUT-1).

---

## D-7 — Chat scrolling must be CSS-driven; the sandbox cannot scroll programmatically

**Status: CONFIRMED IN THE BROWSER 2026-08-16** · Δ TRD FR-UI-1, C-3, R-3

Verified with a real conversation: the chat opens anchored to the newest message, older messages
prepend without moving the view, and no scripted scrolling exists anywhere in the component. One
correction from D-53 — the mechanism only works once the list has a scroll port at all, which
means the surface needs an explicit height (`SURFACE_MAX_HEIGHT`); a widget left to size itself
grows and scrolls the page instead.

In the front-component sandbox, assigning `scrollTop`/`scrollLeft` is a documented **no-op**, and
`IntersectionObserver` throws. A conventional chat implementation ("append message, scroll to
bottom", "observe sentinel to load more") is therefore impossible.

Specified implementation:

- The message list is a `display:flex; flex-direction: column-reverse; overflow-y: auto`
  container fed the message array **newest-first**. The browser anchors a column-reverse
  scroller at the bottom, so new messages appear pinned to the bottom with no scripted scroll,
  and the user's scroll position is preserved when older messages are prepended (visually
  appended).
- Older pages load from an explicit **"Load older messages"** button rendered at the visual top
  (array end), plus an `onScroll` handler that auto-triggers the same action when
  `scrollTop` (read is allowed) approaches the extent. No observers.
- Day separators are computed during render, not injected by measurement.
- The composer is a controlled `<textarea>`; focus cannot be set programmatically
  (`.focus()` throws), so the panel must not rely on autofocus. Keyboard send is
  `onKeyDown` (Enter = send, Shift+Enter = newline).

---

## D-8 — Inbound media is downloaded selectively, with a size ceiling below Meta's

**Status: SPECIFIED** · Δ TRD AR-15, AR-16

Meta allows documents up to 100 MB. Buffering 100 MB in a logic function and re-uploading it
through `MetadataApiClient.uploadFile` is a memory and timeout hazard at unknown platform limits
(Q-5). Specified behaviour:

- `WA_MEDIA_AUTO_DOWNLOAD_MAX_BYTES` (application variable, default **26_214_400** = 25 MB).
- Media at or under the ceiling: downloaded by `wa-media-worker` and stored in the message's
  `mediaFile` FILES field.
- Media above the ceiling: **not** downloaded. `mediaMeta.deferred = true` is stored with the
  `media_id`, mime and size, and the UI shows a "Download (18 MB)" action that invokes
  `wa-media-worker` on demand. Media IDs stay valid for 7 days, so the affordance is real, and
  it degrades to "expired — ask the contact to resend" after that.
- Outbound media keeps Meta's own caps as hard validation (AR-16) and always sends by
  `media_id` (AR-14), never by link.

---

## D-9 — Timeline activities are written directly to the standard `timelineActivity` object

**Status: SPECIFIED (PROBE on app write permission)** · Δ TRD FR-TL-1

`timelineActivity` is a standard object exposing `name`, `happensAt`, `properties` (JSON),
`targetPerson`, `targetCompany`, `linkedRecordId`, `linkedObjectMetadataId` and
`linkedRecordCachedName`. WhatsApp events are written as records on it — see
[09-workflows-timeline-notifications.md](09-workflows-timeline-notifications.md) for the event
name catalog and payload shapes.

**Probe P-3**: confirm an app role can create `timelineActivity` records (it may be
engine-owned/read-only). Fallback if not writable: rely on Twenty's automatic timeline entries
for the linked `whatsappMessage` records and surface history through the WhatsApp tab only,
downgrading FR-TL-1 to SHOULD with stakeholder sign-off.

---

## D-10 — There is no notification API; FR-IN-5's "in-app notification" is re-specified

**Status: OPEN → recommendation SPECIFIED** · Δ TRD FR-IN-5

The full standard-object surface contains no notification entity, and the front-component host
API offers only `enqueueSnackbar` (which requires a mounted component). A true in-app
notification to an offline assignee is not achievable inside the app boundary.

Re-specified as three layers, delivered together:

1. **Unread state** — `whatsappThread.unreadCount` and an inbox filter; the WhatsApp Inbox page
   shows per-thread unread badges (FR-UI-2/FR-UI-6). This is the primary signal.
2. **Live toast** — a headless front component (`isHeadless: true`) mounted on the Inbox page
   polls the feed route and calls `enqueueSnackbar` for new inbound messages assigned to the
   current user. Only fires while a Twenty tab is open on that page.
3. **Escalation via workflow** — `whatsappMessage.created` is a database-event trigger
   (FR-WF-2), so operators can wire "create a Task for the assignee" or "post to Slack" using
   the first-party Slack app. This is the only channel that reaches an offline rep, and it is
   configuration, not code.

Desktop/push notifications (FR-UI-7, MAY) remain out of scope.

**TRD amendment for FR-IN-5:** replace *"an in-app notification to the thread assignee"* with
*"an unread indicator on the thread and inbox for the assignee, a live toast while the Inbox is
open, and a `whatsappMessage.created` database event that operators may route to Tasks or Slack."*

---

## D-11 — Relations are separate two-sided field files; scalar fields are inline

**Status: SPECIFIED** · New

`defineObject` accepts inline field manifests, but a `RELATION` needs its counterpart field's
universal identifier on the other object, which creates a circular import if both live inside
their object files. Following the postcard example, the convention is:

- Scalar/composite fields (`TEXT`, `SELECT`, `DATE_TIME`, `RAW_JSON`, `FILES`, `NUMBER`,
  `BOOLEAN`) are declared **inline** in `src/objects/<name>.object.ts`.
- Every relation is **two files** in `src/fields/`, one per side, each exporting its own
  identifier constant and importing the other's:
  `<field>-on-<object>.field.ts`.
- Field universal identifiers are **derived**, never hand-generated, via
  `getFieldUniversalIdentifier({ applicationUniversalIdentifier, objectUniversalIdentifier, name })`
  (a deterministic UUID v5). Only object/function/component/layout/role/index identifiers are
  hand-assigned v4 UUIDs (appendix C). This keeps the registry to ~55 entries instead of ~200 and
  removes an entire class of copy-paste bug.

---

## D-12 — Idempotency is enforced by unique constraints and treats conflict as success

**Status: SPECIFIED** · Δ TRD AR-8

- `whatsappMessage.wamid` — `isUnique: true` + unique index `IDX_MESSAGE_WAMID`.
- `whatsappWebhookEvent.dedupKey` — `isUnique: true` + unique index.
- `whatsappCampaignRecipient` — unique index on (`campaign`, `person`).
- `whatsappThread` — unique index on (`account`, `waId`).

All writers use *create-and-catch*, not *check-then-create*: a uniqueness violation is caught,
counted as `dedup_hit`, and returns success. Read-then-write loses to concurrent duplicate
webhook delivery, which Meta explicitly permits.

Soft-delete interaction is a **PROBE (P-4)**: if a soft-deleted row still occupies the unique
index, a purged-then-replayed message cannot be re-created. Fallback: the retention purge
(SEC-9) hard-destroys rather than soft-deletes `whatsappMessage`, and the ingest treats an
"already exists but deleted" conflict as `skipped_duplicate`.

---

## D-13 — Twenty now ships `messageCampaign`/`messageList`; we still own our objects

**Status: SPECIFIED (decision recorded)** · Δ TRD §2.1

Since the TRD's platform survey, `messageCampaign`, `messageList` and `messageListMember` have
appeared as standard objects, and `person` carries `listMemberships`. They are email-shaped
(`fromAddress`, `subject`, `bodyTemplate`, `unsubscribeTopicId`, bounce/complaint counters) and
`timelineActivity` even has a `targetMessageCampaign`.

Decision: **keep app-owned `whatsappCampaign`/`whatsappCampaignRecipient`.** WhatsApp campaign
state (tier budget, per-recipient Meta error codes, template parameter snapshots, `tier_waiting`)
has no home in the email model, and coupling to a young standard object contradicts the TRD's
§2.4 rationale.

Two concessions that cost little and pay off if the models converge:

- Campaign **audience selection** accepts a `messageList` as an audience source alongside a
  Twenty view and manual selection (FR-CAM-2 extension) — reusing the platform's list-building UX
  where it already exists.
- `whatsappCampaign` mirrors `messageCampaign`'s counter naming (`sentCount`, `failedCount`, …)
  so a future migration is a projection, not a redesign.

---

## D-14 — Provider seam is a plain module boundary, not an injected interface

**Status: SPECIFIED** · Refines AR-18

`src/providers/whatsapp/` exports a `WhatsAppProvider` type and one implementation,
`cloudApiProvider`, selected by a single `getProvider()` factory reading
`WA_PROVIDER` (application variable, default `cloud-api`). Logic functions import
`getProvider()`, never `fetch` against `graph.facebook.com` directly — enforced by an oxlint
rule banning the literal `graph.facebook.com` outside `src/providers/`.

Interface (exact signatures in [appendix-a-meta-api.md](appendix-a-meta-api.md)):

```ts
type WhatsAppProvider = {
  sendMessage(input: SendMessageInput): Promise<SendResult>;
  uploadMedia(input: UploadMediaInput): Promise<{ mediaId: string }>;
  fetchMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string; fileSize: number; sha256: string }>;
  downloadMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
  listTemplates(wabaId: string, cursor?: string): Promise<{ templates: MetaTemplate[]; nextCursor?: string }>;
  createTemplate(wabaId: string, definition: MetaTemplateDefinition): Promise<{ id: string; status: string }>;
  getPhoneNumber(phoneNumberId: string): Promise<MetaPhoneNumber>;
  markAsRead(phoneNumberId: string, wamid: string): Promise<void>;
  verifyWebhookSignature(rawBody: string, header: string | undefined): boolean;
  parseWebhook(body: unknown): NormalisedWebhookEvent[];
};
```

---

## Decision summary

| ID | Decision | TRD impact |
|---|---|---|
| D-1 | Callback URL is `/webhooks/server/{resolverUUID}`; proxy alias + GET-verify route | Amend §5.1, AR-6, §12 |
| D-2 | Resolver → single ingest function → internal fan-out | Amend AR-7 |
| D-3 | SERVER-scoped kv claims key routing by `phone_number_id` and `waba_id` | New |
| D-4 | Persist-before-ack relaxed; compensating controls | Amend AR-7, NFR-R1 |
| D-5 | Deterministic `delayMs` scheduling with interactive/campaign lanes | Amend AR-12, AR-19 |
| D-6 | Single aggregated feed route + adaptive polling + measured budget | Amend FR-UI-4 |
| D-7 | `column-reverse` chat, explicit "load older"; no programmatic scroll | Amend FR-UI-1, R-3 |
| D-8 | 25 MB inbound auto-download ceiling, deferred download above it | Amend AR-15 |
| D-9 | Direct `timelineActivity` writes | Confirms FR-TL-1, probe |
| D-10 | No notification API — unread + toast + workflow escalation | Amend FR-IN-5 |
| D-11 | Two-sided relation files; derived field UUIDs | New convention |
| D-12 | Unique constraints + create-and-catch | Refines AR-8 |
| D-13 | Keep app-owned campaign objects; accept `messageList` as audience source | Amend §2.1, FR-CAM-2 |
| D-14 | Provider module + lint-enforced boundary | Refines AR-18 |


---

## D-15 — Runtime code never depends on `twenty-sdk/define` values

**Status: SPECIFIED (forced by the platform)** · Discovered 2026-08-15 during phase 5 verification

The logic-function bundler replaces every value imported from `twenty-sdk/define` with
`__anyStub`. That module builds the *manifest*; it is not a runtime library. So a derived
constant like

```ts
export const MESSAGE_MEDIA_FILE = fieldId(OBJ_MESSAGE, 'mediaFile');   // getFieldUniversalIdentifier
```

evaluates to nothing inside a running function.

**Nothing warns.** The type checker still sees a `string`, `dev:build` succeeds, `plan` and
`apply` are clean, and the first real call fails with
`Variable "$fieldMetadataUniversalIdentifier" of required type "String!" was not provided` — a
message naming neither the constant nor the cause. The bundle is the only place the truth is
visible (`var getFieldUniversalIdentifier = __anyStub;`).

Consequences:

1. The `define*` factories remain fine to import: their return value is read at build time and
   never at runtime, so the stub is harmless.
2. Everything else — `getFieldUniversalIdentifier`, `STANDARD_OBJECT`, `FieldType` — is banned
   from `src/logic-functions/**` and `src/server/**`, enforced by `architecture.test.ts`.
3. Metadata identifiers a function needs at runtime are **asked of the server** and cached
   (`src/server/metadata-ids.ts`). The server is the better authority anyway: it holds whatever
   the last apply actually created.

Plain string literals (`OBJ_*`, `LF_*`, `ROLE_*`) are unaffected — they are literals, not
derived values, and survive bundling intact.

---

## D-16 — File uploads go through the **metadata** client

**Status: SPECIFIED (forced by the platform)** · Discovered 2026-08-15

`uploadFile` exists as a method on both `CoreApiClient` and `MetadataApiClient`, but
`uploadFilesFieldFileByUniversalIdentifier` is implemented only on the **metadata** endpoint.
Calling it through the core client fails with `Unknown type "Upload". Did you mean "Float"?`.

A method existing on a client is not evidence that its endpoint serves the mutation. The original
spec said `MetadataApiClient.uploadFile` and was right.

---

## D-17 — A changed application-variable declaration does not overwrite a saved value

**Status: OBSERVED** · 2026-08-15

An `applicationVariable` already stored in a workspace is a *user setting*. Editing its declared
`value` and re-applying changes the default for fresh installs and leaves every existing install
on the old value — correct behaviour, and a trap when the value is also a lookup key.

It bit `WA_PROVIDER`, declared `cloud-api` while the provider registry knew `META_CLOUD_API`.
Everything typechecked, every unit test passed, the app applied cleanly, and the first live
connect failed with `Unknown WA_PROVIDER "CLOUD-API"`. Two fixes, both needed:

- the declaration now matches the registry key, `UPPER_SNAKE_CASE` like every other SELECT;
- `getProvider` canonicalises separators and carries an explicit alias for the previously shipped
  value, because re-applying cannot migrate a setting an operator may have saved. An alias is not
  a fallback: an unrecognised provider still throws.

A test compares the declared options against the registry so the two cannot drift again.

---

## D-18 — One HTTP exception outside the provider, narrowed by an origin guard

**Status: DECIDED** · 2026-08-16

AR-11 confines every outbound HTTP call to `src/providers/whatsapp`, and the rule is enforced by
an architecture test rather than a lint rule because it needs to fail the build. Outbound media
forces exactly one exception: an attachment's bytes live in Twenty's own storage, and something
has to read them before they can be uploaded to Meta.

`RestApiClient` from the SDK cannot do it — it reads every response with `response.text()`, which
corrupts binary content silently rather than failing. So `src/server/files.ts` calls `fetch`, and
is the only module outside the provider that may.

What keeps that an exception rather than a hole:

- `resolveFileUrl` compares `URL.origin` against `TWENTY_API_URL` and throws otherwise, so the
  function cannot be handed Meta's media CDN URL — which arrives *inside* a webhook payload and is
  precisely the second path to Meta that AR-11 exists to prevent;
- the comparison is on `origin`, never a string prefix, because `startsWith` passes for
  `https://crm.example.com.attacker.test/`;
- the architecture test asserts both the exception list and the presence of the guard, so removing
  the check fails the build rather than quietly widening the rule.

---

## D-19 — Repository finders never use Twenty's singular record query

**Status: OBSERVED** · 2026-08-16

`whatsappThread(filter: { id: { eq: … } })` does not answer `null` for a record that is not there.
It answers `null` **and** a GraphQL error, `RECORD_NOT_FOUND`, which the genql client raises.

So a finder written the obvious way — the one an editor's autocomplete offers first — throws where
its signature promises `null`. Every caller's not-found branch becomes unreachable: a route that
should answer `404 Unknown thread` answers `500 Internal error`, and inside a queued job a deleted
record becomes a lost job rather than a handled skip.

It typechecks, and it passes every unit test, because the defect is in the server's response and
not in our code's shape. It was found by asking a live route for a thread id that does not exist.

Every finder now uses the plural query with an id filter and `first: 1`, which answers an empty
connection. An architecture test bans the singular form in `src/server/repositories`.

---

## D-20 — One logic function per file, declared on the default export

**Status: OBSERVED** · 2026-08-16

The SDK discovers logic functions by reading each file's **default** export. A second
`defineLogicFunction` assigned to a named export type-checks, builds, uploads — and is silently
absent from the manifest.

06 §6 suggested folding `wa-template-submit` into `wa-template-sync`'s file "as a second exported
handler with its own `defineLogicFunction`". Done exactly as written, the submit route simply did
not exist: no error, no warning, and a `404` at the path the spec documents. It was caught by
reading a plan and noticing a function missing from it, which is not a way to find things.

Each function now has its own file, and an architecture test fails the build on any file
containing more than one `defineLogicFunction` or declaring one anywhere but the default export.

---

## D-21 — Destroy permission belongs to a test, not to the role

**Status: DECIDED** · 2026-08-16

The app role withheld `canDestroyAllObjectRecords` on the reasoning that erasure should be an
explicit, audited routine rather than something a handler does by accident. The reasoning was
right and the mechanism was wrong: **a role is app-wide and cannot tell one handler from
another**, so the flag did not distinguish accidental deletion from the deliberate one — it
prevented both.

The symptom was precise and misleading. `POST /whatsapp/consent { action: 'erase' }` returned a
correct dry run — counts and all, because counting only reads — and then `500` on the real call.
The feature SEC-8 requires was unimplementable by a setting intended to protect it.

The flag is now granted and the control is expressed where it can be: an architecture test
confines every `destroy*` mutation to `src/server/erasure.ts`. That is stronger than the role
was — it names the module, fails the build, and states the reason — and it does not break the
feature it protects. Anything else that must destroy records (the retention purge, SEC-9) joins
the list deliberately, with its own justification.

---

## D-22 — A campaign thread carries the person the campaign chose

**Status: DECIDED (forced by a live defect)** · 2026-08-16

`upsertThread` resolved identity only for inbound, on the reasoning that an outbound-initiated
thread has nobody to match. That is true for a rep starting a chat from a phone number. It is
false for a campaign, which picked the contact *out of a CRM audience* and therefore knows
exactly who it is — and the runner was not telling the thread.

The consequence is not cosmetic, because **the sender reads consent through `thread.personId`**.
With no link the policy gate saw no person, read `UNKNOWN`, and reached its marketing-only
branch. That branch happened to deny the run under test, which is how the defect surfaced at all:
the denial came back `NO_CONSENT` for two contacts who had explicitly opted out. Had the campaign
used a **utility** template, no branch would have fired and the opt-out that arrived while the
message sat in the queue would have been ignored — the exact failure FR-CON-2 and SEC-6 forbid.

Two lesser consequences followed from the same gap: the conversation never appeared on the
contact's record, and a reply went back through identity matching, which can create a *second*
Person for someone the campaign already had.

`upsertThread` now accepts a known `personId`. It links an unlinked thread in place and **never
re-links a linked one** — an identity a human decided, or that inbound matching resolved,
outranks a caller's assumption, and silently moving a conversation to a different contact is
worse than leaving it where it is.

Nothing short of a live run would have found this. It type-checks, it passes every unit test, and
the denial it produces looks like a policy working correctly.

---

## D-23 — An audience filter is translated exactly or refused by name

**Status: DECIDED** · 2026-08-16

FR-CAM-2a lets an admin pick a saved Twenty view as a campaign audience. A view is *metadata* —
`viewFilter` rows against `fieldMetadataId`, nested in `viewFilterGroup`s — and the Core API
accepts none of that, so the audience path has to translate it into a `PersonFilterInput`.

A translation that is *nearly* right is worse than none. The audience is who receives a marketing
message; a dropped condition widens it, and the result is indistinguishable from working. So
`src/domain/campaign/view-filter.ts` translates each (field type, operand) pair exactly or returns
a sentence saying why it cannot, and **one untranslatable filter refuses the whole view** — at
build time, with a 400 naming the filter, rather than three log lines deep inside a queued
snapshot.

Deliberately unsupported today:

- **`IS_RELATIVE`.** "This month" and "the last 30 days" have calendar boundaries whose
  interpretation we would be guessing at, in a timezone we would also be guessing at. Live
  probing showed Twenty stores these as a token — `PAST_30_DAY` — rather than the structured
  object the naming suggests, which is one more thing to get wrong. Refusing costs the admin an
  absolute date; guessing costs the wrong several hundred people a message.
- **`VECTOR_SEARCH`.** A full-text search cannot define an audience: its results change with the
  index.
- **`NOT` filter groups.** They do not appear in the UI's filter builder, and treating one as
  `AND` would invert the audience.

Everything else the builder can produce is covered: text (including composite fan-out across
`firstName`/`lastName` when no sub-field is named), select, multi-select, boolean, number, date
and relation, with `IS_EMPTY` on text correctly meaning *null or empty string*, since Twenty
writes `''` into a cleared column.

---

## D-24 — An erasure that cannot prove it finished must not issue a receipt

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`collectErasureTargets` read one page of each kind — 200 threads, 1 000 messages, 500 consent
events — and treated it as the whole set. A contact with a longer history kept the oldest part of
it while `erasePerson` returned success, wrote a `DATA_ERASED` activity, and left a tombstone
saying the data was gone. Under-deleting is bad; under-deleting **and issuing a receipt** is the
shape that survives an audit until the day it does not (SEC-8).

Three things changed:

- Every read pages to exhaustion, ordered by `id` so the cursor is stable. A cursor that stops
  advancing raises `ErasureIncompleteError` rather than looping.
- Deletion runs in **rounds**: delete, re-read, stop only when a fresh read comes back empty. This
  also covers the inbound message that lands mid-erasure — the webhook does not know an erasure is
  running, and a row created after the enumeration would otherwise outlive it.
- If the workspace is still not clean after `MAX_ERASURE_ROUNDS`, **nothing is recorded** and the
  caller gets an error. The rows deleted are still deleted; what is withheld is the claim that the
  person was cleared.

Tombstones from earlier erasures are now excluded from the targets. They carry counts and an
actor, never content, and destroying them would mean a second erasure quietly deleting the proof
of the first.

---

## D-25 — After Meta accepts, nothing may look like a Meta failure

**Status: DECIDED (forced by a review finding)** · 2026-08-16

Every post-acceptance write — the wamid, the thread, the campaign recipient, the tier ledger, the
timeline — sat inside the same `try` as `sendMessage`. So a Core API blip while writing the wamid
was caught by the send's own `catch`, classified as a *Meta* error, and the message a customer had
just received was written down as `FAILED`, its recipient row with it, and the wamid — the only
handle on a sent message that exists — was lost, so the delivery receipts arriving a minute later
matched nothing.

A double send was one classification away: any post-acceptance error carrying an HTTP 429 or 5xx
would have been *rescheduled*, onto a row that still looked unsent.

The send is now alone in the `try`. Everything after it is bookkeeping, and every piece of it is
individually guarded: a failure is counted and logged with the step that failed, and the outcome
stays `sent`. If the wamid write itself fails, an acceptance marker goes to `kv` — a different
system from the one that just failed — and the sender checks that marker before every send. It is
never cleaned up: a message id is used once, and an outbound send is not worth risking twice to
save a key.

---

## D-26 — A missing variable is a missing variable wherever it lives

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`resolveParameters` reports gaps two ways: `missing` (body positions) and `missingKeys` (every
gap, named). The snapshot passed `missing` to the exclusion rule, so an unresolvable **header
media** or **button URL** excluded nobody. The campaign reported a full audience, then failed
every recipient at Meta, one send at a time, for a condition knowable at build time for free.

`ExclusionCandidate.missingVariables` now takes the keys. The exclusion breakdown gains nothing it
did not have; what it gains is being right.

---

## D-27 — A rebuild retires the snapshot it replaces

**Status: DECIDED** · 2026-08-16

Found while fixing D-28. Building a campaign twice is ordinary — fix a mapping, swap a template,
widen a view — and the second build inherited the first one's rows. Their numbers still counted as
taken by `findExistingPhones`, so **every person was excluded as a `duplicate` of their own row
from the previous build**, and the campaign reported an audience of nobody with a reason that made
no sense.

`build` now retires the previous snapshot first: `PENDING`, `CLAIMED` and `EXCLUDED` rows become
`SKIPPED` with `errorCode: SNAPSHOT_REBUILT`, and the duplicate detector ignores retired rows.
They are retired rather than deleted because hard deletes live in the erasure routine alone (D-21)
and a recipient row is the record of who a campaign was going to message. `upsertRecipients`
writes over any retired row whose person is still in the audience, so a rebuilt campaign keeps one
row per person showing the current decision.

---

## D-28 — Editing what a campaign was built from unbuilds it

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`update` accepted edits on a `ready` campaign and left it ready. A `ready` campaign holds
parameters *frozen against one template for one set of people* (FR-CAM-2), so changing
`templateId` underneath it meant `launch` would fill the new template's placeholders with the old
template's values — silently, because every field involved is present and valid.

Changing any of `templateId`, `accountId`, `audienceDefinition` or `variableMapping` now sends the
campaign back to `draft` through `transitionCampaign`, and it must be rebuilt before it can
launch. Renaming a campaign or moving its `scheduledAt` touches nothing the audience was derived
from, so those edits leave a built campaign built.

---

## D-29 — The lanes divide the ceiling; they do not each get one

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`laneRate` computed each lane independently, each with its own floor. At `throttlePerSecond: 3`
the interactive floor returned 5 and the campaign floor 1.8 — 6.8/s handed out against a ceiling
of 3, by the module whose entire purpose is holding that ceiling (AR-12).

The two lanes now sum to exactly `throttlePerSecond`. Interactive is served first, as AR-19
requires, but only up to what is left after a small campaign floor, so priority never becomes
starvation in either direction. A floor is a preference; the account's ceiling is not.

---

## D-30 — A status that beat its message is retried, not logged

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`ORPHAN_GRACE_MS` exists because Meta's webhook can beat the response to our own POST. The
processor computed it, logged `retryable: true`, and then marked the webhook event `PROCESSED`
anyway — so the status was dropped and its message reported `accepted` for ever. A window whose
verdict changes nothing is not a window.

Orphans inside the grace window are now re-enqueued to this same function after 30 seconds,
carrying `orphanAttempt`, up to three times — which fits inside the five-minute window, so the cap
and the window agree about when a race becomes a fact. The event is marked `PROCESSED` only if
everything in it was applied or handed on; if the requeue itself fails, the event is marked
`FAILED` so the redrive can find it.

---

## D-31 — One failed probe is not a broken account

**Status: DECIDED (forced by a review finding)** · 2026-08-16

The hourly health check set `ACCOUNT_STATUS.ERROR` on any probe failure, and the policy gate reads
`ERROR` as *send nothing*. So a single refused connection to Meta's Graph API silenced a working
number until the next hour's check — an outage manufactured by our own monitoring.

A transient failure (429, 5xx, network) now leaves the status alone and records the detail with a
counter; three consecutive transient failures, or any credential rejection, stops the account. A
rejected credential is a fact about the account; a 5xx is a fact about the minute.

---

## D-32 — One account's failure may not cancel the workspace's sweep

**Status: DECIDED (forced by a review finding)** · 2026-08-16

The health check's per-account loop had an unguarded `await` in it, and the checks that unstick the
*whole workspace* — stuck messages, stale campaign claims, failed webhook events — ran after that
loop. So a Core API blip while writing one account's tier window meant none of them ran, and every
stuck message stayed stuck for another hour.

Each account is now checked inside its own boundary; a failure is counted, logged against that
account, and the sweep continues.

---

## D-33 — A cap that reads as a result is worse than a slow sweep

**Status: DECIDED (forced by a review finding)** · 2026-08-16

The window sweeper processed one batch of 60 per 15-minute run. Above 60 expiries a quarter hour
the backlog grew for ever, and because each run reported "swept 60" it looked healthy the whole
way.

The sweep now drains up to `MAX_SWEEP_PASSES` batches — 1 200 threads a run — and a run that
reaches that limit returns `truncated: true`, counts a metric and logs a warning. The cap remains,
because a 60-second budget is a real constraint; what changes is that hitting it is *visible*.
This is the general rule the review kept finding exceptions to: **a bounded operation must say
when the bound was reached.**

---

## D-34 … D-39 — The second pass over the review

**Status: DECIDED** · 2026-08-16

Six smaller findings from the same review, each verified against the code before being fixed and
each carrying a test that fails against what it replaces. They are grouped because they share one
sentence: **a value we did not recognise was treated as one we did.**

- **D-34 — an unknown header format is not a text header.** `headerFormatOf` coerced any
  unrecognised `format` to `TEXT`. Meta adds component formats; the first template carrying a new
  one would have been derived as text, marked usable, and failed at Meta for every recipient of
  whatever campaign chose it. It now yields `null` and `assessSupport` refuses the template with
  `UNKNOWN_HEADER_FORMAT`, which is what FR-TPL-4 asks the mechanism to do.
- **D-35 — a blank numeric filter is not zero.** `Number(null)` and `Number('')` are both `0` and
  perfectly finite, so a numeric view filter with no value translated into `= 0` and selected a
  different audience. Blank is now refused before the conversion, in keeping with D-23.
- **D-36 — `constructor` is not a media kind.** `MEDIA_LIMITS[kind]` answered with an inherited
  function rather than `undefined`, so a request body naming `constructor` or `toString` walked
  past the unknown-kind branch and threw on `limit.mimeTypes.length`. Own-property check.
- **D-37 — a miss on a full page is not "not there".** The metadata id resolvers took the first
  500 objects and 200 fields and answered `null` when the target was not among them, which is the
  same answer they give for something that genuinely does not exist. They still answer `null` —
  guessing would be worse — but they now log when the page they searched was full.
- **D-38 — blocking a conversation is audited.** Block and unblock changed the one flag that makes
  the policy gate refuse every send and the snapshot exclude the contact, and left only a log
  line. Assign and relink were already audited; so is this now.
- **D-39 — the rollup hint is cleared only if it did not change.** A recount takes several round
  trips, and a status landing mid-recount wrote a delta the recount had not seen; clearing
  unconditionally discarded it, leaving the campaign's numbers one event behind until something
  else moved them — which, for a finished campaign's last delivery, is never.

Two further findings in the same batch were fixed for the same reason as D-32: bookkeeping was
sharing a failure boundary with work that must not fail. The round-robin assignment cursor moved
out of the create's race-handling `try`, where a failure was either misread as a create race or
rejected an upsert whose conversation already existed; and `listDueCampaigns` gained an
`orderBy scheduledAt` so a workspace with more due campaigns than one page cannot starve the
oldest.

---

## D-40 — A view filter that cannot be reached is refused, not ignored

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`translateViewFilters` walks down from the root through `parentViewFilterGroupId`. Anything the
walk never reaches — a filter whose group has been deleted, a group whose parent chain is broken
or circular — was silently absent from the translation.

That is the D-23 failure in its purest form: a **dropped condition widens the audience**, and the
result looks like a working translation. The existing test for the cyclic case even asserted the
old behaviour, `{ ok: true, filter: null }` — which for a campaign audience does not mean "no
filter", it means **every contact in the CRM**.

The translation now reconciles: every filter row and every group must have been visited, or the
whole view is refused by name, like every other thing this module cannot reproduce exactly.

---

## D-41 — The access token goes to Meta's hosts, and nowhere else

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`downloadMedia` is the one call in this app whose URL arrives in a *payload* instead of being
built here, and it attaches the Bearer token — so the URL decides who receives the credential.
The webhook signature makes a hostile URL unlikely, not impossible: one Meta-side open redirect,
or one signature check lost in a future refactor, and the token leaves with the request.

The host is now checked against an allow-list (`graph.facebook.com`, `lookaside.fbsbx.com`,
`*.fbcdn.net`, `*.fbsbx.com`, `*.facebook.com`, `*.whatsapp.net`) over HTTPS only, before `fetch`
is called at all. Note that `lookaside.fbsbx.com.evil.example` fails it — the suffix test is on
dot-prefixed suffixes, not `includes`.

The same review found the download's timeout being cleared in a `finally` around the `fetch`,
which left `response.arrayBuffer()` outside it: a connection that stalled mid-body was no longer
being aborted by anything of ours, and held the worker until the platform's own timeout. The body
read is now inside the timeout.

---

## D-42 — A header that cannot be filled fails here, not at Meta

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`buildTemplatePayload` dropped a declared header from the payload when it could not produce a
parameter — a media header with no resolved id, or a format the CRM cannot fill. Meta answers that
request with 132000, "parameter count mismatch", for every recipient: an error naming the symptom
and hiding the cause, arriving one send at a time.

It now throws where the cause is, which is the rule the media *send* path has followed from the
start. With D-26 excluding those recipients at snapshot time, this is the second line: the one
that catches a header that became unfillable between the snapshot and the send.

---

## D-43 — Omitting a status reason leaves it alone

**Status: DECIDED (forced by a review finding)** · 2026-08-16

`transitionCampaign` documented three behaviours for `reason`: a string sets `statusReason`,
`null` clears it, and omitting it leaves whatever is there. The parameter defaulted to `null`, so
the third was unreachable — the `reason === undefined` guard could never fire and **every**
transition cleared the reason.

`statusReason` is the sentence an operator reads to find out why a campaign stopped —
`quality_red`, `tier_exhausted`, `circuit_breaker`. It survived only until the next caller that
had nothing to say about it moved the campaign on. The default is gone; the documented behaviour
is now the actual one, with tests that fail if the default comes back.

---

## D-44 — A campaign's day is the campaign's day

**Status: DECIDED (forced by a review finding)** · 2026-08-16

The date operands expand an instant into "the whole day" — `IS` on a date, `IS_TODAY` — and did it
against **UTC midnight**, while every date a campaign *renders* is formatted in
`CAMPAIGN_TIME_ZONE` (`Africa/Luanda`). So "created today" meant 01:00 to 01:00 local, and a
contact added at half past midnight fell into the previous day's audience.

The offset is read from `Intl` rather than hard-coded, so a zone with daylight saving would still
get the right boundary. One hour of skew for Angola, more elsewhere — and invisible either way,
because the audience simply comes back slightly different from the one the admin saw in the view.
That is the same class of error D-23 exists to prevent, arriving through arithmetic instead of a
missing operand.

---

## D-45 — Two things that must not hang or throw: a file read and a log line

**Status: DECIDED (forced by review findings)** · 2026-08-16

Both are the same shape as D-41, in the parts of the app that are supposed to be boring.

`downloadWorkspaceFile` had no deadline. It sits in the send path — a campaign's header image is
read before the template goes out — so a stalled connection held the sender until the platform's
own function timeout, with every message behind it waiting. It now carries a 30-second
`AbortSignal` that covers the body read as well as the response, and reports a timeout as a
timeout.

`logger.emit` called `JSON.stringify` unguarded. That throws on a `BigInt`, on a circular
structure, and on any `toJSON` that throws — and the context most likely to contain one is a
described error, which means the throw would land *inside a catch block* and replace the real
error with a `TypeError` about logging it. Serialisation now degrades to a line naming the event
with `contextUnserialisable: true`, because a log line that loses its context is recoverable and
one that replaces an exception is not.

---

## D-46 … D-49 — The last of the review, verified one at a time

**Status: DECIDED** · 2026-08-16

- **D-46 — the media ceiling is measured on the bytes that arrive.** The auto-download limit was
  checked against Meta's *declared* `file_size`, which is absent on some payloads and advisory on
  the rest — so an oversized file was deferred only if Meta had said how big it was. The policy is
  about what lands in workspace storage (D-8), so it is now also checked against the downloaded
  buffer, before the upload.
- **D-47 — a partial component update is folded in, not substituted.** `components_update` sends
  only the changed parts: an edit to the body arrives as `message_template_element` alone.
  Replacing the stored array with it dropped the template's header, footer and buttons locally,
  after which the derived spec said there was no header, the support check called the template
  usable, and the next send built a payload Meta answers with 132000 for every recipient. The same
  phantom change also tripped the variable-count rule and unpublished a template nobody had edited
  that way.
- **D-48 — a number that moves WABA moves the record with it.** Reconnecting a phone number under
  a different WABA wrote the new id into the routing claim and left the old one on the account
  record. Template sync reads the record and webhook routing reads the claim, so the two disagreed
  about which business the number belonged to — in the direction where every template is stale.
  The record is updated and the change is logged and audited, rather than being either silent or
  refused.
- **D-49 — the disappearance scan reads every local template.** It compared Meta's listing against
  one page of 500 local rows, so past 500 a genuinely deleted template was never noticed: it stayed
  `ACTIVE` and publishable, and the campaign that chose it failed at Meta for everyone. It now
  pages to exhaustion — and if it *cannot* finish, it disables nothing, because a partial read is
  indistinguishable from "deleted" to the comparison that follows.

### D-50 — Publishing a template needed a writer, and had none

`publishedToCrm` is the flag FR-TPL-2 hangs on: the picker, the send path and
`campaign create` all refuse a template without it. Every writer in the app set
it to **false** — sync un-publishes on degradation, the webhook un-publishes on
rejection or a changed variable count, the sender un-publishes when Meta refuses
the mapping. Nothing ever set it to true.

So a workspace with five approved templates had an empty picker and could not
create a campaign at all, and no error anywhere said why: the flag was simply
always false, which is indistinguishable from "an admin has not published these
yet". Found by building the settings tab that was supposed to toggle it.

`POST /s/whatsapp/template { action: 'publish' | 'unpublish' | 'list' }`,
admin-only, audited under the `template.publish` action that had been defined
since phase 4 and never emitted. `publishRefusal` re-checks the two conditions
the send path checks — approved at Meta, renderable by the app — because
publishing an unrenderable template puts a row in the picker that fails at Meta
for every recipient.

### D-51 — D-15 recurred, and the guard that would have caught it was never run

Not a new decision — a record of D-15 happening again, because the way it
happened is more useful than the rule.

The campaign builder's view list called
`resolveObjectMetadataId(STANDARD_OBJECT.person.universalIdentifier)`. That is
exactly what D-15 forbids and what `architecture.test.ts` has asserted against
since phase 5 — verified by reverting the fix, which fails the guard with
`logic-functions/wa-campaign-control.ts: defineLogicFunction, STANDARD_OBJECT`.

It reached a running server anyway, because the deploy that carried it ran
`typecheck` and `lint` and not `test`. Both were clean; neither is the guard.
The symptom was an empty dropdown and nothing in any log — the failure mode
D-15 is entirely about.

Two things came out of it. `PERSON_OBJECT_UID` is now a literal in
`constants/universal-identifiers.ts`, with a unit test asserting it still equals
`STANDARD_OBJECT.person.universalIdentifier` — the test runs in Node, where the
stub does not apply, so the copy cannot drift. And the ordering rule for this
repository is now explicit: **`yarn test:unit` before `yarn twenty apply`, every
time.** A guard that is not run is a comment.

### D-52 — Copy is paired, not tabled twice

`copy.ts` held a `PT` table and an `EN` table. Nothing made them agree: a key
could exist in one and not the other, and the failure surfaces as an English
sentence inside a Portuguese screen — or, once a cross-language fallback is
removed, as nothing at all. Neither is visible to a reviewer who reads only one
of the two languages.

Entries are now written as `{ pt, en }` pairs and the two tables are derived, so
a half-translated key is unrepresentable. Two tests hold the rest: every key has
a non-blank string in both languages, and both use the same `{placeholder}` set
— a placeholder present in one language and not the other renders as literal
braces for half the users, which is the same defect wearing different clothes.

A third guard scans the component tree for literal `t('...')` keys the catalog
does not define. Interpolated keys — `t(\`policy.${reason}\`)` — cannot be
checked that way, and the catalog carries a row for every value the server can
put in them.

---

## D-53 — Probe P-6: what the front-component sandbox actually does

**Status: ANSWERED** · Measured 2026-08-16 against `twentycrm/twenty-app-dev:latest`,
in a Person-record widget. Supersedes the guesses in specs/08 §1's preamble, several of which
came from the platform documentation and are wrong.

### Works

| Capability | Result |
|---|---|
| Component renders in a record-page widget | ✅ |
| `useTheme()` | ✅ — returns CSS variables (`var(--t-background-secondary)`) |
| `useRecordId()` | ✅ — the Person id |
| Inline styles | ✅ — layout, colour, alignment, radius all apply |
| `twenty-ui` imports | ✅ resolve and render their text |
| `flex-direction: column-reverse` | ✅ reverses paint order **and anchors to the visual bottom**, once the list has a scroll port |
| `FileReader` | ✅ present — the docs say it does not exist |
| `/rest/*` (Twenty's REST API) | ✅ |
| `node.clientWidth` / `clientHeight` / `scrollHeight` | ✅ real numbers — unlike `getBoundingClientRect()` |
| `window.innerWidth` / `innerHeight` | ✅ — answers for the browser window, not the widget |

### Does not work

| Capability | Result | Documented as |
|---|---|---|
| `getBoundingClientRect()` | **returns 0×0** | "✓ Works (up to 1 frame stale)" |
| `localStorage` | **not defined** | "✓ Works (scoped & limited)" |
| `CSS.supports` | **`CSS` is not defined** | — |
| `ResizeObserver` / `IntersectionObserver` / `matchMedia` | not defined | ✗ throws — correct |
| `canvas.getContext` | not a function | ✗ — correct |
| `twenty-ui` component *styling* | renders unstyled — emotion classes do not apply | — |
| `node.focus()` | **silently does nothing** — no throw, `document.activeElement` unchanged | ✗ throws |
| `/s/*` logic-function routes | **403** — see below | — |

### The two findings that changed the design

**1. A widget has no scroll port of its own, and cannot measure itself the documented way.**

`overflow-y: auto` with `flex: 1 1 auto` produced `scrollHeight === clientHeight === 1337`, then
`1364` after a row was added: the widget grows to fit its content and the *page* scrolls. The
containing grid confirmed it — `grid-template-rows` computed to `1932px` for a chat with eleven
messages inside a 724px pane. So `height: 100%` resolves against an `auto` parent and means
nothing, and `getBoundingClientRect()` returning 0×0 means the widget cannot measure the pane and
adapt either.

**Resolved, both parts.**

- *Height*: `SURFACE_MAX_HEIGHT` (`72vh`) caps the chat and sets the inbox outright. The viewport
  is the only bound CSS can resolve without being told. `height: 100%` stays alongside it, so a
  parent that *is* bounded still wins. With the cap in place, **D-7 is confirmed**: the chat opens
  anchored to the newest message and scrolls internally, with no scripted scrolling anywhere.
- *Measurement*: `getBoundingClientRect()` is the only broken one. `clientWidth`, `clientHeight`
  and `scrollHeight` on the same node all return real numbers, and `window.innerWidth` works too.
  `InboxView` measures with `clientWidth` and the two-pane layout appears as designed. Before
  this it silently took the narrow branch at every width.

**2. `/s/*` routes answered 403 to every signed-in human, and always had.**

The chain, in the order it was found:

- `RestApiClient` from inside the worker reaches `/rest/people` (200) but not
  `/s/whatsapp/feed` (403). So the sandbox and the token are fine.
- The 403 body was ours: `{"error":"Could not verify permissions"}` — `auth.ts`'s catch.
- The cause: `metadataClient().query({ getRoles: … })` fails with *"Entity performing the
  request does not have permission"*. The app's role lacked `SystemPermissionFlag.ROLES`.
  **Granted** — the same class of failure, and the same opaque sentence, as `UPLOAD_FILE`
  before it.
- With the flag, the lookup succeeds and the answer becomes
  `{"error":"This action requires the WhatsApp agent role"}` — because
  `getRoles.workspaceMembers[].userWorkspaceId` is **`null` for every member** on this version,
  while the route event carries only `userWorkspaceId`. The join key `requireCaller` was built on
  does not exist in the data. `loadRoleAssignments` then made it worse by *requiring* the field to
  be a string, discarding every member of every role and leaving an empty map.

**Why nothing caught this.** Every live test of every route so far used an API key. An API key
has no workspace membership, so `requireCaller` returns a machine caller and *returns before the
role lookup*. The role map had therefore never been read in the life of this app. The first
request from a signed-in human was the one that revealed it — which is exactly what a probe is
for, and an argument for running one earlier than the plan did.

### The settings surface removed the only way to configure the app

`defineSettingsFrontComponent` **replaces** Twenty's application-variable editor
rather than sitting beside it. There is no `#variables` route on the app page and
no other surface, so from the day this app shipped a settings component every
variable it declares was a constant — including `WA_OPT_OUT_CONFIRMATION_PT`,
which exists as a variable precisely so counsel can reword it without a deploy
(FR-CON-3). The Diagnostics tab told the operator to go to a "Variables" tab that
had stopped existing.

The app therefore ships its own editor, and pays for it with
`SystemPermissionFlag.APPLICATIONS`. That was not the first choice: the caller's
own bearer token was tried and refused, even though the same token reads
`findOneApplication` happily from the browser — so the platform authorises this
call against the *executing application*, not the bearer, and the flag is the
only key. It is wider than one would like, so the narrowing happens in code
instead: the route is `admin`-gated, and `setVariable` refuses any key this app
did not declare.

### Resolved: the caller's own token makes the join

The app cannot map `userWorkspaceId` to a member. Every source was checked and none of them
does it: Core `workspaceMember` has `userId` and no `userWorkspaceId`; metadata `WorkspaceMember`
declares the field and returns null; `currentUser` under the *app's* token is `Forbidden`, and
would answer for the app anyway.

**The caller can.** `httpRouteTriggerSettings.forwardedRequestHeaders: ['authorization']` delivers
the requester's own bearer token to the handler, and `currentUser` under *that* token answers for
the person holding it. `requireCaller` therefore asks the platform who the caller is, and joins
the role map on `workspaceMember.id` — a key `getRoles` does populate.

Two properties make it safe to trust, and both are enforced in `resolveWorkspaceMemberId`:

- **It is not a claim the caller makes.** The front component sends no identity of its own; the
  token is a credential the platform issued and verifies. Forging it means already holding
  someone else's session. Had the browser been asked to *state* its member id, any rep could have
  claimed the admin's.
- **It is bound to this request.** `currentUser.currentUserWorkspace.id` must equal the
  `userWorkspaceId` the platform injected into the event. A mismatch resolves to nothing.

It fails towards the old behaviour rather than towards permission: no token, a refused
`currentUser`, or a mismatch all return `null`, the role map is then matched on `userWorkspaceId`
as before, and a caller who cannot be placed still gets 403. Nothing is cached — it is one query,
it is the request's identity, and a cache keyed on anything cheaper than the token is a way to
answer as the wrong person.

Verified in the browser: the feed, the account admin route and the settings surface all answer a
signed-in workspace administrator, and `permissions.workspaceMemberId` comes back populated —
which is also why that field is now on the wire, so a null on a signed-in human is *visible*
rather than indistinguishable from having no roles.

### Field correction (2026-08-18) — a picked file's bytes never cross the bridge

The `FileReader` row above was read as licence for a device file picker in the attachment
panel: `FileReader` exists, and the voice recorder's `Blob.arrayBuffer()` works, so a picked
`File` — being a `Blob` — should read the same way. It does not. In production the picked
`File` arrives across the sandbox bridge as a metadata proxy (name, size, type) with **no
`Blob` methods**: `arrayBuffer()` is absent (`e.arrayBuffer is not a function`, live), and
`FileReader` cannot read the proxy either — a fallback through it failed the same pick. The
platform docs' sentence — "a file input exposes its metadata and not its bytes" — was right
all along; only the "`FileReader` is unavailable" half was wrong, and a `FileReader` with no
readable input is a distinction without a difference.

The lesson for future probes: `Blob.arrayBuffer()` was measured on a blob the page *created*
(the recorder's). A capability measured on one object class does not transfer to another that
merely shares its interface on paper — the bridge decides what survives serialisation.

Consequence: the attachment panel's "from this device" source was removed (a tab whose every
pick fails is worse than no tab), leaving "recent in this chat" and "already in Twenty". The
voice recorder is unaffected; its blob is created inside the sandbox. `builders/upload.ts`
remains the recorder's plumbing.

---

## D-54 — Twenty MCP orchestrates; it does not become a second outbound pipeline

**Status: SPECIFIED, with a release-blocking authorisation probe** · See
[17-twenty-mcp-agent-messaging.md](17-twenty-mcp-agent-messaging.md).

An AI agent may use Twenty MCP's ordinary record tools to find a Person, then two app-owned tool
logic functions to list eligible templates and queue one chosen template. It may not create a
`whatsappMessage`, supply a raw phone number, publish a template or call Meta directly.

The existing workflow action is not made dual-surface. It records `WORKFLOW`, accepts workflow
builder shapes and has no mandatory idempotency token. MCP gets a dedicated wrapper that records
`AI_AGENT`, requires a UUID-v4 request id and reuses one shared template-send service. Discovery is
also dedicated: it returns only templates that are approved, published, usable and allowed by the
current 1:1 policy, plus the parameter contract the agent must fill.

This preserves AR-11 and AR-17 mechanically:

```text
Twenty MCP tool → shared template-send service → queued interactive message
                                                    │
                                                    ▼
                                          wa-outbound-sender → Meta
```

`toolTriggerSettings` is the correct Twenty surface, but SDK 2.31.0 exposes no forwarded caller
headers or tool-level identity parameter to the handler. Therefore production exposure is gated on
P-MCP-1 proving that Twenty refuses the tool to a credential without the intended WhatsApp role.
If it does not, the send tool does not ship; caller-supplied identity is not an acceptable fallback.
