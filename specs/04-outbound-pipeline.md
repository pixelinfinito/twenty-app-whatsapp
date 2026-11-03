# 04 — Outbound pipeline

Implements AR-11 … AR-14, AR-17, FR-OUT-1 … FR-OUT-8, NFR-P3, NFR-R3, NFR-S5.
Depends on D-5 (deterministic pacing), D-8/D-14.

> **AR-11 is a hard architectural invariant:** exactly one function may call
> `POST /{phone_number_id}/messages`, and it is `wa-outbound-sender`. Everything else creates a
> `whatsappMessage` in `queued` and schedules a send. An oxlint rule bans `graph.facebook.com`
> outside `src/providers/`, and a unit test asserts that `cloudApiProvider.sendMessage` is
> imported by exactly one logic function.

```
   front component ──► wa-send-message-route ──┐
   workflow step  ──► wa-send-template-action ─┼─► createQueuedMessage() ─► schedule() ─► enqueueJob(delayMs)
   campaign runner ─────────────────────────────┘                                            │
                                                                                             ▼
                                                                              wa-outbound-sender ──► Meta
                                                                                             │
                                                                        statuses webhook ────┘
```

---

## 1. The policy gate (AR-17) — `src/domain/policy/`

One pure module decides whether a send is allowed. UI, HTTP routes, workflow action and campaign
runner all consume the same verdict; none of them re-implements a rule.

```ts
export type SendIntent = {
  kind: 'freeform' | 'template';
  templateCategory?: 'marketing' | 'utility' | 'authentication';
  lane: 'interactive' | 'campaign';
};

export type SendContext = {
  now: Date;
  thread: { serviceWindowExpiresAt: Date | null; windowKind: 'standard' | 'free_entry_point'; isBlocked: boolean };
  person: { whatsappOptInStatus: 'opted_in' | 'opted_out' | 'unknown' } | null;
  account: { status: string; qualityRating: string };
  template?: { status: string; publishedToCrm: boolean; isUsableInCrm: boolean };
};

export type SendVerdict =
  | { allowed: true;  warnings: PolicyWarning[] }
  | { allowed: false; reason: PolicyDenial; warnings: PolicyWarning[] };
```

Evaluation order — first failure wins, and the order is itself normative (AR-11 step ordering):

| # | Check | Denial code | Notes |
|---|---|---|---|
| 1 | account `status === 'connected'` | `account_not_connected` | token invalid/banned pauses everything |
| 2 | thread `isBlocked === false` | `thread_blocked` | manual suppression |
| 3 | consent | `opted_out` | **hard block for business-initiated sends, unoverridable (FR-CON-2, SEC-6).** Replies inside an open window are allowed even when `opted_out`, because the customer initiated |
| 4 | consent for marketing category | `no_consent` | `unknown` denies marketing *campaign* sends (FR-CAM-5) and warns for 1:1 marketing templates |
| 5 | window vs intent | `window_closed` | free-form requires `now < serviceWindowExpiresAt`; templates always pass (FR-OUT-5) |
| 6 | template state | `template_unavailable` | must be `approved` + `publishedToCrm` + `isUsableInCrm` (FR-TPL-2/4) |
| 7 | quality gate | `quality_red` | campaign lane only; interactive is never blocked by quality (FR-CAM-6) |

Warnings (non-blocking, surfaced in the UI): `window_expiring_soon` (< 1 h),
`consent_unknown_marketing`, `quality_yellow`, `test_account`.

### 1.1 Window computation (`service-window.ts`)

```ts
export const computeWindowExpiry = (lastInboundAt: Date, kind: WindowKind, cfg): Date =>
  new Date(lastInboundAt.getTime() +
    (kind === 'free_entry_point' ? cfg.fepWindowHours : cfg.serviceWindowHours) * 3_600_000);

export const isWindowOpen = (thread, now) =>
  thread.serviceWindowExpiresAt !== null && now < thread.serviceWindowExpiresAt;
```

All arithmetic is UTC epoch milliseconds — no local time, no DST class of bug (12-testing.md
pins this). Display formatting in `Africa/Luanda` happens only in front components.

`windowState` on the record is a denormalised cache for filtering, refreshed by
`wa-window-sweeper`; the server **never trusts it** for a send decision, always recomputing from
`serviceWindowExpiresAt`. This is what makes FR-THR-5's 15-minute sweep a UX nicety rather than a
correctness dependency.

---

## 2. `wa-send-message-route` — the UI entry point

`httpRouteTriggerSettings: { path: '/whatsapp/send', httpMethod: 'POST', isAuthRequired: true }`
· `timeoutSeconds: 30`

Request body (discriminated union):

