# 06 — Templates and consent

Implements FR-TPL-1 … FR-TPL-7, FR-CON-1 … FR-CON-4, SEC-6, SEC-10, and the template half of
AR-17.

---

## Part I — Templates

### 1. `wa-template-sync` — FR-TPL-1

`cronTriggerSettings: { pattern: '0 */6 * * *' }` · `timeoutSeconds: 120`.
Also invocable with `{ accountId }` from the settings UI ("Sync now") and from
`wa-template-event` when a webhook references an unknown template (03 §6).

```
for each account with status in (connected, error):
  cursor = undefined
  seen   = new Set()
  do:
     { templates, nextCursor } = provider.listTemplates(account.wabaId, cursor)
     for each meta template:
        seen.add(meta.id)
        upsert whatsappTemplate by (accountId, metaTemplateId):
           name, language, category, status, qualityScore, components
           variableSpec      = deriveVariableSpec(components)          # §2
           { isUsableInCrm, unsupportedReason } = assessSupport(components)
           if category changed: previousCategory = old; flag for admin review
           if status left 'approved': publishedToCrm = false           # fail closed
           lastSyncedAt = now
     cursor = nextCursor
  while cursor
  templates not in `seen` -> status = 'disabled', publishedToCrm = false
                             (Meta deletion is invisible; absence is the only signal)
```

Writes are batched at ≤60 records per Core API call (NFR-R2). Meta paginates
`GET /{waba_id}/message_templates` with `paging.cursors.after`; the loop is capped at 50 pages
(≈5 000 templates, comfortably above the 250/6 000 portfolio limits) with a `warn` if the cap is
hit.

**Sync is authoritative.** Nothing in the CRM may edit `category`, `status`, `components` or
`qualityScore` — Meta owns them, including silent re-categorisation. The only CRM-owned column is
`publishedToCrm`.

### 2. `deriveVariableSpec` and `assessSupport` (`src/domain/template-spec.ts`)

Parsing Meta's `components` array in the browser on every render would be wasteful and would
duplicate the rules; it is done once at sync and stored.

```jsonc
// variableSpec
{
  "namedParameters": false,                                  // detected from {{name}} vs {{1}}
  "header": { "format": "IMAGE", "variableCount": 0 },       // TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION | null
  "body":   { "variableCount": 3, "example": ["Marcos","Pixel","Setembro"] },
  "footer": { "text": "Responda SAIR para deixar de receber" },
  "buttons": [
    { "index": 0, "type": "URL",       "hasVariable": true,  "text": "Ver proposta" },
    { "index": 1, "type": "QUICK_REPLY","hasVariable": false, "text": "Falar com alguém" }
  ]
}
```

`assessSupport` marks a template `isUsableInCrm: false` with a reason for component types the CRM
cannot fill correctly (FR-TPL-4) — currently `FLOW` buttons, `CAROUSEL`, `LIMITED_TIME_OFFER`,
`CATALOG`/`MPM`, `COPY_CODE` (authentication), `OTP` and `VOICE_CALL` buttons, plus two added
during implementation:

- **`LOCATION_HEADER`** — a location header takes a `{type:'location', location:{latitude,…}}`
  parameter and the §5 allow-list has no coordinate source, so the CRM cannot fill it and every
  send would fail. Failing closed here is exactly what the mechanism is for.
- **`MIXED_PARAMETER_STYLES`** — Meta rejects a template mixing `{{1}}` and `{{name}}`, but a
  synced record can still carry both if a component was edited. The parameter array would be
  built one way and validated the other, so it is refused rather than half-supported.

Those templates still sync and
remain visible to admins with an explanation; they simply cannot be selected by a rep or a
campaign. **Silent breakage is the failure mode being designed out**: an unsupported template
that looked selectable would fail at Meta for every recipient.

### 3. Publishing gate — FR-TPL-2

