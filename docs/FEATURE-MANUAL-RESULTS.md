# Feature manual verification results

Role-policy update: [COMPANY-INTERFACE.md](COMPANY-INTERFACE.md) supersedes owner/staff personal-workspace steps below. Company users now have case management and direct Account & security / Sign out controls, with no customer workspace. The new separation passed 71/71 tests, HTTP checks and isolated browser checks. Earlier owner-personal test fixtures below are historical; customer workflows now require separate customer accounts.

November 7, 2026. Covers all 62 entries in `output/FEATURE-MANUAL.md`, combining the completed memory/learning pass with the remaining-feature pass. **Passed** means the documented controlled scenarios were verified with the methods listed; it is not an exhaustive certification. **User/setup needed** is not represented as a live pass.

Final inventory: **55 entries passed for the tested scenarios; 7 retain user/setup-dependent browser or live-integration steps.** The latter are A8, A9 and G1–G5. Automated tests: **70/70**, HTTP checks passed. Frozen live challenge: **30/30 ON, 30/30 OFF, 30/30 negative controls, 10/10 recovery**, run `7905e0f8`.

The remaining-feature pass reproduced no new application defect. Three additional regression scenarios now cover signup-link rotation, the complete IT learning workflow, and revocation during pending customer confirmation. Existing fixes remain covered. Tests used synthetic data and preserved the original localhost workspace.

## Accounts

| ID | Feature | Result | Evidence |
|---|---|---|---|
| A1 | Sign in, password visibility, role landing | Passed | Browser Show/Hide, incorrect-password rejection, owner/company landing, customer workspace and specialist default routing. Explicit My requests intentionally preserves the personal view. |
| A2 | Company creation | Passed | Browser created an isolated owner/company with no other memberships, tickets or resolutions. |
| A3 | Customer links and rotation | Passed | Browser registered a customer, rotated the link, rejected a new registration through the old link, and signed the existing customer in again. New automated test also preserves an already active customer session. |
| A4 | Email-bound invitations and scope | Passed | Browser wrong email rejected; correct email accepted; invited form omitted category override. Staff role/category, single-use state and expiry checked by isolated automated fixtures. |
| A5 | Role navigation / My requests | Passed | Browser owner personal/company/console navigation; explicit role/company labels. |
| A6 | Identity and sessions | Passed | Browser showed name, email, role, company, and two actual active sessions after an independent HTTP login. This was not claimed as two physical devices or independent browser profiles. |
| A7 | Sign out / all devices | Passed | Browser normal logout/relogin and Sign out all devices. Independent old HTTP session rejected with 401; current browser signed out; new login worked. |
| A8 | Password change | User needed for browser step | Backend current-password validation, password replacement and session revocation passed in the automated suite. The user must enter and submit a new password themselves for the browser test; no user credential was changed. |
| A9 | Verification / password recovery email | Setup needed | Browser disabled controls and recovery explanation were correct. Token encryption, expiry, one-use and reset behavior passed mocked-provider tests; actual inbox delivery remains unverified. |

## Requests and conversations

| ID | Feature | Result | Evidence |
|---|---|---|---|
| B1 | Create and persist requests | Passed | Browser created two distinct requests, reloaded, and retained their IDs/issues/statuses; customer account had its own empty history. API ownership checks passed. |
| B2 | Search, filters, selection | Passed | Browser title search, issue text and partial ID each returned one matching row; clearing returned both. Open/Resolved/All filters changed rows; switching restored the selected request's chat/context. |
| B3 | Status / assignee / ETA / overdue | Passed | Browser no-ETA response matched record. An explicitly seeded historical-ETA fixture in the isolated QA database showed Overdue; the reply used its exact In progress status and 2026-11-06 ETA. Prior specialist-update tests cover normal posted ETA. |
| B4 | Chat / suggestions / keyboard | Passed | Browser clicked an empty-chat status suggestion, used Send and Enter, and verified Shift+Enter inserted a line break. Chat remained request-scoped. |
| B5 | Review, edit, cancel proposals | Passed | Browser edited a proposed note; Go back saved nothing. Reopened review and confirmed the edited text; saved note matched that edit exactly. |
| B6 | Missing / hypothetical / negated instructions | Passed | Browser asked what the note should say and what issue to include. Hypothetical booking explained confirmation; negated booking prepared no action. Confirmed-action count remained unchanged. |
| B7 | Notes / later staff context | Passed | Edited note visible in Request notes and saved memory. Previous browser/API pass verified notes added after handoff reach current staff history. |
| B8 | Sources / response details | Passed | Browser expanded actual record, memory and timing evidence. Previous learning pass and live harness verify reviewed source IDs/exact steps and Hindsight attribution. |
| B9 | Helpful / Needs work | Passed | Browser Helpful survived reload; changing to Needs work changed the saved state and metric to 0%, with one rated response. |
| B10 | Persistence / New conversation | Passed | Earlier November 7 browser and restart/archive regression; see VERIFICATION-2026-11-07.md. |
| B11 | Activity / metrics | Passed | Earlier browser pass; current visit booking/cancellation and feedback also updated counts. |
| B12 | Generic outcomes | Passed | Earlier fixed/retested pending-confirmation guard and synchronized case closure; current disposable case cleanup resolved successfully after rejecting its proposal. |
| B13 | Validation / duplicate / retry | Passed | Earlier browser empty fields, duplicate clicks, dropped-response retry and saved-update/failed-refresh tests; full suite passed. |

