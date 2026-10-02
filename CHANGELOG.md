# Changelog

All notable changes to this application are documented in this file.

## 0.1.1 — the callback URL nobody could use

Four defects reported from a live 2.31.6 install ([#1]), all confirmed against the code.

### Fixed — the Meta callback URL was a 404 (P0)

- **The health panel, the post-install log and the README all published
  `<base>/s/whatsapp/webhook`, and no route has ever answered there.** `/s/` is the namespace for
  `httpRouteTriggerSettings` paths; the D-1 fallback is a *reverse-proxy alias* at
  `/whatsapp/webhook`, at the domain root. An off-by-`/s/` turned the one string an operator cannot
  work out for themselves into a dead end, and the webhook could not be configured in Meta at all —
  the app could send, but never receive.
- **Nothing said the alias had to exist.** Meta takes one URL for both the `GET` handshake and the
  `POST` deliveries; Twenty answers those on two different paths, and the proxy rule is what makes
  one URL out of two. The callback card now leads with that sentence, the other two URLs are
  labelled `(GET)` and `(POST)`, and README step 4 carries the Caddy and Nginx snippets, the
  don't-rewrite-the-body warning, and a `curl` probe for whether your Twenty routes `GET` to server
  routes at all — on 2.31.6 it does not, so the alias is required rather than optional.

### Fixed — three smaller ones from the same session

- **`defaultCountryCallingCode` accepted a whole phone number.** The field is free text sitting
  under `phone_number_id` and `WABA id`, and the value went to the record unvalidated — where it
  becomes the prefix put in front of every nationally-formatted contact, so the send fails at Meta
  weeks and several layers away from the typo. Now validated (1–3 digits, normalised to a leading
  `+`), with the counter-example in the hint and the variable description. A new `updateAccount`
  admin action and an editable field on the connected-number card make it fixable without reaching
  for Twenty's GraphQL API, which was previously the only repair.
- **`UNKNOWN` quality was reported as a downgrade.** A brand-new number that has never sent
  anything was greeted with *"Meta lowered the rating. Cut marketing sends and review the
  templates."* `UNKNOWN` means "no data yet"; the row is green for it now, as the `webhook` row
  already was for a number that has never received an event, and the sentence beside it says so
  rather than inventing a grade. `YELLOW` and `RED` still fail.
- **Confirmation texts could drift from the keyword lists silently.** An admin localising
  `WA_OPT_OUT_KEYWORDS` and dropping `SAIR` left `WA_OPT_IN_CONFIRMATION_PT` still telling customers
  to reply `SAIR` — a consent path that fails with no error anywhere. A `consentWording` health row
  now names the dead word, considering only known consent words so a brand or an acronym in the
  wording cannot redden it. Confirmations may also use `{optOutKeyword}` / `{optInKeyword}`, which
  resolve from the live lists and cannot drift; they are not the default, because the lists carry
  no language tag and `{optInKeyword}` would put `START` inside the Portuguese sentence.

[#1]: https://github.com/pixelinfinito/twenty-app-whatsapp/issues/1

## Unreleased — one callback URL, no proxy; Spanish; your own clock

### Changed — the reverse-proxy alias is no longer part of setup ([#4])

- **The webhook resolver now answers the `GET` handshake and the `POST` deliveries on the same
  URL** — `<base>/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd` — because the route declares
  `httpMethods: [GET, POST]`, which the Twenty server supports since 2.35.0 (upstream
  twentyhq/twenty#24401). Meta takes one callback URL; that one now is it. The handler already
  answered the handshake; the platform was the half that was missing.
- **The support floor is twenty-sdk / twenty-client-sdk 2.35.0 and a Twenty 2.35.0 server**, the
  release that carries #24401. `engines.twenty` (published as the manifest's
  `requiredServerVersionRange`) refuses an older server at install instead of failing at the
  handshake, and `.twenty-version` — the CI pin and `docker:start` default — moves to `v2.35.0`
  with it. The previous pin, `v2.31.1`, also had no `twenty-app-dev` image to run.
- **The health panel, the post-install log and README step 4 all lead with the direct URL.** The
  method-splitting proxy alias moves to a clearly optional legacy fallback for a Twenty that does
  not route `GET` to server routes, and the README now also warns that Meta's "Send to my server"
  button reports success without looking at the status code — confirm delivery in
  `whatsappWebhookEvent`, not by that button.

### Added — Spanish ([#6])

- The interface follows a Spanish workspace's locale: 587 entries translated alongside the
  Portuguese and English they sit between, `es-MX` formatting, and the compiler forcing every key
  to carry all three. Terminology follows Meta's console (tier, marketing, callback stay in
  English); the register is `tú` throughout.

### Added — the rendered clock is configurable ([#5])

- **`WA_TIME_ZONE`** (default `Africa/Luanda`, so no existing install moves) drives every rendered
  date: chat and thread timestamps, day separators, the `{{now.*}}` campaign variables and the
  "created today" audience filter. An unrecognised name degrades to the default rather than
  blanking the panel.
- **Day boundaries survive daylight saving.** A day with a transition is 23 or 25 hours, and the
  old fixed `+ 86_400_000` window drifted an hour on every one of them: in New York, "created
  today" leaked the first hour of March 9th into March 8th's audience in spring and cut the last
  hour off November 1st in autumn, and a Sunday-evening conversation stopped being "Yesterday" at
  00:30 the next morning. Boundaries are now found from the zone itself, so the window runs first
  midnight to *next* midnight wherever the clocks move.

### Fixed — the package typechecks again ([#3])

- `aboutDescription` is dropped from `application-config.ts`: the SDK's `ApplicationConfig` has
  omitted the field since it existed, so the app could not pass `yarn typecheck` with it present.
  With the SDK bump and a generated `twenty-client-sdk` schema, lint, typecheck and the unit suite
  (including `schema-enums`, which needs the generated schema to read) all run clean — and CI now
  generates that client from its own instance before checking.

[#1]: https://github.com/pixelinfinito/twenty-app-whatsapp/issues/1
[#3]: https://github.com/pixelinfinito/twenty-app-whatsapp/issues/3
[#4]: https://github.com/pixelinfinito/twenty-app-whatsapp/issues/4
[#5]: https://github.com/pixelinfinito/twenty-app-whatsapp/issues/5
[#6]: https://github.com/pixelinfinito/twenty-app-whatsapp/pull/6

## Unreleased — the attachment panel loses a dead tab and gains a picker

- **"From this device" is gone.** The sandbox bridge hands a picked file's metadata over without
  its bytes — `arrayBuffer()` is absent on the proxy and `FileReader` cannot read it either — so
  every device pick failed at upload (D-53 field correction, specs/00). The platform docs said so
  all along; the probe result that seemed to disprove them had only measured a blob the page
  *created*, which is why voice notes still work. A tab whose every pick fails is worse than no
  tab.
- **"Already in Twenty" opens as a picker.** A new `fileSearch` action on the thread route answers
  the workspace's attachments — newest first, name-searchable, debounced like the campaign
  builder's contact search — and choosing a row fills the address, filename and kind boxes, so
  nobody has to hunt down a file URL by hand. The suggested kind is judged conservatively from the
  stored file's extension (`mediaKindForFilename`): a webp or a .mov is offered as a document,
  which arrives, rather than as media Meta will refuse. The boxes stay editable — a file the
  search cannot see can still be pasted, and the send path itself is unchanged.

## Unreleased — end-to-end QA fixes

Ten defects from the first full end-to-end pass on a live number. Two of them made features
unusable rather than awkward, and both had the same shape: the code was right and the *only path a
person could take to it* was closed.

### Fixed — outbound attachments (P0)

- **Every outbound image, video, audio file and PDF failed** (D-58). The attachment panel asks a rep
  to "copy the file's address from its record in Twenty", and the address in a browser is the
  *front-end* host — while `server/files.ts` refused anything whose origin was not `TWENTY_API_URL`.
  The origin is now **rebuilt** rather than validated: the path and the signed token are re-hung on
  the workspace API origin, which is a stronger guarantee than the check it replaces (the fetch
  target is workspace-origin by construction, so no input can name the host) and the path
  restriction that stops `/rest/people` being read with the app's token is untouched.
- A handle carrying only `filePath` resolved to `/attachment/…` and was refused for being exactly
  what `uploadFile` returns. Bare storage paths are now mounted under the file store.
- **Redirects are followed**, by hand, up to three hops, dropping the app's bearer token on any hop
  that leaves the workspace origin. `redirect: 'error'` made an object-storage backend unsendable;
  `redirect: 'follow'` would have handed a workspace credential to the bucket's host.
- **The failure said the wrong thing about the wrong system.** A workspace read that never reached
  Meta was reported as `MEDIA_UNAVAILABLE` — "the file is no longer available from Meta". It is now
  `ATTACHMENT_UNREADABLE`, it carries the real reason into the sentence a rep reads, it is
  retryable, and **Repetir** on an attachment resends the stored spec rather than needing a caption
  to exist. The send route rejects an unusable address up front, and the panel rejects one before
  the rep presses send.

### Fixed — templates with more than a body (P0)

- **A template with a media header could never be sent** (D-59). `assessSupport` refuses only a
  *location* header, so an image header syncs as usable and appears in both the composer and the
  campaign builder — while `validateParameters` counted its file as required and neither form
  offered anywhere to put one. Send stayed disabled under a counter naming a component with no
  field. Both forms now collect it.
- **The campaign builder wrote `{ body }` and the resolver reads a header and buttons too.** A
  campaign on such a template was buildable, launchable, and excluded every recipient for "missing
  variables". `buildVariableMapping` is now the whole shape, pure and tested against
  `resolveParameters`.

### Fixed — campaigns

- **A campaign with no qualified recipient offered a Launch button** and answered 409 when pressed
  (D-60). The button is withdrawn — including the quality-gate override, which is a risk an admin
  can accept and an empty audience is not — and a banner names the exclusion count instead.
- **A draft was a one-way door** (D-61): the builder wrote one on every step, the detail screen
  could show it, and nothing led back in. **Continuar a editar** reopens it on the furthest step
  already answered, with every field read back out of the record.
- **The counters disagreed with the recipient rows** for up to a minute (D-62) — a cron on sixty
  seconds against a screen polling every five. The detail read now runs the same recount on the way
  through, and only when the campaign's change hint says something moved.

### Fixed — the rest

- **The People command-menu action never appeared** (D-63). `conditionalAvailabilityExpression` is
  compiled from the source of a real comparison against the SDK's context bindings, and this one
  was a string literal — which type-checks, builds, installs, and never matches. An architecture
  test now refuses the string form.
- **The inbox contradicted itself after every action taken in the thread pane** (D-64). The list and
  the filter totals are separate polls on separate clocks; `ThreadView` now tells them when a
  conversation changed as a row.
- **Failed sends were in no diagnostic list** (D-65). "Failed deliveries" is inbound and the stuck
  list is messages nothing moved, so a message something *decided* to fail was invisible — which is
  the whole of D-58. Settings → Diagnostics now shows failed sends with their code and their reason,
  and the health panel has a row for them.
- **Every button on the settings page was offered to a caller who could use none of them** (D-66).
  The page opens by reading diagnostics; one 403 is enough to disable the actions and say why once.
- **"linked a whatsapp conversation Untitled"** (D-67). The thread's label identifier was
  `profileName`, which Meta sends only on inbound and only when the contact has set one; it is now
  the phone number, which every thread has. Re-linking a conversation to the contact it is already
  linked to writes nothing at all.
- **Twenty variables in one undifferentiated list, each with its own Save** (D-68), is now eleven
  named sections and one sticky bar that lists the keys it is about to change.

## Unreleased — phase 10: automation, operations, release

The operational tail. Everything in phases 0–10 that is code is now written; what remains before
the release gate is the human-run part, scripted in
[specs/16-release-checklist.md](specs/16-release-checklist.md).

### Added

- **Twenty MCP WhatsApp tools** — `whatsapp-list-sendable-templates` discovers only approved,
  published templates that pass the current Person/account policy, and `whatsapp-send-template`
  queues one exact template with a mandatory UUID-v4 idempotency key. Agent sends are audited and
  shown in the transcript as `AI_AGENT`; retries replay the original result or refuse a changed
  intent instead of contacting the customer twice.
- **`wa-send-template-action`** — "Send WhatsApp template" as a workflow step (FR-WF-1). A policy
  denial is a *result* (`status: 'denied'` with a machine reason) so an automation can branch on
  it; only infrastructure failures throw. It reuses the same policy gate as a rep's send, which is
  what makes FR-CON-4 true by construction. `domain/workflow-parameters.ts` binds a workflow
  author's free-form `Variables` object onto the template's spec.
- **`wa-webhook-replay-route`** (`POST /s/whatsapp/replay`, admin-only) — list the raw log, replay
  selected events, replay everything failed in a range behind a counted confirmation, or resync one
  conversation. Re-enqueues through the live fan-out, never a replay-only copy of it. Wired into
  Settings → Diagnostics.
- **`wa-retention-purge`** (daily, 03:00) — destroys expired raw webhook events, empties message
  content past the retention window while keeping status and cost, and expires metric counters on a
  fixed 90 days (SEC-9).
- **`post-install` / `uninstall` hooks** (AR-5) — post-install verifies the app roles, re-asserts
  routing claims for connected numbers, records a schema version and logs the Meta callback URL;
  uninstall releases this workspace's claims so the numbers can be connected again, and destroys
  nothing.
- **Default notification workflow provisioning** (D-10 layer 3) — one click creates the workflow,
  its trigger and a Task step as a draft, and names the two decisions left to the operator.
- **`.github/workflows/compat.yml`** — weekly run against `twentycrm/twenty:latest`, opening or
  commenting on a single `twenty-compat` issue on failure (NFR-M2, R-2).
- **Load tests** at the spec's own numbers — 3 000 deliveries keyed and routed, a sliding
  one-second window over the pacing plan, the two-cursor guarantee at a 10 000-recipient campaign,
  a 100 000-recipient snapshot.
- **The security review as tests** — the route role matrix as data (a new route with no reviewed
  entry fails the build), the consent block as an exhaustive matrix, and a secret scan over
  browser-reachable source and the built bundles.
- **`specs/16-release-checklist.md`** — the signed, human-run gate: install rehearsal, the
  thirteen-step handset loop, nine operational procedures, and the load run on real infrastructure.

### Changed

- **The workflow step is configurable from the builder.** `WhatsApp account` and `Template` were
  text boxes — an author had to paste a WABA id and a template id by hand. Both are now `record`
  pickers over `whatsappAccount` and `whatsappTemplate`, listing the real rows by name, which works
  because those are ordinary Twenty objects.
- **Template variables are five labelled fields** (`Variable {{1}}` … `{{5}}`), each a plain string
  so each takes an `(x)` workflow variable, plus an `Advanced` JSON field for a header image, a
  button URL or a named variable. Twenty cannot load a template's variables on demand — the input
  schema is in the manifest and nothing recomputes it from a half-filled step — so a fixed set of
  fields is as close to field-by-field as the platform allows. Field order is controlled through the
  property *names*, because step inputs are stored as `jsonb`, whose keys order by length.
- **The app logo is WhatsApp's mark**, at `public/logo-whatsapp.svg`. Twenty renders the
  *application* logo in every workflow step header, so `workflowActionTriggerSettings.icon` was never
  going to appear there and the four grey squares were what an author saw above "Send WhatsApp
  template". The filename carries the cache bust: public assets are served with
  `max-age=3600` and no content hash, so replacing the bytes in place left browsers showing the old
  icon for an hour while the server served the new one.

### Fixed (found while doing the above)

- **A number bound nothing on a template with named placeholders.** `{ "1": "Ana" }` against
  `{{nome}}` resolved to empty, which meant the step's numbered variable fields — which can only
  send positions — silently failed for every named template. `bodyValueFor` now falls back to the
  1-based position. It failed safe (an unbound variable refuses the send) and was caught by a test
  rather than by the UI.
- **CI is pinned.** `.twenty-version` holds the Twenty version production runs and `ci.yml` reads
  it, so a pull request no longer fails because Twenty shipped upstream this morning. Watching
  `latest` is `compat.yml`'s job.
- `REQUIRED_WEBHOOK_FIELDS` is named once in `domain/constants.ts` — the settings card and the
  post-install log read the same list, so they cannot tell an operator two different things.
- Corrected the route registry: `/whatsapp/template` is singular, and `/whatsapp/upload` and
  `/whatsapp/replay` were missing from appendix C and from the specs/10 role matrix.
- specs/10 §3.4 now records that an API key is **refused** by default rather than treated as an
  admin, which is what the code does and why.

### Fixed

- `yarn typecheck` failed on `import 'twenty-ui/style.css'` — required at runtime, untyped by the
  package. Declared in `src/types/css-modules.d.ts`; the build is green again.

## 0.1.0

- Initial application scaffolded with [`create-twenty-app`](https://www.npmjs.com/package/create-twenty-app)
