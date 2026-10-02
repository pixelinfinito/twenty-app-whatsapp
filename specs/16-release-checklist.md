# 16 — Release checklist

The two phase-10 items that cannot be automated: the end-to-end run on a real number (10.9,
specs/12 §6) and the runbook rehearsal (10.11, specs/11 §5.1). Both need a person, a handset and a
WhatsApp Business Account, so what engineering can deliver is the script — precise enough that
two different operators produce the same evidence, and signed, because "we tested it" is not an
answer three months later.

Everything else in phase 10 is a test that runs in CI. This document exists for the part that
never will.

---

## How to use this

Run it on **staging**, against the staging number, in one sitting. Then run part C only on
production, the day of the release.

Each row is pass or fail. A partial pass is a fail; write what happened in the notes column and
stop. The point of a checklist is that it is not negotiable in the moment.

Record the versions before you start — the answers only mean something attached to them:

| | |
|---|---|
| App version | `package.json` `version` |
| Twenty version | `.twenty-version` (and confirm the running server matches) |
| Graph API version | `META_GRAPH_VERSION` application variable |
| WABA / phone number id | from the settings **Connection** tab |
| Date, operator | |

---

## Part 0 — Cut the release (engineering)

The version anyone can install must be the version anyone can read. 0.1.2 was published to npm
from a commit that is not on any branch, with no tag, and its full source is not recoverable —
the tarball ships only the logic-function entries, with everything else bundled. Nothing below
can bring that source back; what follows exists so it cannot happen again.

| # | Step | Expected | Pass |
|---|---|---|---|
| P1 | Bump `package.json` `version` in the release commit; update CHANGELOG's Unreleased into a dated section | `git log -1` shows the bump; CHANGELOG matches | ☐ |
| P2 | Tag **that** commit: `git tag vX.Y.Z && git push origin vX.Y.Z` | The Publish workflow runs | ☐ |
| P3 | The workflow's tag guard passes | Tag `vX.Y.Z` equals `package.json` `version`; a mismatch fails the job before publishing | ☐ |
| P4 | `npm view <pkg>@X.Y.Z dist.tarball` after publish | The published tarball's `repository`/provenance points at this repo at this tag | ☐ |

If the guard fails, do not retag on a different commit: fix `package.json`, and tag the commit
that carries the fix.

---

## Part A — Install from nothing (10.11, runbook rehearsal)

A rehearsal means a **fresh workspace**, not the one already working. Half the value is finding
the step that only worked because someone had done it by hand a month ago.

Follow specs/11 §5.1 verbatim. Do not improvise, and note every place the runbook was wrong or
incomplete — those notes are the deliverable, more than the ticks.

| # | Step | Expected | Pass |
|---|---|---|---|
| A1 | Deploy and install the app | It appears under Settings → Applications | ☐ |
| A2 | Read the post-install function log | It prints the callback URL, the direct URL, the required field list, and `rolesMissing: []` | ☐ |
| A3 | Set the four server variables | Settings → Connection shows `verifyTokenConfigured: true` | ☐ |
| A4 | `curl "https://<host>/webhooks/server/bb76f114-7843-4a09-af64-9ceca78479cd?hub.mode=subscribe&hub.challenge=probe&hub.verify_token=<token>"` | Returns `probe` (not HTML, not 404) | ☐ |
| A5 | Enter WABA id + `phone_number_id`, **Test connection** | Green; the account row shows the verified name | ☐ |
| A6 | Paste the direct callback URL and verify token into Meta, **Verify and save** | Meta reports the callback verified | ☐ |
| A7 | Subscribe the webhook fields (all seven) | All seven ticked in the dashboard | ☐ |
| A8 | **Verify the WABA subscription** with the `curl` in §5.1 step 10 | The app is listed. `{"data":[]}` is a **fail** — this is the failure that looks like success | ☐ |
| A9 | Message the number from a handset | The conversation appears in the Inbox within 5 s | ☐ |
| A10 | Assign yourself the WhatsApp Agent role only (not admin) and reload | The Inbox works; the Settings tab refuses the admin actions | ☐ |

**Notes / runbook corrections:**

---

## Part B — The scripted loop (10.9, specs/12 §6)

Run every step in order from one handset that is **not** a company device — an allowlisted test
number behaves differently from a real one in ways that matter (contact cards, forwarded media,
a customer who has us blocked).

