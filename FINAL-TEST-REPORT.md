# Continuum — final manual test report

Latest follow-up, November 7: completed B10–B13 and C/D checklist verification using browser, isolated API, and live integration checks. Fixed preference-question extraction, immediate preference replacement, retired-fact history, stale displayed summaries, customer/specialist closure consistency, and hypothetical booking wording. **67/67 automated tests**, HTTP checks, **14/14 live learning checks**, and **5/5 live preference checks** passed. See [VERIFICATION-2026-11-07.md](VERIFICATION-2026-11-07.md) for the exact coverage, browser/automated distinction, private evidence paths, cleanup and remaining external setup. This supersedes the counts below; older entries are historical.

November 7 follow-up: fixed a user-reproduced wrong-request reply when asking about the battery request from a screen-flicker conversation. Added owned-request selection prompts/buttons, ambiguous/unknown-ID protection and regression coverage. 59/59 automated tests and HTTP checks passed; browser verification confirmed the offered button opens the correct battery record. See TESTING-FINDINGS.md for details. This supersedes earlier test counts for the current code; the previous live semantic challenge was not redundantly rerun for this deterministic request-navigation change.

> Current finding-by-finding status is at the top of TESTING-FINDINGS.md. Original failures and intermediate counts below are historical; the final delivery section records the completed remediation and its verification. External setup and explicitly untested coverage remain separate.

> Subsequent judging preparation added a frozen 30-question challenge and strengthened memory-OFF pass criteria. See output/CHALLENGE-RESULTS.md and JUDGING-PACK.md. The local challenge exposed paraphrase misses despite the earlier fixed regression passing; this limitation is now recorded in TESTING-FINDINGS.md. These new API evaluations are not additional manual browser tests or real customer trials.

Challenge completion: live run bd80dcd8 passed 30 positive questions, 30 OFF checks, 30 negative controls and 10 recovery scenarios. Local run ea7648c4 found 16/30 positives; both reports are preserved. The four tests in test/evaluation.test.js passed after harness changes. JUDGE-DEMO.md and USER-PILOT.md are prepared scripts/protocols; a timed presenter rehearsal, recording and real-participant study have not been completed.

Date: November 6, 2026 (India time)

## Verdict

The tested core support and learning flows work, including separate specialist permissions, customer-confirmed publication, failed-fix recovery, service-scope restrictions, and sampled company isolation. The reported role/navigation, summary/content, invitation and keyboard issues have now been addressed; see the remediation results below. No critical authorization failure was observed in this walkthrough. This is a functional manual test report, not a production security certification or a claim that every possible path passed.

Testing used the visible local browser UI: entered text, clicked buttons, changed selectors, submitted forms, refreshed pages, and checked rendered results. No direct API submissions or database edits were used to simulate browser results. The original manual passes changed no application source. The subsequent remediation pass below implements and tests fixes authorized by the user. Owner and test identities used separate localhost/127.0.0.1 sessions.

## Results