`publishedToCrm` is set only by a *WhatsApp Admin* through the settings UI. The rep-facing picker
and the campaign builder filter on
`status = 'approved' AND publishedToCrm = true AND isUsableInCrm = true`, and the same predicate
is re-checked server-side in the policy gate (04 §1, rule 6) — the UI filter is convenience, the
server check is the control.

Automatic un-publishing happens on rejection, pause, disable, or a `red` quality score (03 §6).
Re-publishing is always a deliberate human act.

### 4. The picker and variable binding — FR-TPL-3

Rendered by `src/components/templates/` inside the chat panel and the campaign builder.

- **List**: searchable, grouped by category, showing language, category badge and quality dot.
- **Preview**: header/body/footer/buttons rendered from `components`, with `{{n}}` shown as
  highlighted chips that update live as the form is filled.
- **Variable form**, one row per `{{n}}`:

  | Binding | Editor | Value at send |
  |---|---|---|
  | Manual | text input | the typed literal |
  | Person field | field picker limited to the allow-list (§5) | resolved from the linked Person |
  | Static | text input marked as reusable | the literal, saved with the campaign |

- **Media header**: a file picker using the host `uploadFile()` function (using a native readable File), or a previously uploaded file; validated against Meta's caps before enabling
  Send (AR-16).
- **Validation**: Send is disabled until every required variable resolves non-empty. Meta rejects
  templates with empty parameters, and WhatsApp additionally rejects parameters containing
  newlines, tabs, or more than four consecutive spaces — validated client-side *and* in
  `buildSendPayload` so a workflow-driven send cannot bypass it.

### 5. Field allow-list for bindings

Bindings are `path` strings resolved against a fixed projection, never an arbitrary property walk
(security: a mapping is admin-authored data that renders into a customer-visible message).

```
person.name.firstName        person.name.lastName        person.jobTitle
person.emails.primaryEmail   person.phones.primaryPhoneNumber
person.city                  person.company.name         person.company.domainName
person.linkedinLink.primaryLinkUrl
workspaceMember.name.firstName          (the sender)
account.displayName
now.date  now.month  now.year           (formatted in Africa/Luanda)
```

Extending the list is a code change with a test, deliberately. Custom-field support is a
follow-up (Q-6 touches the same area).

### 6. Template creation from the CRM — FR-TPL-6 (SHOULD)

`wa-template-submit` (folded into `wa-template-sync`'s file as a second exported handler with its
own `defineLogicFunction`) posts to `POST /{waba_id}/message_templates`:

- form: name (validated `^[a-z0-9_]{1,512}$`), language, category, body with `{{n}}` placeholders,
  optional header/footer, up to 3 quick-reply or 2 URL/phone buttons, and **required example
  values** for every placeholder (Meta rejects submissions without them — a common first-attempt
  failure);
- creates the local record immediately in `status: 'pending'` so the review is trackable;
- Meta's review verdict arrives via `message_template_status_update` (03 §6), not by polling;
- rate awareness: Meta permits 100 template creations per WABA per hour — the route counts
  submissions in `kv` and refuses past 90/hour with a clear message rather than letting Meta
  return an opaque error.

Category is a *request*: Meta may re-categorise. The UI states this next to the category selector,
and the synced category is what drives billing (FR-TPL-5) and campaign eligibility.

### 7. Per-template analytics — FR-TPL-7 (MAY)

`wa-stats-rollup` already aggregates status deltas; extending it to increment
`whatsappTemplate.sentCount/deliveredCount/readCount` costs one extra write per template per tick.
Included if capacity allows; the fields exist in the schema either way so enabling it later is not
a migration.

---

## Part II — Consent

### 8. Model — FR-CON-1

Two-part, by design:

- `person.whatsappOptInStatus` — the denormalised current state, so views, filters and the
  campaign audience query are indexable.
- `whatsappConsentEvent` — the append-only evidence trail (who, when, how, **what wording was
  shown**, source reference). This is what an Angolan Lei 22/11 or GDPR enquiry actually needs
  (SEC-11); the SELECT field alone would not survive scrutiny.