## Memory

| ID | Feature | Result | Evidence |
|---|---|---|---|
| C1 | Memory toggle | Passed | Earlier browser, prompt inspection and five-check live preference pass. |
| C2 | Cross-request preferences / replacement | Passed | Earlier fixed/retested browser and live preference pass. Preference questions do not overwrite instructions. |
| C3 | Issue-specific failure / commitment history | Passed | Earlier browser unrelated-request comparison and automated scope checks. |
| C4 | Summary | Passed | Earlier active-ledger summary and stale-summary fix verified. |
| C5 | Retire fact | Passed | Earlier browser retirement; live and prompt tests exclude retired facts without requiring archive first. |
| C6 | Memory lab | Passed | Earlier browser ON/OFF comparison and automated no-chat/no-action/no-receipt checks. |
| C7 | Credential-like text | Passed | Synthetic fake-key message created no extracted preference; no real key used. |

## Specialist learning

| ID | Feature | Result | Evidence |
|---|---|---|---|
| D1 | Context / duplicate handoff | Passed | Earlier browser; current revocation fixture also used a confirmed handoff. Memory-OFF and duplicates checked automatically. |
| D2 | Queue / history / assignment | Passed | Earlier browser plus current separate specialist login and self-only assignment selector; claim succeeded. |
| D3 | Progress / ETA / troubleshooting | Passed | Earlier browser and automated checks; new IT end-to-end test also saves priority, ETA, Awaiting customer and failed step. |
| D4 | Proposal / publication gate | Passed | Earlier browser acknowledgement validation; current synthetic candidate stayed pending and unpublished during revocation. |
| D5 | Reject / revise / accept | Passed | Earlier browser/API/live revision/acceptance checks. Current revoked-staff candidate remained rejectable and was rejected for cleanup. |
| D6 | Reuse / environment | Passed | Earlier browser matching/conflicting/missing-environment checks; current live challenge recorded separately below. |
| D7 | Unrelated / competing matches | Passed | Earlier unrelated controls and an automated fixture retrieving two genuinely competing procedures. Competing branch is not labelled a manual browser test. |
| D8 | Successful reuse / recurrence | Passed | Earlier browser and durable, duplicate-safe outcome checks. |
| D9 | Failed reuse / recovery | Passed | Earlier browser recurrence and automated direct failure/recovery tests. |
| D10 | Keep / retire review | Passed | Earlier browser explanation validation and keep review; obsolete-review protection checked automatically. |
| D11 | Retire knowledge | Passed | Earlier browser retirement, live existing-conversation check and model-prompt exclusion. |
| D12 | Concurrent assignment | Passed automatically | Actual separate specialist identity: stale revision fails 409, refreshed former assignee fails 403. No new two-profile manual test is claimed. |

## Team management

| ID | Feature | Result | Evidence |
|---|---|---|---|
| E1 | Members / staff revocation | Passed | Fresh browser: specialist claimed and proposed; owner removed access; case stayed Awaiting confirmation and became Unassigned. Re-login became customer-only and console access failed. Automated tests additionally verify old sessions and active-case requeue. |
| E2 | Customer / company isolation | Passed | Fresh customer could not see owner's personal requests or team/console controls. Automated suite verifies distinct-company records, knowledge, assignment and booking boundaries. Prior separate-company browser evidence is retained. |
| E3 | Standard / IT Support | Passed | New automated IT actors completed request → handoff → specialist assignment/progress → pending proposal → customer acceptance → matching reuse. OFF and Standard category withheld IT fix. Fresh browser Standard specialist was denied IT queue. |
| E4 | Connector outage isolation | Passed | Browser proxy returned 503 only for connector settings; team page showed local error and still created a customer invitation. Restored endpoint and Retry loaded settings successfully. |

## Visits and public pages