| Area | Final observed result | Status |
|---|---|---|
| Standard request creation | Requests save, have IDs/statuses, and survive reload | Passed |
| Specialist handoff | Requires confirmation; repeated open-case request blocked | Passed |
| Specialist progress | Status, note and troubleshooting reach the customer | Passed |
| Customer rejection | Request reopens; specialist can continue; candidate remains rejected / not published | Passed |
| Revised solution | New candidate can be confirmed, resolved, published and synced; old rejection retained | Passed |
| Hindsight learning | Matching paraphrase returns the reviewed steps with source details | Passed |
| Memory ON/OFF lab | Matching fix returned ON, withheld OFF; no confirmed-action change from comparison | Passed |
| Applicability restrictions | Wrong model and firmware excluded; missing environment asked for confirmation | Passed |
| Unrelated questions | Billing question did not receive battery fix or fabricated invoice data | Passed for sampled queries |
| Success feedback | Double-click It worked counted one success and resolved request | Passed |
| Recurrence | Issue returned reopened the request, created contextual specialist case and paused resolution reuse | Passed |
| Keep review | Requires explanation; keeping removes review pause | Passed |
| Protection after keep | Failed customer's new response did not repeat failed steps; recognized existing case | Passed for tested request |
| Retire review | Earlier user walkthrough retired the original display fix; subsequent response withheld it | Passed earlier user-assisted test |
| Specialist email binding | Wrong email could not accept invitation | Passed |
| Specialist invitation scope | Choosing IT during Standard invitation did not widen scope | Fixed UI; invited signup has no service selector; scope regression passed |
| Separate specialist claim | Test specialist claimed QA case; only itself available in its assignment selector | Passed |
| Owner-only team controls | Specialist direct navigation to /team denied | Passed |
| Service access restriction | Standard specialist direct navigation to IT queue denied | Passed |
| Assignment conflicts | Owner reassignment caused stale specialist update to fail; refreshed specialist lost edit controls | Passed |
| Valid specialist update | Reassignment back restored editing; update reached owner/customer conversation | Passed |
| Sign-out / re-login | Worked for synthetic test account | Passed |
| Incorrect password | Rejected with generic incorrect-email-or-password message | Passed |
| Sign out all devices | Two sessions listed; action signed out; after fresh login only new session listed | Passed UI/session-list check |
| Access revocation | Open session invalidated; re-login became customer-only; operator access still denied | Passed |
| Customer record visibility | Downgraded account saw empty personal workspace, then only its own new request | Passed UI check |
| IT end-to-end | IT customer request, handoff, owner claim, proposal, separate-customer acceptance, Resolved and published / synced | Passed |
| Standard/IT routing | IT case appeared in IT queue, absent from Standard; Standard fix not offered in IT | Passed |
| Separate-company records | New company had none of original company's members, cases or resolutions | Passed UI check |
| Separate-company recall | Exact matching battery question in second company did not retrieve original company's verified fix | Passed |
| Form validation | Empty titles/notes/required acknowledgement and invalid invitation email blocked | Passed |
| Cancellation | Cancelled request/note drafts were not saved | Passed |
| Duplicate clicks | Double-click request and note confirmation each produced one record | Passed |
| Explicit chat note | Correct content extracted, confirmed once and recorded in notes/activity | Passed |
| Missing chat note content | Reference phrase parsed as actual note body | Fixed; clarification verified in browser + regression |
| Generic outcomes | Missed commitment -> Follow-up required; failed attempt -> Reopened; history/memory recorded | Passed |
| Mobile | Sampled workspace/context/menu/dialog usable at 390x844; no page-level horizontal overflow | Passed sampled views |
| Keyboard | Forward Tab, typing, Go back via Enter, Escape and focus restoration worked | Passed |
| Backward Tab | First dialog control to BODY rather than directly last control; browser-chrome involvement uncertain | Fixed; reverse Tab verified in browser |
| Reflection summary | User supplied mutually contradictory sections about issue/preference | Fixed; unified evidence summary, regression + browser verified |
| Owner/staff landing screens | Customer-style screen obscures signed-in role and intended workflow | Fixed; owner dashboard and explicit personal-view labels verified |
| Staff revocation handover | Assigned name became Unassigned while Update assignment remained; owner reassigned explicitly | Fixed; active assignments released atomically, regression verified |

## Prior user-assisted checks

The earlier guided walkthrough also covered signup, notes, visit booking, actual calendar-file download and cancellation, preference carryover, memory toggle, preference retirement, conversation reset, and request search/filter. Those results were user-reported or screenshot-supported; they were not all repeated during the final agent-run pass.

## Original findings (implementation addressed below)

