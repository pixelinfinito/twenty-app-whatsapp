# WhatsApp browser QA master plan

| | |
|---|---|
| Status | Release-control specification |
| Owner | QA / Product Engineering |
| Last reviewed | 2026-08-18 |
| Applies to | `twenty-whatsapp` 0.1.x on Twenty 2.54.x and Meta Graph API v26.0 |

## 1. Purpose and quality bar

This is the master plan for testing the application as a user through Twenty's browser UI. It
covers every shipped front-end surface and every user-observable state: installation and
navigation, Settings, templates, the shared inbox, chat on a Person, side-panel chat, rich
messages, campaign creation and control, consent, workflows, timeline effects, roles,
localisation, accessibility, responsive layouts, themes and degraded network states.

The plan complements, rather than replaces, the unit/integration/contract/load plan in
[`../12-testing.md`](../12-testing.md) and the real-number release script in
[`../16-release-checklist.md`](../16-release-checklist.md). Browser QA proves that a user can
discover, understand and complete a capability. API assertions alone do not count as a browser
pass.

Release quality bar:

- Every P0 and P1 case applicable to the build passes in the release browser matrix.
- No open Severity 1 or Severity 2 defect; Severity 3 defects have an accepted owner and date.
- All write actions are tested once as WhatsApp Admin and once under the least-privileged role.
- Every asynchronous action is observed through its final UI state, not only its first success
  banner.
- The browser console has no uncaught errors, unhandled promise rejections, secret values or
  repeated failing requests during the run.
- A real handset completes the Meta-dependent subset; simulator-only evidence is not sufficient
  for delivery, read, media, reaction, reply, opt-out or campaign-send claims.

## 2. Sources and scope

### 2.1 Product sources

The expected behavior comes from the implementation and these specifications:

- [`../05-identity-threads-window.md`](../05-identity-threads-window.md)
- [`../06-templates-and-consent.md`](../06-templates-and-consent.md)
- [`../07-campaigns.md`](../07-campaigns.md)
- [`../08-front-components.md`](../08-front-components.md)
- [`../09-workflows-timeline-notifications.md`](../09-workflows-timeline-notifications.md)
- [`../10-security-roles.md`](../10-security-roles.md)
- [`../11-observability-operations.md`](../11-observability-operations.md)
- [`../16-release-checklist.md`](../16-release-checklist.md)
- The most recent exploratory baseline:
  [`../../reports/whatsapp-browser-qa-2026-08-18.md`](../../reports/whatsapp-browser-qa-2026-08-18.md)