Every status change writes both, in that order, in one function (`src/server/consent.ts`) so they
cannot diverge:

```ts
export const setConsent = async ({ personId, newStatus, method, actorId, wordingShown, sourceReference }) => {
  const previous = await readStatus(personId);
  if (previous === newStatus) return { changed: false };            // idempotent, no duplicate events
  await createConsentEvent({ personId, previousStatus: previous, newStatus, method, actorId, wordingShown, sourceReference, occurredAt: now });
  await patchPerson(personId, { whatsappOptInStatus: newStatus, whatsappOptInUpdatedAt: now });
  await createTimelineActivity(`whatsapp.consent.${newStatus}`, personId, { method, actorId });
  return { changed: true };
};
```

### 9. Enforcement — FR-CON-2, SEC-6

Implemented once, in the policy gate (04 §1):

| Situation | Verdict |
|---|---|
| `opted_out` + business-initiated (any template, any lane) | **denied**, `opted_out`. No role, no UI path, no API parameter can override it (SEC-6) |
| `opted_out` + free-form reply inside an open service window | **allowed** — the customer wrote to us; refusing to answer is both unhelpful and not what opt-out means |
| `unknown` + marketing template, 1:1 | allowed with warning `consent_unknown_marketing` |
| `unknown` + marketing campaign | **denied** at snapshot (FR-CAM-5) — excluded, not warned |
| `unknown` + utility/authentication template | allowed |
| `opted_in` | allowed |

The distinction between the 1:1 warning and the campaign block is intentional: a rep sending one
template to one contact they are already talking to is a judgement call; blasting 5 000
unconsented contacts is the fastest route to a RED rating and number suspension (R-11).

Because the check lives in `evaluate()` and `wa-outbound-sender` re-runs it immediately before
the HTTP call (04 §5 step 4), an opt-out that arrives while a campaign is mid-flight suppresses
the remaining sends — including recipients already claimed into a batch.

### 10. Keyword handling — FR-CON-3

`wa-consent-keyword` (enqueued from the inbound processor, 03 §4 step 9b):

```
text = normalise(message.body)      # trim, casefold, strip punctuation and accents
if text matches any WA_OPT_OUT_KEYWORDS  -> setConsent(opted_out, method:'keyword', sourceReference: wamid)
                                            send ONE confirmation (see below)
if text matches any WA_OPT_IN_KEYWORDS   -> setConsent(opted_in,  method:'keyword', sourceReference: wamid)
                                            send ONE confirmation
```

Matching is exact-token against the normalised message, not substring: "PARAR" opts out, "não
vou parar de recomendar" does not. Accent folding means "SAIR" matches "sair" and "Sair".
Default lists (pt/en, `WA_OPT_OUT_KEYWORDS`): `STOP`, `SAIR`, `PARAR`, `CANCELAR`;
`WA_OPT_IN_KEYWORDS`: `START`, `INICIAR`, `SIM`.

**Exactly one confirmation.** The confirmation is a free-form message (the inbound just opened the
window, so it is free and legal) sent through the normal outbound path with
`sourceKind: 'system'`. `setConsent` returning `{ changed: false }` suppresses it, so a contact
who sends "STOP" three times receives one reply, not three. The confirmation text is an
application variable (`WA_OPT_OUT_CONFIRMATION_PT` / `_EN`) so the wording can be reviewed by
counsel (Q-4) without a deploy, and the sent wording is stored on the consent event.

The opt-out block applies from the moment `setConsent` commits; any campaign message already
accepted by Meta cannot be recalled, which the UI states plainly on the campaign stats panel.

### 11. Manual and bulk consent changes

- **In-thread**: a consent chip in the chat header lets an agent record an opt-in captured
  verbally or in writing, with a mandatory "wording shown" field. Method `in_thread`.