1. **Contradictory context summaries:** combine current issue and applicable customer-wide preferences into one coherent response. Do not infer a root cause yet.
2. **Unclear roles and landing pages:** owner and invited specialist are directed into customer-style request screens; role/company identity needs to be obvious.
3. **Missing note content parsing:** “Please add a note to this request.” prefilled “this request.” instead of asking for content or leaving it empty.
4. **Invitation service selector:** selectable category is silently overridden by invitation scope. The restriction works but the form is misleading.
5. **Revoked staff's assigned cases:** clarify unassignment/requeue and owner notification.
6. **Backward keyboard focus:** verify behavior with browser chrome and assistive technology before deciding on a fix.

The original findings were first recorded without fixes. The user subsequently authorized remediation; current results follow.

## Not verified / blocked

- Real email delivery, verification links and reset-password delivery: email service not configured in current UI.
- Google consent, availability conflicts and real event synchronization: Google integration not configured.
- Real business database imports/provider writes: no actual gateway connected.
- Browser password change: not performed; requires user entry and completion.
- Exhaustive malicious cross-company ID/API probing, independent browser-device session invalidation, invitation expiry after 48 hours, load tests, and full screen-reader/cross-browser audits were not performed.
- The previously outstanding IT recall comparison is now completed: a fresh request and unseen VPN wording returned reviewed steps ON and withheld them OFF.
- Latest automated evidence: 54/54 tests and HTTP checks pass after remediation. Live verification passed 14/14 checks; report data/live-verification-368c560d.json.

## Test records and final state

- Original owner tharun remains signed in on localhost; owner console shows the IT case Resolved and synthetic IT solution published / synced.
- Test specialist qa-specialist-manual-20261106@example.test was created with explicit user approval, then revoked during testing. It is now a customer with a reopened QA battery-reuse request. No staff rights remain.
- Owner's QA applicability case was reassigned to tharun after test specialist revocation.
- Original battery request remains Resolved. Rejected first synthetic candidate remains unpublished; revised synthetic candidate remains published / synced, with one recurrence/failure and keep-review completed.
- QA IT Customer was created in bidaa. Its synthetic AcmeVPN request IT-E7736607-0F32-4B25-8841-CDE6450C7E31 is Resolved. Synthetic VPN solution is published / synced.
- QA Isolated Business was created for company isolation. Its owner has one synthetic battery request SR-577F9621-CBD7-4B57-8290-4B7FE3AD77AC, with no verified fix available. Test account signed out afterward.
- Existing Varma account and original display-fix retirement were not changed in the final pass.
- Synthetic records and knowledge remain for review. No irreversible deletion was performed. Synthetic steps are explicitly labelled and are not verified real hardware/network advice.
- Temporary mobile viewport reset. Temporary final-company test tab closed.

## Evidence

See output/manual-tests:
- battery-rejected.jpg
- battery-revised-published.jpg
- memory-comparison.jpg
- note-parsing-issue.jpg
- outcome-history.jpg
- mobile-context.jpg
- specialist-claimed.jpg
- specialist-stale-update-blocked.jpg
- failed-customer-after-keep.jpg
- it-published.jpg
- final-company-isolation.jpg

Detailed first-pass log: MANUAL-TEST-RESULTS.md.
Open finding log: TESTING-FINDINGS.md.


## Remediation and final retest — November 6, 2026