| ID | Feature | Result | Evidence |
|---|---|---|---|
| F1 | Service visit / capacity | Passed | Browser confirmed 8 Nov 2026, 10:00 AM IST, reflected one visit/count. Concurrent capacity protection passed isolated automated tests. |
| F2 | Calendar export | Passed for download/file contents | Actual browser .ics download: DTSTART 20261108T043000Z, DTEND 20261108T050000Z, stable booking UID. Correct 30-minute instant. No personal calendar import or live Google sync is claimed. |
| F3 | Visit cancellation | Passed | Go back preserved visit; Confirm cancelled it and returned Upcoming visits to zero. Restored backup preserved cancelled state. |
| F4 | Public navigation / mobile menu | Passed | Home/Product/Approach/Pricing routes rendered; menu expanded, Escape collapsed it, Product link navigated. Sampled mobile pages had no blocking horizontal overflow. |
| F5 | Pricing | Passed | Annual displayed $23.20/$63.20 and $278.40/$758.40 annual labels; monthly restored $29/$79. Explore Growth preselected Growth in session form. No billing transaction exists or was performed. |
| F6 | Public reservation / export / cancellation | Passed | Browser receipt persisted after reload, accurately said email disabled; actual calendar file matched 9 Nov 2026, 10:00–10:30 AM IST. Keep preserved reservation; final cancellation released it. Anonymous reservation/capacity contracts passed automatically; this browser reservation used the synthetic signed-in account. |
| F7 | Style guide / 404 | Passed | Sample buttons gave feedback; inputs/select worked; disabled button stayed disabled. Unknown route displayed 404 with recovery links. |
| F8 | Mobile / keyboard dialogs | Passed sampled states | 390×844 workspace: reverse Tab wrapped Close → Confirm, forward Tab wrapped back; empty note was invalid; Escape closed dialog and restored Add a note focus. No page-level blocking overflow. |

## External integrations

| ID | Feature | Result | Evidence / missing dependency |
|---|---|---|---|
| G1 | Email / delivery status | Setup needed for live pass | RESEND_API_KEY and EMAIL_FROM absent. Verified sender, controlled inbox and real delivery needed. Mocked email/outbox contracts passed. |
| G2 | Google consent / availability / sync | Setup and user consent needed | GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET absent. Real OAuth consent/calendar events and busy intervals remain unverified. Mocked OAuth/Google contracts passed. |
| G3 | Delivery retries / disconnect | Setup needed for live pass | No connected calendar or real eligible failed delivery. Retry/revocation/failure contracts passed automatically; real provider outcome remains unverified. |
| G4 | Business import / mapping | Real gateway needed | No gateway or trusted origin configured. Isolated authenticated gateway/schema/customer-isolation/atomic-import checks passed; no real business database was used. |
| G5 | Confirmed provider writes | Real gateway needed | Loopback gateway receipt/idempotency/lost-acknowledgement tests passed. Actual provider writes require G4 and its supported capabilities/receipt contract. |

## Developer verification

| ID | Feature | Result | Evidence |
|---|---|---|---|
| H1 | SQLite persistence / backup | Passed in isolated restore | Restarted QA app under WSL with same DB; saved request/note remained. Online db:backup command succeeded. Restored a separate copy: integrity_check ok, valid login, two requests, edited note and cancelled visit/public reservation. Running/original DB was never replaced. |
| H2 | Tests / HTTP | Passed | 70/70 automated tests; HTTP checks passed. Private logs: output/remaining-full-tests.txt and output/remaining-http-tests.txt. |
| H3 | Live challenge | Passed | Frozen live run `7905e0f8`: 30/30 correct source-backed ON, 30/30 OFF withholding, 30/30 safe negative controls, 10/10 recovery. See output/CHALLENGE-RESULTS.md and output/evaluation-results/evaluation-7905e0f8.json. Earlier 14/14 live learning and 5/5 live preference passes remain separate. |
| H4 | Accessibility scanner | Passed sampled states | Fresh nine desktop views each reported zero axe violations; sampled mobile public/workspace views also reported zero. This is not screen-reader or cross-browser certification. Temporary audit server stopped afterward. |

## Evidence and setup still needed

All browser operations used the normal visible application controls through the browser automation interface. The second session, historical overdue record and specialist provisioning were explicitly isolated fixtures, not presented as UI-created sessions/history or staff invitation registration. Staff provisioning used the existing local administration helper only in `output/remaining-qa.sqlite`; owner revocation was then exercised through the UI. Staff invitation/registration scope was checked automatically.

Private evidence in `output/manual-tests/`:

- `remaining-mobile-dialog.png`
- `remaining-public-cancelled.png`
- `remaining-customer-isolation.png`
- `remaining-connector-error.png`
- `remaining-staff-revocation.png`
- `remaining-accessibility-results.json`

Isolated data/restore: `output/remaining-qa.sqlite`, `output/remaining-backup-20261107.sqlite`. These are ignored local test artifacts, not source deliverables. No credentials, signup tokens or session cookies are included in this report.

The seven user/setup-dependent entries are A8, A9 and G1–G5. They reduce to four remaining inputs/actions: the user's browser password change; verified email sender and controlled inbox; Google OAuth configuration/consent; a compatible real business gateway. External integration contracts passing does not establish live connection or delivery.

The local fallback's previously measured 16/30 paraphrase recall remains a documented limitation; the app's configured live mode is evaluated separately. No language rules were tuned to the frozen challenge during this pass. Existing inaccurate historical chats are not rewritten.

Cleanup: synthetic service/public visits cancelled, pending revocation-test solution rejected/unpublished, its request/case resolved, and temporary staff access removed. Temporary browser tabs, fault proxy and audit/QA server are closed/stopped. The original app and its owner session remain on localhost:3100; its requests were not modified in this pass. Synthetic cloud evaluation namespaces are separate and may retain labelled evaluation data.