- **On the Person record**: the `whatsappOptInStatus` field is editable by an admin, but the
  edit alone would bypass the evidence trail. Therefore a `person.updated` database-event
  function watching `updatedFields: ['whatsappOptInStatus']` back-fills a
  `whatsappConsentEvent` with `method: 'manual'` and the editing member as actor. Direct field
  edits are thus permitted *and* audited.
- **Import**: `wa-consent-route { action: 'import', rows }` accepts `{ personId, status,
  wordingShown, occurredAt }` in batches of ≤60, method `import`. Admin-only, audit-logged.
  There is deliberately no "mark everyone opted-in" button.

### 12. Workflow-triggered sends — FR-CON-4

Nothing special is needed: the workflow action calls the same policy gate (04 §3). The test for
this requirement asserts that a workflow targeting an `opted_out` person completes with
`status: 'denied'`, `reason: 'opted_out'` and produces no Meta call — not that it throws.

---

## 13. Requirement trace

| Requirement | Where |
|---|---|
| FR-TPL-1 sync (install, manual, cron, webhook) | §1, 03 §6 |
| FR-TPL-2 approved + published gate | §3, 04 §1 rule 6 |
| FR-TPL-3 preview + variable binding + live preview | §4 |
| FR-TPL-4 unsupported components flagged, not broken | §2 |
| FR-TPL-5 template name/language/category + params stored | 02 §3 fields, 04 §6 |
| FR-TPL-6 submission from CRM | §6 |
| FR-TPL-7 per-template analytics | §7 (MAY) |
| FR-CON-1 status field + append-only events | §8 |
| FR-CON-2 hard block, replies still allowed | §9 |
| FR-CON-3 keywords, single confirmation, logged | §10 |
| FR-CON-4 workflows respect suppression | §12 |
| SEC-6 no override from any role | §9, 04 §1 |
| SEC-10 audit of consent changes | §8, §11 |

---

## 14. As built (2026-08-16)

**§6's "second exported handler" does not work.** The SDK reads one logic function per file, from
the default export; a named `defineLogicFunction` is ignored without a warning, so
`wa-template-submit` folded into the sync file simply did not exist. It has its own file, and an
architecture test now fails the build on a second declaration (D-20).

**"Sync now" lives on the account route, not on a second trigger.** `wa-template-sync` is a cron
worker returning a result object; an HTTP route must return a `Response`, and one function cannot
sensibly be both. `POST /whatsapp/account { action: 'syncTemplates', accountId }` is the settings
entry point, which is where the operator already is. The webhook path also works now: an unknown
template on `message_template_status_update` enqueues a full sync, which §1 described and no code
did.

**A truncated page walk disables nothing.** Absence is Meta's only deletion signal, so a listing
cut short by the page cap or an API error is indistinguishable from a WABA whose templates were
all deleted. The pass is marked `truncated` and the disappearance sweep is skipped — withdrawing a
working template set from every rep because page 51 timed out is the worse failure by far.

**Consent confirmations pick their language from a variable, not from the keyword.** The keyword
lists are operator-editable, so "STOP" says nothing reliable about what language the contact
reads; `WA_CONFIRMATION_LOCALE` decides, and all four wordings are variables so counsel can revise
them without a deploy (Q-4).

**An opt-out from an unlinked conversation blocks the thread.** With no Person there is nothing to
attach evidence to, but the request must still be honoured — so `thread.isBlocked` is set, which
suppresses every send through the policy gate's second rule. The alternative is a contact who
asked to stop and keeps receiving messages because nobody had matched them to a record yet.

**The back-fill trigger must not fight `setConsent`.** `setConsent` writes the event first and the
field second, so the `person.updated` trigger always fires with an event already present; writing
another would double every keyword opt-out in the evidence trail. The guard is a matching event
within 30 seconds. It errs towards writing: a duplicate is confusing, a missing one is a
compliance gap, and only one of those can be reconstructed later.

**Erasure needed a permission the role deliberately withheld** — see D-21. The dry run worked and
the real call returned `500`, because counting only reads.