| Finding | Change | Verification |
|---|---|---|
| Contradictory summary | Removed the concatenation of two differently filtered generated summaries. One deterministic summary now combines the actual ticket, active customer preferences, and ordered outcomes. No retired preferences or unrelated ticket facts. | Browser summary verified; regression checks both issue + cross-ticket preference and retirement exclusion. |
| Role confusion | Owners open Company & team, specialists open their queue, customers open their requests. Staff/owner can deliberately select My requests via an explicit personal-view link. Role/company labels identify the viewed workspace. | Owner navigation and personal-view labels verified in browser; specialist routing code reviewed. |
| Missing note contents | Reference-only phrases such as this request / my ticket / the current case trigger clarification instead of becoming note contents. | Browser now asks What should the note say?; explicit-note and reference variants pass regression. |
| Invitation selector | Invited signup explains that role/company/service scope comes from the invitation and omits the misleading selector. Backend accepts omitted provider for invited signup only; invitation remains authoritative. | Browser form checked; registration regression succeeds without provider and keeps invitation scope. |
| Revoked assignments | Within the same transaction: release active assignments, queue non-pending cases, increment revisions, reset visible team name, record handover in activity and revoke sessions/access. Pending customer confirmation remains pending. | Regression verifies assignment, visible name reset, revision, queue state and denied old session. |
| Customer assignee label | Assignment immediately updates the request's displayed assignee instead of waiting for a later progress update. | API regression verifies new specialist name and reset after revocation. |
| Backward Tab | Explicit first/last control wrapping in open dialogs, while keeping native Escape behavior. | Browser Shift+Tab lands on Confirm; Escape closes. |
| Delivery flush race | Concurrent explicit flush calls await the running batch rather than returning before it finishes. | Mocked email/reset/calendar integration tests and full suite pass. |
| Comparison contrast | Darkened comparison/timeline body text that previously fell just below contrast threshold. | CSS correction; prior measured background/foreground issue addressed. A new full accessibility audit is not claimed. |
| IT recall gap | Fresh IT request with previously unseen wording compared with memory ON/OFF. | Live browser: ON returns published Training-profile steps; OFF provides no fix. |

Final commands/results:
- npm test: 54 tests, 54 passed, 0 failed.
- npm run test:http: passed.
- npm run verify:live: 14 checks passed with configured Hindsight/model services.
- Syntax checks passed for changed UI/server modules.
- Changed tracked source diff whitespace check passed with CRLF treated as line endings.
- Database backed up before restarting: data/pre-report-fixes-20261106.sqlite.
- App restarted on http://localhost:3100 using WSL and the existing local configuration.

The summary is now an authoritative active-ledger view, not two Hindsight-generated reflections. Live semantic recall/learning still uses Hindsight and was revalidated. This deliberately changes summary generation to prevent unsupported missing-evidence claims.

Additional evidence:
- output/manual-tests/fixed-owner-dashboard.jpg
- output/manual-tests/fixed-context-summary.jpg
- output/manual-tests/fixed-it-recall.jpg

The new QA IT unseen recall retest request remains open as a labelled synthetic test record. Its lab comparison did not save a conversation or submit a specialist action. Owner login was preserved; separate IT test account signed out.

### Only remaining user-dependent integration work

1. Email: locally configure RESEND_API_KEY and EMAIL_FROM with a verified sender, then provide a test inbox you control for actual delivery checks.
2. Google: locally configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and complete consent with a test calendar.
3. Business gateway: supply a real test endpoint/customer mapping; configure its trusted origin and token locally.
4. Browser password-change check: user must enter and complete new password submission; backend password/session behavior is covered by automated tests.

No credentials fabricated, no missing integration labelled live, no real email or calendar operation performed. Test credentials and personal keys are not included in this report. Broad load, independent-device, cross-browser and assistive-technology certification remain outside the completed functional checks.


## Additional independent audit — November 6, 2026

Scope: low-usage review across public routes, customer actions, specialist assignment and company/gateway settings. Reused prior manual and automated evidence instead of repeating paid model calls. Read-only HTTP route sweep returned 200 for the nine public/application routes and 404 for an unknown route. HTTP success does not establish that every interactive state works. No code or configuration changed.

### New findings for discussion