```jsonc
{ "threadId": "...", "clientToken": "uuid-v4-from-the-browser",
  "message": { "kind": "text",     "body": "Olá!", "contextWamid": "wamid.xxx" } }
{ "message": { "kind": "media",    "mediaKind": "image", "fileId": "...", "caption": "..." } }
{ "message": { "kind": "template", "templateId": "...", "parameters": { ... } } }
{ "message": { "kind": "interactive", "interactive": { ... } } }        // FR-OUT-7
{ "message": { "kind": "reaction", "targetWamid": "...", "emoji": "👍" } }  // FR-OUT-8
```

Steps:

1. **Authorise** — resolve the caller's workspace member from the request context and re-check
   the role server-side (SEC-5). A front component cannot be trusted to have hidden a button.
2. **Idempotency** — `clientToken` is stored on the created message; a repeat with the same token
   returns the existing message instead of sending twice. This covers double-clicks and the
   sandbox's retry-on-network-blip.
3. **Load** thread, account, person, template.
4. **Policy** — `evaluate(intent, context)`. Denied → `409` with
   `{ code, message: <machine code>, warnings }`; the component renders localised copy.
   This is what makes FR-OUT-2's server-side mirror real: Meta error 131047 becomes ~impossible
   because we never emit the request.
5. **Create** the `whatsappMessage` in `status: 'queued'`, `lane: 'interactive'`,
   `sourceKind: 'agent'`, `sentBy` = caller.
6. **Schedule** — `scheduleSend(message, 'interactive')` (§4).
7. **Respond `202`** with the created record so the component can render it optimistically
   (FR-OUT-1). Target: ≤ 3 s p95 (NFR-P3) — note this measures *acceptance by us*; the Meta
   round-trip happens in the sender and surfaces as the `accepted` tick.

Media flow (D-70): a native file chooser passes a readable File to the host `uploadFile` API. The authenticated feed provides the real FILES field metadata ID. Chat and voice uploads attach to their queued message before scheduling; campaign headers attach to their saved campaign. Recent-file reuse makes an independent server-side copy because Twenty forbids attaching a permanent file to a second record. The sender reads each retained FILES value to mint a fresh signed download URL before uploading to Meta; scheduled sends never depend on preview URL lifetime.

---

## 3. `wa-send-template-action` — workflow action

`workflowActionTriggerSettings` with `label: 'Send WhatsApp template'`, `icon: 'IconBrandWhatsapp'`
(FR-WF-1). Input schema:

| Input | Type | Notes |
|---|---|---|
| `personId` | `record` (person) | the recipient |
| `accountId` | `string` (select, resolved at design time) | sending number |
| `templateId` | `string` | restricted to approved + published |
| `parameters` | `object` | variable bindings, may reference workflow variables |
| `createThreadIfMissing` | `boolean`, default `true` | |

Output schema: `{ messageId, threadId, status, denialReason? }`.

The action resolves the person's WhatsApp identity (05 §2), finds or creates the thread
(**never** a duplicate — FR-OUT-5/FR-THR-1), runs the *same* policy gate, and schedules on the
interactive lane with `sourceKind: 'workflow'`. A policy denial is not an exception: the step
completes with `status: 'denied'` and a reason, so a workflow can branch on it instead of dying
(FR-CON-4, FR-WF-3).

---

## 4. Scheduling — `src/domain/pacing.ts` + `src/server/schedule.ts`

Implements D-5. The scheduler is the only place that knows about rate limits.

```ts
export const computeSlots = ({ cursorAt, now, count, ratePerSecond }) => {
  const spacingMs = 1000 / ratePerSecond;
  const start = Math.max(now, cursorAt ?? 0);
  const slots = Array.from({ length: count }, (_, i) => start + i * spacingMs);
  return { slots, nextCursorAt: start + count * spacingMs };
};
```

```ts
export const scheduleSend = async (messages, lane, account) => {
  const rate = laneRate(account, lane);              // interactive: throttle × share (min 5/s)
  const cursorField = lane === 'interactive' ? 'interactiveCursorAt' : 'campaignCursorAt';
  const { slots, nextCursorAt } = computeSlots({ cursorAt: account[cursorField], now: Date.now(),
                                                 count: messages.length, ratePerSecond: rate });
  await patchAccount(account.id, { [cursorField]: new Date(nextCursorAt) });
  await Promise.all(messages.map((m, i) =>
    enqueueJob({ logicFunctionUniversalIdentifier: LF_OUTBOUND_SENDER,
                 payload: { messageId: m.id },
                 delayMs: Math.max(0, slots[i] - Date.now()),
                 retryLimit: 0 })));                  // retries are owned by the sender, not the queue
};
```

Two independent cursors mean a campaign saturating its 60 % lane cannot push an interactive send
into the future — the structural answer to AR-19 and NFR-S5.