| # | Step | Expected | Pass |
|---|---|---|---|
| B1 | Message the business number from the handset | Appears in the CRM ≤ 5 s | ☐ |
| B2 | Check the Person record | Auto-created with the correct `+244` number, `whatsappOptInStatus: UNKNOWN` — **not** opted in | ☐ |
| B3 | Reply free-form from the Person tab | Ticks progress sent → delivered → read | ☐ |
| B4 | Send an image from the CRM; send one from the handset | Both render, both directions | ☐ |
| B5 | Quote-reply in both directions | The quoted bubble shows the right parent, both directions | ☐ |
| B6 | Set `WA_SERVICE_WINDOW_HOURS` to a small value; wait for expiry | The composer switches to template-only, with the reason on screen | ☐ |
| B7 | Send a template from that same thread | **No second conversation is created** — the Chatwoot #14086 regression check. One thread, the template inside it | ☐ |
| B8 | Send `PARAR` from the handset | The contact becomes `opted_out`; **exactly one** confirmation arrives | ☐ |
| B9 | Send `PARAR` again | **No** second confirmation (FR-CON-3) | ☐ |
| B10 | Try a template send to that contact | Refused, with a reason a rep can read | ☐ |
| B11 | Send `INICIAR`, then retry B10 | Opted back in; the send is allowed | ☐ |
| B12 | Launch a 3-recipient campaign to internal numbers | All delivered; stats correct; one reply marks the recipient `responded` | ☐ |
| B13 | Restore `WA_SERVICE_WINDOW_HOURS` to 24 | The composer returns to free-form inside the window | ☐ |

**B12 is the only step that spends money and the only one that messages someone else.** Use
numbers whose owners are in the room.

### B-tail — what the automated suites could not prove

These close the gaps named in specs/15 (phase 8) and specs/12 §5. Each needs one real send.

| # | Step | Expected | Pass |
|---|---|---|---|
| B14 | After B12, check the account's tier ledger | `tierUniqueUsersUsed` increased by the number of distinct recipients | ☐ |
| B15 | Check the campaign's `pacingObserved` | Present, and within tolerance of the campaign lane rate | ☐ |
| B16 | Check the campaign's delivered/read funnel | Matches what the handsets actually show | ☐ |
| B17 | Send a template to a number that will reject it (e.g. an unregistered number) | The recipient row is `failed` with a mapped error code, and the campaign's `failedCount` moves | ☐ |

---

## Part C — Operations, exercised (10.11)

Run once on staging, and repeat C1–C3 on production before the release is called done. These are
the procedures that only get used during an incident, which is the worst moment to discover one of
them does not work.

| # | Procedure | Expected | Pass |
|---|---|---|---|
| C1 | **Token rotation** (§5.2): rotate the System User token, update `META_ACCESS_TOKEN` | **Test connection** green with no redeploy; a queued message sends afterwards | ☐ |
| C2 | **Replay** (§6): break a processor deliberately (e.g. rename a required field on staging), send a message, restore, then replay the failed event from Settings → Diagnostics | The message appears; a second replay of the same event changes nothing | ☐ |
| C3 | **Health panel** (§3): revoke the token and wait for the hourly check | The account goes `ERROR`, sends pause, the panel names the reason | ☐ |
| C4 | **Retention** (§4.2): set `WA_RETENTION_WEBHOOK_EVENT_DAYS` to 7 and run the purge | Old raw events go; message rows keep their status, cost and wamid | ☐ |
| C5 | **Erasure** (§4.1): dry-run erasure on a test contact, read the counts, then confirm | The counts match; a tombstone consent event remains; no message content survives | ☐ |
| C6 | **Backup and restore** (§5.4): restore the staging database and media volume from the same window | The app installs, threads and media resolve | ☐ |
| C7 | **Failure triage** (§6): walk the five triage steps against the health panel | Each metric named in the list is readable | ☐ |
| C8 | **Notification workflow**: press "Create the notification workflow", then add the inbound filter and activate it | An inbound message creates a Task for the assignee | ☐ |
| C9 | **Uninstall / reinstall**: uninstall the app on a scratch workspace, then reinstall | The routing claim is released and re-asserted; conversations survive | ☐ |

---

## Part D — Load, on real infrastructure (specs/12 §5)

The design-level load properties are asserted in `src/__tests__/load.test.ts` at the spec's own
numbers, in process. What that cannot measure is the platform underneath — queue latency, Core API
round-trips, ack time under real HTTP. This is that measurement, and it needs staging plus a load
generator; it is the one part of this checklist that is engineering's rather than ops'.

| # | Measurement | Target | Result |
|---|---|---|---|
| D1 | Replay recorded fixtures at 50 deliveries/s for 60 s | Zero lost, zero duplicated, ack p95 < 1 s | |
| D2 | Drive the sender at the account ceiling against a mock provider | No 130429; observed spacing within tolerance of `1000/rate` | |
| D3 | Interactive send latency during a campaign at full campaign-lane rate | p95 ≤ 3 s (NFR-S5) | |
| D4 | 10 000-recipient campaign, mock provider | Zero lost, zero duplicate recipients, counters and tier accounting correct | |
| D5 | 100 000-recipient snapshot | Completes inside the API budget; interactive latency unaffected | |

---

## Sign-off

The release is called when A, B and C are complete with no fails, and D has been run at least
once against a build within one minor version of the one being released.

| | Name | Date | Signature |
|---|---|---|---|
| Operator (A, B, C) | | | |
| Engineering (D, and every correction in A) | | | |
| Accountable for the number (B12's spend) | | | |