Twenty platform behavior is checked against its official documentation for
[front components](https://docs.twenty.com/developers/extend/apps/layout/front-components),
[navigation menu items](https://docs.twenty.com/developers/extend/apps/layout/navigation-menu-items),
[roles](https://docs.twenty.com/developers/extend/apps/config/roles) and
[testing](https://docs.twenty.com/developers/extend/apps/operations/testing).

### 2.2 In scope

| Surface | User entry point |
|---|---|
| Install and app identity | Settings → Applications → WhatsApp |
| Shared inbox | Sidebar → WhatsApp |
| Person chat | Person record → WhatsApp tab |
| Side-panel chat | Select exactly one Person → command menu → Open WhatsApp chat |
| Campaigns | Sidebar → WhatsApp Campaigns |
| Settings | Settings → Applications → WhatsApp → custom settings section |
| Workflows | Workflow builder → Send WhatsApp template; generated notification workflow |
| Timeline and records | Person/Company timeline and WhatsApp fields visible through Twenty |
| Host integration | Sidebar, page layouts, widgets, command menu, toast/snackbar, clipboard, responsive container, light/dark theme and browser permissions |

### 2.3 Out of scope for this browser plan

Pure algorithms, signature verification, raw webhook contracts, job concurrency, high-volume
load and destructive retention/erasure internals remain in `specs/12-testing.md`. They enter this
plan only where a user can see or operate the outcome. Marketplace review, Meta Business
verification and billing reconciliation outside the displayed estimate/actual cost are separate
operational acceptance activities.

### 2.4 Deferred feature inventory

The current specifications explicitly defer internal notes/snooze, desktop notifications and
sound, saved reply snippets, per-template analytics, a reporting dashboard, campaign export,
duplication, A/B tests and recurring campaigns. They are not silently covered by a nearby case.
Mark them `Not applicable — not shipped` in the run report. The release that adds any of them must
add browser cases here before the feature is accepted.

## 3. Test model

### 3.1 Priorities

| Priority | Meaning | Examples |
|---|---|---|
| P0 | Release cannot ship if it fails | Install/navigation, inbound, allowed send, blocked send, role enforcement, campaign consent gate |
| P1 | Core supported behavior | Rich content, templates, thread controls, campaign lifecycle, settings health, responsive layouts |
| P2 | Important polish or uncommon branch | Empty states, exact copy, browser permission denial, archive navigation, long-content wrapping |

### 3.2 Severity

| Severity | Definition |
|---|---|
| S1 | Data/security/privacy loss, wrong recipient, unauthorized send, duplicate bulk send, or app unusable for everyone |
| S2 | Core user journey blocked, consent/window safeguard bypassed, destructive action without confirmation, or materially wrong campaign numbers |
| S3 | Workaround exists but normal work is impaired or misleading |
| S4 | Cosmetic/copy issue with no incorrect action or lost information |

### 3.3 Case result

Use `Pass`, `Fail`, `Blocked`, or `Not applicable`. A case is `Blocked` only when an external
precondition such as Meta service or an unavailable handset prevents execution; a product defect
is `Fail`. Record one result per browser/role combination required by the case.

For every case capture: build/app/Twenty/Graph versions, browser and viewport, role, locale,
account id suffix, data fixture, start/end time, result, screenshots, relevant video for
multi-step behavior, request/status evidence when needed, and defect link.

## 4. Environment and coverage matrix

### 4.1 Release environments

| Environment | Use | Rules |
|---|---|---|
| Local scratch | Fast UI and destructive-state checks | Fake/test data; console and request inspection allowed; never claim Meta delivery |
| Staging | Full acceptance | Installed from the release candidate; isolated WABA/test number; same variables and reverse proxy shape as production |
| Production smoke | Minimal confidence after release | No destructive or broad campaign cases; use approved internal numbers and the checklist's Part C scope |

Never run `yarn test` against a populated QA workspace without the documented destructive-test
authorization. The integration global setup uninstalls the app and can delete owned records.

### 4.2 Browsers and layouts

Run P0/P1 in the latest stable versions of Chrome, Safari and Firefox on macOS. Also run P0 in the
previous stable Chrome. If the supported production estate includes Edge, run P0/P1 there.

| Shape | Target | Required coverage |
|---|---:|---|
| Wide desktop | 1440 × 900 | All cases; inbox two-pane; campaign table |
| Compact desktop | 1024 × 768 | All P0/P1; wrapping and settings forms |
| Narrow container | 390 × 844 equivalent widget width | Inbox list/detail transition, campaign cards, chat composer/panels, no horizontal page scroll |
| Zoom | 200% at 1280 × 800 | P0/P1 keyboard path and no loss of controls/content |

Twenty front components run in a Remote DOM sandbox, not a normal page DOM. During every layout
pass specifically watch for silent failures around measurement, scrolling, focus, media capture,
clipboard, and side panels. Do not waive a failure merely because the same React code works in a
standalone browser page.

### 4.3 Personas and permissions

| Persona | Setup | Expected UI authority |
|---|---|---|
| Workspace admin / WhatsApp Admin | Workspace admin or app Admin role | All settings, template publish/sync, campaign create/control/archive/delete, all agent chat actions |
| WhatsApp Agent | Agent role only | Inbox/chat and thread actions; campaigns read-only; settings readable with admin actions disabled/refused |
| Ordinary member | Neither WhatsApp role | No unauthorized reads/writes; direct routes refuse |
| Restricted agent | Agent on account with restricted visibility | Assigned and unassigned threads only; never another agent's assigned thread |
| Second agent | Separate login/browser profile | Assignment, unread, toast and concurrency checks |

Hidden/disabled controls are usability expectations. Authorization is accepted only when the
server also refuses a hand-crafted or replayed browser request for an unauthorized persona.

### 4.4 Core data pack

Prepare and reset the following named fixtures before a full run:

- Accounts: connected GREEN; connected YELLOW; RED; ERROR/disconnected; Meta test number; two
  independent connected accounts.
- Templates: approved+published (no variables); approved+published with body variables and
  fallbacks; media header; URL button; copy-code button; approved+unpublished; rejected; paused;
  unsupported component; authentication category.
- People: valid `+244`; national-format phone; BR/AR/MX variant; no phone; invalid phone;
  `UNKNOWN`, `OPTED_IN`, and `OPTED_OUT`; duplicate phone matches; existing and no existing thread.
- Threads: mine, another agent's, unassigned, campaign reply, closing in <2 h, closed, blocked,
  needs review, unread, >50 messages and messages on at least three dates.
- Messages: each supported inbound/outbound type, queued/accepted/sent/delivered/read/played,
  retryable failure, terminal/unknown failure, quoted message missing/present, reactions by self
  and others, deferred/unavailable media, unsupported payload.
- Campaigns: empty workspace; draft at each builder step; snapshotting; ready with eligible and
  excluded recipients; scheduled; running; paused; tier-waiting; completed; cancelled; failed;
  archived; never-launched deletable draft; already-launched non-deletable record.
- Files: valid/oversize image, video, audio, voice note, PDF, unsafe/unsupported type, expired or
  unreadable Twenty file URL.

Use internal numbers whose owners have explicitly agreed to receive QA messages. Label every
campaign `QA <date> <operator> <purpose>` and record cost before launch.

## 5. Execution order and gates

1. Baseline automated gate: `yarn lint`, `yarn typecheck`, `yarn test:unit`, then the safe
   integration suite in a scratch workspace.
2. Install/upgrade and navigation smoke: `APP`, `NAV`, `ROLE` P0 cases.
3. Settings, account health and templates: `SET` and `TPL`.
4. Inbound and one-to-one messaging on a real handset: `INB`, `CHAT`, `SEND`, `MEDIA`,
   `CONSENT`.
5. Campaign creation and lifecycle: `CAM`.
6. Workflows/timeline/notifications: `WF`.
7. Responsive, theme, localisation, accessibility, resilience and cross-browser: `UX`, `RES`.
8. Run [`../16-release-checklist.md`](../16-release-checklist.md), reconcile all evidence, and
   sign off.

Stop the run immediately for S1, accidental external send, unexplained duplicate, consent bypass,
wrong recipient, leaked secret, or data loss. Pause the sending number/campaign if needed, preserve
evidence, and notify the release owner.

## 6. Browser test suites

Each table row is an independently recordable case. Unless stated otherwise, run with a connected
GREEN account, English locale, wide Chrome and WhatsApp Admin.

### 6.1 Application installation, upgrade and identity

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| APP-01 | P0 | Install the app from a clean workspace, refresh and sign in again | WhatsApp appears under Applications; no broken install screen; app logo/name/description are correct |
| APP-02 | P0 | Inspect the left sidebar after install | Exactly one WhatsApp inbox and one WhatsApp Campaigns item appear, ordered together; both open their page layouts |
| APP-03 | P1 | Inspect Settings and app About/readme content | Custom settings renders below Twenty's system-managed sections; all document/repository links resolve to valid pages |
| APP-04 | P0 | Upgrade over a workspace containing threads/messages/campaigns | UI loads with the same records and links; no duplicate nav items, tabs, roles or widgets |
| APP-05 | P1 | Uninstall/reinstall in the scratch workspace following the runbook | Routing and UI entities restore once; observed data behavior matches the documented uninstall policy |
| APP-06 | P1 | Hard refresh each app surface and use browser Back/Forward | Current screen remains reachable and does not become a blank widget or wrong record |
| APP-07 | P1 | Open DevTools on first load and after navigation | No asset 404, CSP/module error, uncaught error, infinite request loop or secret appears |

### 6.2 Navigation and host integration

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| NAV-01 | P0 | Open sidebar WhatsApp | Inbox widget fills the intended page; no empty "Notifications" card, nested scroll trap or clipped composer |
| NAV-02 | P0 | Open sidebar WhatsApp Campaigns | Campaign list loads and remains reachable after refresh |
| NAV-03 | P0 | Open a Person and choose the WhatsApp tab | Correct Person's thread or the purposeful no-thread state appears; switching People never leaks the previous person's chat |
| NAV-04 | P0 | Select exactly one Person and run “Open WhatsApp chat” | Side panel opens the selected Person's chat and closes cleanly |
| NAV-05 | P0 | Select zero, two, and many People | The WhatsApp command is unavailable; no arbitrary record opens |
| NAV-06 | P1 | Use Person tab, side panel and inbox for the same thread | History, status, assignee, policy and actions remain consistent after each surface refreshes |
| NAV-07 | P2 | Navigate with keyboard only through sidebar, tabs, command menu and side panel | Focus order is logical and visible; Escape/close returns focus appropriately |

### 6.3 Settings — connection and callback

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| SET-01 | P0 | Open Settings as Admin with no account | Connection, Health, Templates, Variables and Diagnostics tabs render; connect form and callback card have useful empty states |
| SET-02 | P0 | Submit valid name, WABA id, `phone_number_id`, calling code and test flag | Account is created once; tested Meta display name/number, status, quality and tier appear |
| SET-03 | P1 | Try blank IDs, whitespace, malformed values and a Meta-inaccessible number | Connect is disabled or rejected with one actionable error; no partial/duplicate account appears |
| SET-04 | P0 | Click Test connection for connected, expired-token and wrong-number cases | Success is shown only for success; failures stay visible and health/account state updates |
| SET-05 | P1 | Copy phone/WABA ids, callback/direct/verify URLs and required fields | Clipboard content exactly matches visible values; repeated copy is harmless |
| SET-06 | P0 | Inspect verify-token state with variable set and unset | Only configured/missing state is shown; the secret value is never visible in DOM, UI, requests or console |
| SET-07 | P0 | Use the callback data to verify Meta and send a webhook | Verification succeeds and last-webhook state updates |
| SET-08 | P1 | Verify test-number flag on connection and inbox | Both identify the account as test; the warning explains registered-recipient limitation |
| SET-09 | P0 | Click Disconnect, cancel, then confirm | First click only arms the inline danger confirmation; cancel changes nothing; confirm stops sending/receiving and updates policy UI |
| SET-10 | P0 | Reconnect after disconnect | Account returns connected without duplicate account, thread or template rows |
| SET-11 | P1 | Configure two accounts and switch data by associated Person/thread/campaign | Displayed identity, templates, policy and messages always use the correct account |
| SET-12 | P1 | Use localhost and a staging public tunnel | UI distinguishes/contains an actually reachable public callback; an internal-only URL is not presented as ready for Meta |
| SET-13 | P1 | Configure auto-create contacts, send throttle, round-robin group/strategy and shared/restricted visibility through the supported admin UI | Each per-account setting is discoverable, validates, persists and changes subsequent inbound/assignment/visibility/pacing behavior; no raw record editing is required |

### 6.4 Settings — health, variables, templates and diagnostics

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| SET-20 | P0 | Open Health with all checks healthy | Token, webhook, quality, daily tier, failed deliveries, stuck outbound and failed outbound each show OK plus human-readable detail |
| SET-21 | P1 | Exercise every unhealthy health row | Red state includes a specific remedy and correct account context; Refresh reflects repaired state |
| SET-22 | P1 | Display zero and non-zero diagnostic counts | Zero renders as `None`/`0`, never raw JSON; counts agree with the listed records |
| SET-23 | P0 | Select one failed event and replay it twice | Confirmation names the count; first replay recovers it, second is idempotent and creates no duplicate message |
| SET-24 | P1 | Replay selected, replay all, cancel confirmation and exceed request cap | Only confirmed rows replay; truncation/remaining work is clear; buttons show busy state and cannot double-submit |
| SET-25 | P1 | Inspect failed outbound and stuck-message lists | Person/thread, safe error, age/attempts and actionable context are readable; no token/raw sensitive payload appears |
| TPL-01 | P0 | Sync templates | A success notice appears only after accepted request; refreshed list matches Meta without duplicate rows |
| TPL-02 | P0 | Publish and unpublish an approved template | State changes visibly and chat/campaign pickers update; agent/ordinary member cannot mutate it |
| TPL-03 | P1 | Inspect rejected, paused, unsupported and quality-warning templates | Status/reason is readable; unsupported/unavailable templates cannot be published or sent |
| TPL-04 | P1 | Submit a new template from the CRM with valid/invalid name, language, category, components, placeholders and examples | Form validation is specific; one valid request reaches Meta; pending/rejected/approved state becomes visible after sync; rapid/repeated submit cannot duplicate it |
| TPL-05 | P1 | Receive template status, quality and category updates while Settings is open | Existing row updates without duplication; availability in pickers and any warning/refusal follows the new state |
| SET-29 | P1 | Edit one variable of each type: text, number, boolean, select, array | Dirty marker and unsaved bar name/count changes; Save persists correct type; Cancel restores server values |
| SET-30 | P1 | Edit several variable groups together, trigger one validation/server error | No silent partial success; saved vs unsaved keys are explicit and values survive reload correctly |
| SET-31 | P0 | Change locale, service-window and consent confirmation variables | User-facing behavior changes without deploy and uses the saved values |
| SET-32 | P1 | Create the notification workflow twice | First creates one named draft plus a review checklist; second reports the existing draft and does not duplicate it |

### 6.5 Inbox list and live updates

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| INB-01 | P0 | Open Mine, Unassigned, All, Campaign replies, Closing soon and Closed | Correct rows and counts appear for each server filter; selected filter is visually and semantically clear |
| INB-02 | P1 | Expand/collapse secondary filters | Control label/state changes; selection and list do not reset unexpectedly |
| INB-03 | P1 | Search name, phone and preview with case/accent variations; clear search | Only loaded matching rows show; scope note names loaded count; clear restores filter results |
| INB-04 | P2 | Exercise every filter's empty state and its action | Copy describes that filter and actions go to All/Unassigned as promised; no dead end |
| INB-05 | P0 | Receive a message into an empty workspace | Conversation appears within the polling SLA, with correct Person/profile, preview, timestamp, unread and open state |
| INB-06 | P0 | Open an unread conversation | Unread is cleared in list and server state without depending on WhatsApp read-receipt settings; it stays clear after refresh |
| INB-07 | P1 | Receive messages in two assigned threads while inbox is open | Each thread updates once; toast(s) identify sender/count and never duplicate the same inbound message |
| INB-08 | P1 | Page beyond 50 conversations | Load-more appends without duplicates, resorting errors or lost selection |
| INB-09 | P1 | Use J/K to move and A to assign | Keyboard hint is accurate; keys do nothing while typing; action updates counts and selected thread |
| INB-10 | P0 | Close the selected thread, then receive a new inbound | It leaves open filters, appears under Closed, then automatically reopens on inbound |
| INB-11 | P1 | Resize wide → narrow → wide with a selected thread | Two-pane becomes list/detail with a working Back-to-conversations action; selected thread and draft are not leaked/lost unexpectedly |
| INB-12 | P1 | Collapse/show the list on wide layout | Chat gains space, control remains reachable, and no horizontal/nested-scroll trap appears |
| INB-13 | P0 | Sign in as restricted agent and second agent | Restricted results omit another agent's assigned thread entirely; unassigned and own threads remain accessible |

### 6.6 Conversation shells, header and lifecycle actions

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| CHAT-01 | P0 | Load thread in inbox, Person tab and side panel | Same correct Person, phone, account, window, status, assignee and history appear |
| CHAT-02 | P1 | Open Person with no thread but valid phone | Purposeful start state explains templates and offers Start with template |
| CHAT-03 | P1 | Open Person with no phone, invalid phone, opted-out state or no connected account | Specific diagnosis and remedy appear; no misleading Start action |
| CHAT-04 | P1 | Load >50 messages across days, request earlier pages and reach oldest | Newest starts visible; explicit load works; no duplicates; date separators and scroll position remain usable |
| CHAT-05 | P0 | Assign to me, unassign and switch agents | Header, Mine/Unassigned counts and audit/timeline update; failures restore prior state and show an error |
| CHAT-06 | P0 | Close/reopen | Status and filters update once; new inbound reopens closed thread |
| CHAT-07 | P0 | Block/unblock | Block immediately disables all sends/reactions with a clear state; unblock restores only actions allowed by policy |
| CHAT-08 | P1 | Open needs-review/ambiguous contact, relink to correct Person | History follows the thread, old/new Person surfaces update, and no message/thread is duplicated |
| CHAT-09 | P1 | Change window from open → expiring → closed → reopened by inbound | Countdown/warning, composer mode and header update at boundaries without refresh |

### 6.7 Message rendering, details and actions

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| MSG-01 | P0 | Render inbound/outbound text with URLs, long words, emoji, accents and line breaks | Direction/alignment, wrapping and link behavior are correct; content is not executed as HTML |
| MSG-02 | P0 | Observe queued, accepted/sent, delivered, read, played and failed | Icons/ticks, color, labels and details advance monotonically without duplicate bubbles |
| MSG-03 | P1 | Open/close details for every message family | Type and relevant timestamps/template/media/ interactive/contact/reaction fields are translated and readable |
| MSG-04 | P0 | Quote-reply inbound and outbound messages, then cancel a draft reply | Correct parent preview/sender appears; cancel clears context; sent bubble retains quote |
| MSG-05 | P1 | Render quote whose original is unavailable or non-text | Safe fallback names the type; no broken/blank strip |
| MSG-06 | P0 | React with quick emoji, full picker, replace and remove own reaction | Reaction attaches to target (not a new bubble), counts aggregate, self state toggles and policy-disabled actions stay disabled |
| MSG-07 | P1 | Copy message text via message action | Exact text reaches clipboard; success/failure feedback is visible; non-copyable types do not offer it |
| MSG-08 | P1 | Render image, sticker, video, audio, voice note and document | Correct native/card renderer, caption/name/size and open/download controls work; media fits container |
| MSG-09 | P1 | Render deferred, pending, expired and unavailable media | Download-on-demand has size and busy state; final media or actionable safe error replaces it |
| MSG-10 | P1 | Render location and contacts (linked, unlinked and ambiguous) | Map opens correct coordinates; existing Person opens; Create Person warns about third-party data and creates once |
| MSG-11 | P1 | Render quick-reply/list sent message and inbound selections | Header/body/footer/options and selected id/title are clear; expanding/collapsing options works |
| MSG-12 | P1 | Render template, campaign and system messages | Template name/content, campaign chip and system copy are correct; no raw internal payload by default |
| MSG-13 | P0 | Render an unknown message type | Unsupported placeholder appears and details can expose a safe representation; message is not dropped and UI does not crash |
| MSG-14 | P0 | Show retryable and non-retryable failures | Mapped user error is visible; Retry exists only when safe and creates one new attempt, not a duplicate accepted send |

### 6.8 Composer and one-to-one sends

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| SEND-01 | P0 | Type text, press Enter, then use button; use Shift+Enter | Enter/button send once; Shift+Enter inserts newline; optimistic bubble reconciles with one server row |
| SEND-02 | P1 | Send whitespace, rapid double-submit, long text and navigate during send | Invalid input does not send; busy state prevents duplicates; limits/errors are clear; final state recovers |
| SEND-03 | P1 | Insert several emoji into existing text | Emoji appears at usable insertion point and draft remains editable; picker is keyboard reachable and closable |
| SEND-04 | P0 | With open window and all policy prerequisites, inspect composer | Free-form, attachment and template controls reflect the server-provided capabilities |
| SEND-05 | P0 | Expire the window | Text and non-template interactive sends disable; Choose template remains and explanation names the 24-hour rule |
| SEND-06 | P0 | Opt out, block thread, disconnect account and set RED quality separately | Each denial shows the correct highest-precedence reason and no forbidden provider send occurs |
| SEND-07 | P1 | Transition policy while a draft/panel is open | Submit is rechecked server-side; a 409 becomes an inline refusal and no false-success toast/bubble remains |
| SEND-08 | P0 | Pick approved/published templates with no/body/media/button variables | Only sendable templates appear; required values, examples/fallbacks, live preview and missing count are correct |
| SEND-09 | P0 | Send a template outside the window and use it to start a new thread | It sends once in the correct Person/account thread; no duplicate conversation is created |
| SEND-10 | P1 | Attempt unavailable/unpublished template and a template that changes during picker use | UI prevents or server refuses it with actionable copy; optimistic row resolves safely |

### 6.9 Attachment, voice, location, contact and interactive composers

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| MEDIA-01 | P0 | Attach valid image/video/audio/document from the supported Twenty file flow | URL/file is accepted, preview/metadata are correct, upload/send progresses, handset receives correct media |
| MEDIA-02 | P0 | Try the URL copied from Twenty's standard Person Files UI | Either it is accepted or the UI provides a working picker/conversion path; instructions must not lead to a dead end |
| MEDIA-03 | P1 | Try external URL, malformed URL, missing file, oversize and wrong media kind | Validation occurs before send where possible; field-specific message and Meta limits are accurate |
| MEDIA-04 | P1 | Add caption/filename, cancel panel, collapse/expand panel and retry a failed upload | Data is preserved only when expected; transcript and handset show caption/filename; no orphan bubble |
| MEDIA-05 | P1 | Record voice with permission granted, listen, discard and record/send again | Timer, stop/review/playback/upload/send states work; recording releases microphone when closed |
| MEDIA-06 | P1 | Deny microphone, use unsupported browser, and lose permission mid-flow | Actionable permission/unavailable state appears; composer remains usable and no endless recording indicator |
| MEDIA-07 | P1 | Send valid location with/without optional name/address; test coordinate bounds | Preview and received map data match; invalid/missing coordinates cannot send |
| MEDIA-08 | P1 | Send current Person and manually entered contact | Required name validation, phone and organisation are correct; handset receives intended vCard only once |
| MEDIA-09 | P1 | Build 1–3 quick-reply buttons; edit/reorder/remove and exceed limits | Stable ids, field-level validation, counter and preview match final send |
| MEDIA-10 | P1 | Build multi-section list; add/reorder/remove rows/sections and exceed limits | Limits, descriptions, stable ids, preview and final handset message match |
| MEDIA-11 | P1 | Close/cancel each composer sheet and switch mode | No accidental send; stale mode-specific data/error does not contaminate the next panel |

### 6.10 Consent and user-visible audit behavior

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| CON-01 | P0 | Send configured opt-out keyword with case/accent/whitespace variants | Exact-token match opts out, field/timestamp/event update, and exactly one configured confirmation is sent |
| CON-02 | P0 | Repeat opt-out keyword | State remains opted out and no second confirmation is sent |
| CON-03 | P0 | Attempt free-form, template, workflow and campaign send while opted out | All business-initiated sends are refused, including Admin; reason is readable |
| CON-04 | P0 | Reply to an opted-out person's inbound while service window is open | Customer-service reply follows the specified exception; marketing remains blocked |
| CON-05 | P0 | Send configured opt-in keyword | Status/timestamp/event update, one configured confirmation is sent, and eligible sends become available |
| CON-06 | P1 | Change Person's WhatsApp subscription field manually | Append-only consent event names manual source/actor/date; UI refreshes without rewriting history |
| CON-07 | P1 | Switch confirmation locale and wording variables | Exact new text is sent and evidence records what was sent; no deploy is required |

### 6.11 Campaign list, builder, pre-flight and lifecycle

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| CAM-01 | P0 | Open empty Campaigns as Admin and Agent | Helpful empty state; Admin can create; Agent has no write controls but can read |
| CAM-02 | P1 | Search and use All, Drafts, Scheduled, Running, Completed, Needs attention, Archived | Case-insensitive results match status groups; clear restores all; urgency ordering is stable |
| CAM-03 | P1 | Compare wide table and narrow cards | Name/status/key counters/cost/freshness are readable and each row/card has a clear keyboard-open affordance |
| CAM-04 | P0 | Create Basics with name, account and now/future schedule | Required values validate; browser-local time is saved/displayed consistently with UTC and DST boundaries |
| CAM-05 | P0 | Choose template | Only approved, published marketing/utility templates appear; authentication and unsupported templates do not |
| CAM-06 | P0 | Choose saved-view and manual audiences | Saved view meaning is preserved or refused if unsupported; manual selection is usable without requiring raw UUID knowledge |
| CAM-07 | P1 | Navigate back/cancel/resume a draft at each step and reload | Autosaved values and current step restore; cancel does not create duplicate same-name drafts |
| CAM-08 | P0 | Bind each variable to Person field or fixed text with/without fallback | First five real-recipient previews are correct; missing values are named and exclusion behavior is clear |
| CAM-09 | P0 | Build audience containing opted-out, unknown-marketing, invalid, duplicate, missing, blocked and eligible People | Counts, precedence, exclusion breakdown and samples are exact; no override for marketing consent |
| CAM-10 | P0 | Inspect pre-flight | Eligible/excluded, estimate and per-message rate, tier reserve/ available/spread, quality/template and rendered preview agree with fixtures; sub-cent values do not round misleadingly to `$0.00` |
| CAM-11 | P0 | Pre-flight with zero eligible, disconnected, YELLOW and RED account | Zero recipients cannot launch; disconnected blocks; YELLOW warns; RED requires explicit acknowledgement and Launch anyway |
| CAM-12 | P1 | Use Test send | Only listed internal test recipient(s) receive one message; audience counters/state are unchanged and failures are shown |
| CAM-13 | P0 | Launch immediate and scheduled campaign, including rapid double-click | One confirmed launch occurs; scheduled waits; active campaign visibly progresses without duplicate recipients |
| CAM-14 | P0 | Observe snapshotting/running/tier-waiting/final reconciliation | Status, progress and freshness explain work; tier waiting is normal; final state appears promptly or explicitly says Finishing rather than looking stuck |
| CAM-15 | P0 | Pause, resume and cancel with confirmation | Valid controls only; pause stops new claims, resume continues once, cancel skips unsent and keeps tracking sent recipients |
| CAM-16 | P1 | Trigger failure-rate and quality guardrails | Campaign auto-pauses with reason; UI does not imply completion and Admin can make an informed resume decision |
| CAM-17 | P0 | Compare counters/funnel/cost with recipient sample and handsets | Recipient, queued, sent, delivered, read, replied, failed, skipped, excluded and actual cost reconcile |
| CAM-18 | P0 | Reply to a campaign from handset | Existing thread receives reply, Campaign replies filter includes it and recipient/responded aggregates update once |
| CAM-19 | P1 | Archive terminal campaign, inspect archive, unarchive | It leaves/returns to live list, archived date/banner are clear, statuses/replies continue updating, empty archive has a way back |
| CAM-20 | P0 | Delete never-launched draft; inspect launched campaign | Draft warns and deletes once; launched campaign has no delete action and its audit record remains |
| CAM-21 | P1 | Leave a campaign page open during polling, background/foreground tab and recover network | Running refresh interval and blurred behavior are credible; edits/selections are not overwritten; stale banner clears on recovery |

### 6.12 Workflows, notifications and timeline

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| WF-01 | P0 | In workflow builder, add Send WhatsApp template | Step has WhatsApp identity/icon, exposes documented parameters and can be saved/reopened |
| WF-02 | P0 | Run workflow send with valid/invalid variables and opted-out Person | Valid send appears once in thread with workflow/AI attribution as designed; invalid/opted-out run fails safely |
| WF-03 | P1 | Complete generated notification workflow checklist and activate | Inbound-only message creates one Task for chosen/derived assignee; outbound does not self-notify |
| WF-04 | P1 | Receive inbound assigned message while Twenty is focused and while another app page is open | Unread increments and one live toast appears with useful sender context |
| WF-05 | P1 | Test closed browser/tab behavior with active workflow | Workflow notification reaches the configured recipient; do not expect the headless live toast to work with a closed tab |
| WF-06 | P1 | Exercise timeline mode All, Summary and Off | Person and Company timeline entries match the selected volume policy, link to correct entities and never expose secret/raw webhook data |
| WF-07 | P1 | Send, assign, fail, consent-change and campaign events | Required actor/date/type appear once and ordering is chronological |

### 6.13 Roles, privacy and security from the browser

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| ROLE-01 | P0 | Run inbox/chat/thread actions as Agent | Allowed work succeeds; no settings/template/ campaign mutation is granted |
| ROLE-02 | P0 | Open Campaigns as Agent | Data is readable as specified; New/Edit/Launch/Pause/ Cancel/Archive/Delete controls are absent and direct requests return 403 |
| ROLE-03 | P0 | Open Settings as Agent | One clear role banner appears; values may be read, every mutating action is disabled, and direct requests return 403 |
| ROLE-04 | P0 | Repeat protected actions as ordinary member and signed-out user | No protected data leaks; response is 403/401 respectively; UI never claims success |
| ROLE-05 | P0 | Inspect network/console/DOM/storage/screenshots while using settings and chat | Meta app secret, access token and verify token never appear; errors redact credentials/payloads as required |
| ROLE-06 | P0 | Restricted visibility: deep-link/search/previously open another agent's thread | Thread is absent/refused server-side and stale UI content is cleared |
| ROLE-07 | P1 | Try HTML/script/link payloads in messages, names, templates and campaign fields | Text is escaped, links are safe, and no script/event executes |
| ROLE-08 | P1 | Use browser Back/resubmit and rapid clicks on destructive/write controls | Confirmation, busy state and idempotency prevent duplicate/destructive repeats |

### 6.14 Resilience and state recovery

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| RES-01 | P0 | Go offline with inbox/thread open, then recover | Existing content remains, stale/offline state is explicit, Resume/automatic refresh recovers without duplicates |
| RES-02 | P1 | Return 401 once and allow token refresh | User action transparently retries once and finishes; no infinite auth loop or duplicate write |
| RES-03 | P1 | Inject 403, 409, 429, 500, timeout and malformed response into each major surface | Correct inline/banner state appears, user input is preserved where safe and retry is controlled |
| RES-04 | P1 | Background tab beyond blurred interval, foreground and change system clock/timezone | Polling resumes, relative time/countdown corrects, no request storm |
| RES-05 | P1 | Have two agents mutate assignment/close/message state concurrently | Server result wins, both UIs converge, and no action silently overwrites unrelated state |
| RES-06 | P1 | Hard refresh during optimistic send, campaign build and diagnostic replay | Final server state is recoverable and shown exactly once; no permanently phantom UI row |
| RES-07 | P2 | Let long list/detail pages remain open for 30 minutes | No unbounded DOM/request growth, progressive slowdown, duplicated toast or timer leak |

### 6.15 Accessibility, localisation, theme and usability

| ID | Pri | Scenario and action | Expected result |
|---|---:|---|---|
| UX-01 | P0 | Run critical journeys using keyboard only | All interactive controls are reachable and operable; focus visible; no keyboard trap; J/K/A shortcuts do not steal text entry |
| UX-02 | P1 | Inspect names/roles/states with accessibility tree | Inputs have labels, icon buttons have accessible names, toggles expose state, errors associate with fields, status is not color-only |
| UX-03 | P1 | Run screen-reader smoke for inbox selection, new message, composer error and campaign progress | Reading order is meaningful; changes/errors are announced without repeated noise |
| UX-04 | P1 | Test 200% zoom and narrow container on every surface | No lost action, clipped text, overlapping controls or page-level horizontal scroll; fixed widget uses available height |
| UX-05 | P1 | Switch live between light and dark theme | Text/icons/status/error contrast remains readable and all surfaces update without reload |
| UX-06 | P0 | Run P0/P1 once with `pt-*` and once with English/non-pt locale | All WhatsApp copy uses the chosen language; no copy key/raw enum appears; interpolation/plurals make sense |
| UX-07 | P1 | Inspect mixed Twenty host + app screens in both locales | Locale is coherent enough to complete the journey; document any host/app mismatch rather than silently accepting it |
| UX-08 | P1 | Use long Portuguese/English names, numbers, templates and errors | Wrapping/truncation keeps identity distinguishable and full critical error/action text available |
| UX-09 | P2 | Test reduced motion/high contrast where supported | Essential state is not encoded only in animation or subtle color |
| UX-10 | P1 | Run Chrome/Safari/Firefox media, clipboard, scroll and side-panel smoke | Remote DOM/browser differences do not break supported paths; browser-specific fallback is actionable |

## 7. Targeted regressions from the latest exploratory run

These cases must be called out in every release report until they have passed in two consecutive
releases. A known failure is not a waiver.

| Risk | Primary cases | Acceptance |
|---|---|---|
| Standard Twenty file URLs cannot be submitted | MEDIA-01–04 | At least one discoverable, end-to-end supported attachment path works for all four media families |
| Unread remains after opening | INB-06 | Opening/marking read clears the CRM unread state |
| Manual campaign audience requires raw Person UUIDs | CAM-06 | User can find/select People by human identity, or the limitation is explicitly accepted before release |
| Delivered campaign looks Running while reconciling | CAM-14 | Prompt terminal transition or an explicit finishing state |
| Sub-cent estimate displays `$0.00` | CAM-10/17 | Enough precision to avoid a false zero |
| Zero failed-send health row renders raw JSON | SET-22 | Human `None`/`0` copy |
| Local callback looks externally usable | SET-12 | Public-vs-local guidance is unambiguous |
| Host and app locale diverge | UX-06/07 | Release report identifies source and user impact |
| Relative About-page links become invalid hosts | APP-03 | Every rendered link resolves |

## 8. Evidence and defect protocol

Create one run record named `reports/whatsapp-browser-qa-YYYY-MM-DD.md`. It must contain:

1. Version/environment/persona/browser matrix.
2. Summary counts by Pass/Fail/Blocked/NA and priority.
3. One line per failed or blocked case with defect id and evidence link.
4. Actual Meta recipients and campaign spend, with phone numbers redacted.
5. Console/network summary and whether any secret scan finding occurred.
6. QA data created, changed, archived or intentionally left behind.
7. Sign-off from QA, engineering and the owner of the sending number.

A defect report includes the case id, smallest reproducible steps, expected/actual, role/locale/
viewport, account/thread/campaign id suffixes, timestamps with timezone, screenshot/video, console
error and redacted request correlation id. Never attach access tokens, verify tokens, App Secret,
full customer numbers or unredacted webhook bodies.

## 9. Exit checklist

- [ ] Baseline automation is green on the release commit.
- [ ] All applicable P0/P1 browser cases pass in the required matrix.
- [ ] Real handset proves inbound, free-form, template, reply, reaction, media and campaign flows.
- [ ] Consent, window, blocked, disconnected and role denials each produced zero forbidden sends.
- [ ] Campaign eligible/excluded counts, funnel, replies and cost reconcile to recipient evidence.
- [ ] Portuguese and English, light/dark, keyboard, 200% zoom and narrow layout pass.
- [ ] Chrome, Safari and Firefox have no release-blocking Remote DOM/browser-specific defect.
- [ ] No uncaught console error, request loop, secret leak, duplicate send or unexplained data loss.
- [ ] Targeted regressions in section 7 have an explicit result and owner.
- [ ] Release checklist A–C is signed; production smoke scope and rollback owner are named.


## Native upload acceptance (D-70)

- In sandboxed Chromium, choose JPEG/PNG, MP4, audio and PDF device files; verify preview/filename, caption where applicable, upload success and enabled Send.
- Replace/remove/reselect the same file, cancel the chooser, dismiss during upload, switch templates, and double-click Send. No stale completion or duplicate send may occur.
- Empty, oversized and incompatible template-header files fail before upload. Failed uploads preserve captions and can retry.
- Reload queued messages and saved campaign drafts; verify FILES associations, recent-file reuse and scheduled delivery without depending on preview URL expiry.
- Repeat under WhatsApp Agent permissions, in Portuguese and English, and in narrow widgets. No S3 settings, workspace search, URL inputs or manual type selection remain.
- Confirm actual Meta delivery only with an explicitly authorized test recipient and configured test credentials, before release.