`retryLimit: 0` is deliberate: platform-level retry would re-run the whole send with no knowledge
of whether Meta already accepted it. The sender owns retry, keyed on message state.

---

## 5. `wa-outbound-sender` — the single send path

`timeoutSeconds: 60`. Input `{ messageId }`.

```
 1. message = load(messageId)
 2. guard: if status not in {queued, failed-retryable} -> counter wa.send.skip_nonqueued; return   # idempotent
 3. guard: if message.wamid already set -> return                                                   # already accepted
 4. re-evaluate the policy gate with fresh data                                                     # AR-11 step 1-2
        the window may have closed between queueing and sending (campaigns especially)
        denied -> status='failed', errorCode='POLICY_<reason>'; recipient row updated; return
 5. per-recipient spacing: if now - thread.lastOutboundAt < WA_RECIPIENT_MIN_SPACING_MS
        -> re-enqueue self with delayMs = remaining; return                                          # 131056
 6. if media and no metaMediaId cached:
        buffer = downloadFromTwentyStorage(fileId)
        validateMediaAgainstMetaLimits(mime, size)                                                   # AR-16
        { mediaId } = provider.uploadMedia(...)                                                      # AR-14
        cache in kv: wa:media-upload:{sha256} -> { mediaId, expiresAt: now + 6 days }                # ≤7d
 7. payload = buildSendPayload(message)                                                              # §6
 8. result = provider.sendMessage(payload)
 9. success -> patch { wamid: result.messages[0].id, status:'accepted',
                       statusTimestamps.accepted: now }
              patch thread.lastOutboundAt = now, lastMessagePreview, lastMessageDirection='outbound',
                    status = 'awaiting_reply'
              if campaign lane: recipient.status='queued'→'sent' on the sent webhook; counters via kv delta
10. failure -> classify(error)                                                                        # appendix B
       retryable && retryCount < 5 -> retryCount++; enqueue self with backoff(2s,4s,8s,16s,32s)+jitter
       terminal                    -> status='failed', errorCode, errorDetail; recipient mirrored
```

Step 4 is what prevents the classic bulk-messaging defect: a campaign queued at 09:00 must not
send a free-form message at 11:00 into a window that closed at 10:00.

**Crash safety (NFR-R3).** A message stuck in `queued` for longer than 15 minutes is picked up by
`wa-health-check`, which re-enqueues it once and then fails it with
`errorCode = 'INTERNAL_TIMEOUT'`. Nothing sits in limbo.

**The double-send hazard.** If Meta accepts the request but the response is lost, step 9 never
runs and a retry would send a second copy. Mitigation: retries are only attempted for errors
classified as *pre-acceptance* (connection errors, HTTP 5xx before response, explicit 429). A
response-parsing failure or a timeout after the request was fully written is treated as
**terminal-unknown**: the message is marked `failed` with `errorCode = 'UNKNOWN_ACCEPTANCE'` and
flagged for the operator, rather than risking a duplicate. This is a deliberate trade of a rare
false-negative for never double-messaging a customer.

---

## 6. Payload construction (`src/providers/whatsapp/payload.ts`)

Golden-file tested against v26.0 (12-testing.md, "Contract" row). One builder per type:

```jsonc
// text with quoted reply
{ "messaging_product": "whatsapp", "recipient_type": "individual", "to": "244923000000",
  "context": { "message_id": "wamid.xxx" },
  "type": "text", "text": { "body": "Olá!", "preview_url": true } }

// media by id (never by link — AR-14)
{ "messaging_product": "whatsapp", "to": "…", "type": "image",
  "image": { "id": "1234567890", "caption": "Proposta" } }

// template with header media, body variables and a url button suffix
{ "messaging_product": "whatsapp", "to": "…", "type": "template",
  "template": {
    "name": "proposta_setembro", "language": { "code": "pt_PT" },
    "components": [
      { "type": "header", "parameters": [ { "type": "image", "image": { "id": "…" } } ] },
      { "type": "body",   "parameters": [ { "type": "text", "text": "Marcos" },
                                          { "type": "text", "text": "Pixel" } ] },
      { "type": "button", "sub_type": "url", "index": "0",
        "parameters": [ { "type": "text", "text": "abc123" } ] } ] } }
```

`to` is the `waId` from the thread, not the dialable phone (FR-CID-2): for Argentina and Mexico
these differ, and using the dialable form produces silent non-delivery.