| Priority | Finding | Evidence and impact | Status |
|---|---|---|---|
| Medium | Public demo links promise Alice/Bob journeys even when demo mode is disabled | web/pages.js links to /desk?profile=alice and /desk?profile=bob, but current role-aware desk routing does not implement that journey selection. Signed-in owners land on Company & team; signed-out users see ordinary login. | Confirmed source mismatch; end-to-end CTA retest recommended |
| Medium | Memory comparison marketing describes a behavior the current agent deliberately avoids | Home page says Memory OFF suggests restarting. Current safe support policy withholds unverified fixes and offers specialist assistance. It misrepresents the actual demo contrast. | Confirmed copy/policy mismatch |
| Medium | Company management depends on gateway settings loading successfully | web/team.js awaits mountConnector before attaching signup/invitation/revocation handlers; its outer catch replaces the whole page if connector loading fails. A connector failure can therefore hide unrelated team controls. | Confirmed control-flow coupling; failure-injection browser test pending |
| Medium | Generic outcome updates may conflict with specialist confirmation | web/ui.js exposes Update outcome while a specialist solution awaits confirmation. server/providers.js outcome changes the request status independently of handoff/resolution state. A customer could potentially mark the request resolved while its specialist candidate remains pending. | Source-level concern; isolated workflow reproduction required before calling it a confirmed bug |
| Low | Public booking copy may imply calendar synchronization beyond actual capability | Public booking says connected calendars sync automatically; distinguish anonymous walkthrough reservations from authenticated customer service visits. Confirm which booking types really queue Google operations. | Copy/implementation verification needed |
| Low | Explicit owner personal-view link is lost on some subsequent navigations | Personal requests use /desk?view=personal, while generic workspace/footer links use /desk and return an owner to the company dashboard. Intentional role routing can still feel inconsistent unless labels distinguish destinations. | Navigation consistency review; not an authorization defect |

### Follow-up checks worth isolating

- Add a customer note after a specialist handoff and verify it is visible in the specialist's current history, not only in the original context snapshot.
- Verify that confirmed/rejected specialist candidates and generic resolved/failed outcomes cannot leave contradictory states.
- Simulate connector settings failure without taking down company invitations or member controls.
- Run a fresh accessibility scan after the recent role/navigation changes, rather than relying on older contrast results.

No new critical security issue established. These findings supplement the completed report; source concerns are explicitly distinguished from browser-reproduced failures. External email/calendar/gateway and user-entered password checks remain dependent on setup.


## Final project delivery — November 6, 2026

The later independent-audit findings have been addressed:
- Removed misleading Alice/Bob journey links; public CTAs open the actual workspace.
- Corrected Memory OFF comparison and calendar-sync wording.
- Connector failure is isolated to its settings panel, with retry; core company handlers are attached first.
- Browser fault proxy returned 503 for connector settings while a test customer invitation still succeeded. No customer account or email was created.
- Generic outcomes now return 409 while a specialist solution awaits confirmation, preserving the required approval/rejection flow.
- Specialist history now displays current request notes, including notes added after handoff.
- Workspace vs My requests navigation is explicit and intentionally routes owners to company management by default.
- Enlarged checkbox targets after a fresh axe scan flagged target size.

Final verification:
- 55/55 automated tests passed; added regression verifies all generic outcomes are blocked while confirmation is pending, late notes reach staff, and normal rejection still succeeds.
- HTTP integration checks passed.
- Fresh browser axe scans: zero violations on /team, /desk?view=personal, /operator, /, /services, /about, /pricing, /book-a-session, /style-guide. These are sampled default desktop states, not a full screen-reader or cross-browser certification.
- Live Hindsight/model verification from preceding remediation: 14/14 checks passed; final additional changes do not alter semantic matching.
- Connector outage behavior verified through the browser against a temporary local fault proxy. Proxy stopped afterward.
- Existing owner session preserved. Local app left running on port 3100 with temporary audit mode disabled.

All identified functional audit issues are implemented and have the evidence noted above. Remaining external rollout tasks are email sender/inbox setup, Google credentials/consent, a real business gateway, and the user-completed browser password-change check. These are not represented as configured or verified.

Source archive: output/Continuum-AI-final.zip. Excludes .env, database/runtime data, encryption keys, node_modules, .git, and screenshots. Existing checkout retains local credentials and test records. Nothing pushed to GitHub.
