# Changelog

All notable changes to this application are documented in this file.

## Unreleased — UI/UX review

- Give chat a full-width expanding message box and a compact icon toolbar with keyboard-accessible tooltips; separate template selection from Send and improve Send contrast in dark mode.
- Keep drafts, selected uploads and template parameters after refused sends; prevent duplicate submissions and accidental sends during IME composition.
- Fit the composer and attachment actions in narrow/short widgets, account for Twenty's UI scaling, and fix clipped delivery ticks.
- Recover from failed campaign detail/preflight/search/preview reads, preserve schedule time zones and clearing, and add explicit Save draft.
- Scope inbox shortcuts to the list, retain the selected filter, and show conversation action failures.
- Improve text contrast, keyboard focus, field descriptions, upload guidance and settings feedback. Campaign layouts respond immediately to pane width.
- Add 24 UI regression tests, 5 draft-route tests and a draft-persistence integration test. See `reports/ui-ux-audit-2026-11-03.md` for findings and validation.

## Unreleased — native attachments on Twenty 2.54

- Device files upload directly through Twenty's host API, with image previews, validation, replacement, removal and retry. Recent conversation files remain available for reuse.
- Templates, campaign media headers and voice recordings share the same upload path. Saved campaign drafts and queued messages retain their files through FILES associations.
- Removed the S3 browser, workspace-wide attachment search, manual URL fields and base64 upload route.
- Require Twenty 2.54.0, with matching SDKs and standalone CLI. Route authorization now uses the platform execution context; server repositories explicitly use application access. Updated phone/actor selections for the 2.54 schema.

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