Named parameters (Meta's newer `parameter_name` form) are supported when
`template.variableSpec.namedParameters` is true — detected at sync time from the components,
not guessed.

---

## 7. Retry and error classification

`classify(error)` (appendix B) returns one of:

| Class | Behaviour |
|---|---|
| `retryable_backoff` | 429, 5xx, 130429, 131056, 131053 → exponential backoff with jitter, max 5 attempts (AR-13) |
| `retryable_after_refresh` | 190/463 token expiry → mark account `error`, alert admin, **do not** retry (a retry with a dead token is noise) |
| `terminal_recipient` | 131026, 131047, 131049, 131051 → fail the message with a specific explanation |
| `terminal_content` | 132000-series template mismatch → fail; if from a campaign, pause the campaign (the mapping is wrong for every recipient, not just this one) |
| `terminal_unknown` | anything unmapped → fail, log the full Meta body, counter `wa.send.unmapped_error` — the signal that appendix B needs a new row |

Backoff base 2 s, factor 2, full jitter, cap 5 attempts (AR-13). Retries re-enter through
`enqueueJob` with `delayMs`, so they respect the same lane pacing.

---

## 8. Marking as read and typing indicators (FR-OUT-8, MAY)

`wa-thread-actions-route` action `markRead` does two things: zeroes `unreadCount` locally and,
when `WA_SEND_READ_RECEIPTS` is enabled, calls
`POST /{phone_number_id}/messages { status: 'read', message_id }` for the newest inbound WAMID.
These calls go through the provider but **not** through the lane scheduler — they are not
messages, are not billed, and must not consume send capacity.

---

## 9. Requirement trace

| Requirement | Where satisfied |
|---|---|
| AR-11 single path | §5, lint rule, `wa-outbound-sender` sole caller |
| AR-12 throttle + pair spacing | §4 lanes; §5 step 5 |
| AR-13 backoff | §7 |
| AR-14 media by id | §5 step 6; §6 |
| AR-17 policy module | §1 |
| AR-19 campaign deprioritised | §4 dual cursors |
| FR-OUT-1 optimistic send | §2 step 7 |
| FR-OUT-2 window awareness both sides | §1 rule 5; re-check in §5 step 4 |
| FR-OUT-3 quoted reply | §6 `context` |
| FR-OUT-4 mapped errors | §7 + appendix B |
| FR-OUT-5 template always available in-thread | §1 rule 5 exempts templates; §3 reuses the thread |
| FR-OUT-6 audit | `sentBy`, `sourceKind`, timeline activity |
| FR-CON-2 unoverridable block | §1 rule 3, re-checked in §5 step 4 |
| NFR-P3 ≤3 s | §2 responds before the Meta round-trip |
| NFR-R3 no limbo | §5 crash safety |
| NFR-S5 campaign never delays 1:1 | §4 dual cursors |

---

## 10. As built (2026-08-16)

Phase 6 is implemented. Five deviations and findings worth carrying forward.

**The policy gate runs twice, and only the second one is a control.** The route's verdict exists so
the composer can explain a refusal before a rep types; the sender re-runs it on data read at send
time. Both call `evaluateSendPermission`, so there is one rule set and two moments — verified live
by blocking a thread and watching `POST /whatsapp/send` answer `409 THREAD_BLOCKED` without
creating a record or contacting Meta.

**A template header now carries a file handle, not just a file id.** `HeaderParameter.fileId`
names a record; it does not name content, and the sender needs bytes. `filePath` and `fileUrl`
were added beside it, and `validateParameters` no longer counts a bare `fileId` as a resolved
header — a header that cannot be uploaded is a pre-flight exclusion with a reason rather than a
132000 for every recipient of a campaign.

**Media limits are validated before the upload, not after** (`src/domain/media-limits.ts`). Meta
answers an oversized image only once the bytes have been sent, so a 12 MB photo would spend the
whole cost of a successful send to produce an error. The image ceiling is 5 MB, not the 16 MB of
audio and video — the limit most often assumed wrong.

**Reading a file from Twenty storage is the one HTTP call outside the provider** (D-18). The SDK's
REST client cannot be used: it reads every response as text, which corrupts binary content
silently.

**Two application variables disagreed with their code fallbacks**, one of them by a factor of a
hundred: `WA_INTERACTIVE_LANE_SHARE` was declared `0.4` against a constant of `40`, in a number
that multiplies the send rate — clearing the variable would have paced the interactive lane at
800/s against Meta's ceiling of 80. `config.interactiveLaneShare()` now reads anything above 1 as
a percentage and clamps to `[0.1, 0.9]`, and `config-drift.test.ts` compares every declaration
against its constant.

### 10.1 Platform note: unauthenticated app routes answer 500

An `isAuthRequired: true` route rejects a missing or invalid token **before the handler is
entered** — confirmed for both `/whatsapp/send` and `/whatsapp/thread`, which answer
`"Missing authentication token"` and `"Token invalid."`. The security property is the one we want,
but the HTTP status is `500`, not `401`.

Front components must therefore treat a 500 carrying either of those bodies as an auth failure and
refresh the token, rather than reporting a server error. Nothing server-side can improve this: our
handler never runs.
