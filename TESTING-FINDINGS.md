# Manual testing findings

## Current checklist — rechecked November 6, 2026

This is the current status. The dated reproductions below preserve what failed originally; their old phrases such as "no fix applied" do not describe the delivered code.

| Finding | Current status | Evidence |
|---|---|---|
| Owner/customer/specialist role confusion | Resolved | Role-specific landing pages, role/company labels and explicit My requests navigation; prior browser verification |
| Contradictory issue/preference summaries | Resolved | Unified active-ledger summary; regression covers preference carryover and retired/unrelated fact exclusion |
| Empty note instruction saved as "this request" | Resolved | Clarification instead of a prepared note; prior browser check and note regression |
| Backward Tab in dialogs | Resolved for tested dialog | First/last focus wrapping; prior browser Shift+Tab and Escape check |
| Misleading service selector on invitation signup | Resolved | Invitation fixes membership scope; selector omitted; registration regression |
| Revoked specialist assignments left unclear | Resolved | Atomic assignment release, requeue, revision and session invalidation; regression |
| Customer-visible assignee stale after assignment | Resolved | Assignment updates visible name immediately; regression |
| Concurrent delivery flush returned too early | Resolved | Callers await the same delivery batch; mocked integration checks |
| Alice/Bob public links did not open promised journeys | Resolved | Links and labels now open the actual workspace; source checked |
| Memory OFF marketing contradicted safe agent behavior | Resolved | Copy no longer promises an unverified restart fix; source checked |
| Connector outage disabled company controls | Resolved | Local error/retry panel; previous browser-injected 503 still allowed a customer invitation |
| Generic outcome bypassed pending specialist confirmation | Resolved | All three generic outcomes rejected with 409 while confirmation is pending; regression |
| Notes added after handoff missing from specialist display | Resolved | Current notes rendered in history; regression verifies refreshed staff context |
| Calendar wording overpromised synchronization | Resolved | Copy qualifies signed-in users with connected calendars |
| Owner navigation destination ambiguous | Resolved | Workspace opens role home; My requests explicitly opens personal requests |
| Comparison contrast and small checkbox targets | Resolved in sampled states | CSS corrected; previous fresh axe scans reported zero violations across nine views |

No previously identified functional checklist defect remains open. This is not a guarantee against undiscovered bugs. Browser evidence above comes from the recorded earlier passes, not a newly repeated full browser audit. See FINAL-TEST-REPORT.md for coverage and limitations. New evaluation findings are recorded separately below.

### New challenge-set limitation — local paraphrase matching

The later 30-question synthetic challenge found 16/30 correct positive recommendations in local deterministic mode. All 30 negative controls withheld inappropriate fixes and all 30 memory-OFF comparisons withheld the learned fix. Only 2/10 recovery scenarios were fully exercised because most initial paraphrases did not create a saved recommendation. This is a known fallback-quality limitation, not a demonstrated unsafe recommendation. No matching rules were tuned to these questions. See output/CHALLENGE-RESULTS.md for separately measured live Hindsight/model results and exact misses. Prior fixed-regression success must not be presented as general language accuracy.

The same frozen dataset completed live as run bd80dcd8: 30/30 correct source-backed recommendations, 30/30 memory-OFF withholding checks, 30/30 negative controls, and 10/10 recovery scenarios passed. Local run ea7648c4 remains reported separately. Live median ON request latency was 5,375 ms; this is not customer time saved. Four evaluation-module regression tests also passed after tightening OFF and live-source assertions. No product matching changes were made to obtain these results.

Fresh checklist reconciliation: current source fixes checked, `npm test` passed 55/55 with zero failures/skips, `npm run test:http` passed, and the local homepage returned HTTP 200. No additional application-code change was needed. The reports and source archive were updated to make historical and current statuses explicit.

Still awaiting external setup or user participation (not marked passed):
- Actual email delivery, verification and password-reset emails: verified sender credentials and a controlled test inbox.
- Google consent, real availability conflicts and calendar synchronization: OAuth configuration and user consent.
- Real business import/write checks: an actual service endpoint and customer mapping; none has been supplied.
- Password change through the browser: user-entered password completion; backend behavior has automated coverage.

Broad load testing, independent-device/cross-browser coverage, exhaustive adversarial security testing and assistive-technology certification were not completed and are not claimed.

### Deferred by user until tomorrow

Local configuration was checked without displaying secrets: `.env` exists and is Git-ignored; RESEND_API_KEY, EMAIL_FROM, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PROVIDER_ALLOWED_ORIGINS are not configured. No real business endpoint has been supplied. No additional live integration check can complete with this configuration.

| Remaining check | Human input needed | Preparation already complete |
|---|---|---|
| Real email, verification and recovery messages | Resend key, verified sender and an inbox controlled by the user | Environment fields and SETUP.md instructions; mocked delivery/token tests pass |
| Real Google Calendar sync | Google OAuth client credentials and user consent | Callback path and setup documented; mocked OAuth, availability, event and cancellation tests pass |
| Business database/service connection | A real compatible gateway, token and customer mapping | Contract in PROVIDER-GATEWAY.md; isolated HTTP gateway retry/idempotency tests pass |
| Browser password change | User privately enters current/new password and completes the form | Backend password-change/session-revocation test passes; actual account password unchanged |

Per user direction these external/user-dependent checks are deferred until tomorrow, not marked passed. No further permission or credentials requested now. The 55/55 test suite and HTTP checks passed in the immediately preceding checklist review; they were not redundantly rerun for this configuration-only check.

## 2026-11-06 — Owner and customer roles are unclear in the interface

Status: Recorded for discussion; no implementation decision finalized.

Observed during manual testing:
- Tester created a company and signed in as its owner.
- The owner landed in /desk, labelled Customer workspace, and could raise a request and chat about it.
- The same owner opened the specialist console and claimed/assigned the case without a separate login.
- This made it unclear whether the tester was acting as an owner, specialist, or customer.

Assessment:
- Owner access to specialist tools is currently intentional; this observation alone is not evidence of unauthorized customer access.
- The interface does not clearly distinguish the signed-in role from the workspace being viewed.
- The walkthrough used one owner account for both sides, so it has not yet verified separation between an independent customer and specialist.

Options to discuss later:
- Show the signed-in role and company prominently.
- Provide role-appropriate landing pages and clear navigation.
- Decide whether owners should submit personal requests, and label that area My requests if retained.
- Test the full workflow with separate customer and specialist accounts.

User direction: Keep this as a finding for a later combined review and final decisions; do not implement these proposed changes yet.


## 2026-11-06 — Context summary contradicts itself

Status: Recorded for discussion; no fix applied.

Manual test on the battery-drain request after confirming cross-ticket email preference:
- User supplied summary output containing two sections.
- First section identifies rapid battery drain but says there is no evidence of customer preferences.
- Second section identifies email instead of phone calls but says there are no recorded open issues.
- Both report no verified outcome, which is consistent with the unresolved request.
- User-visible output is incomplete and contradictory. The cause has not been investigated; do not assume whether these came from one response or repeated summarization.

Expected: One coherent summary combining the current battery issue, the customer-wide email preference, and absence of a confirmed resolution. No unrelated screen-flicker history.

User direction: Collect findings for later joint review; leave implementation decisions pending.


## 2026-11-06 — Missing note content parsed as ticket reference

Status: Reproduced manually in the live localhost UI; recorded for later discussion, no code fix applied.

Steps:
1. Signed in as the existing owner; opened the synthetic QA applicability checks request.
2. Sent: Please add a note to this request.
3. Opened Review add a note.

Observed: note body was prefilled with "this request." Although no note content was supplied, the assistant said the action was prepared. The tester cancelled without saving this incorrect note.

Expected: ask for actual note content, or open an empty required field. A reference to the request is not note content.

Control: "Please add a note: QA test — the charger makes a faint clicking sound." extracted the intended content correctly and saved once after a double click.
Evidence: output/manual-tests/note-parsing-issue.jpg.

## 2026-11-06 — Backward keyboard navigation in dialog needs review

Status: Observation only; requires further verification, no fix applied.

In the Add a note dialog, focus began on Close dialog. Shift+Tab resulted in document.activeElement being BODY instead of directly reaching Confirm. Tab then returned to Close dialog. This may involve browser chrome focus; no access to background page controls was demonstrated. Forward Tab into the textarea, typing, Tab to Go back, Enter to cancel, and Escape with focus restoration worked. Do not describe this as a proven focus-trap escape vulnerability.


## 2026-11-06 — Invitation form allows misleading service selection

Status: Reproduced manually; security scope held; UX fix pending discussion.

Owner invited the test specialist for Standard service requests. Signup nevertheless offered Standard and IT Support. Selecting IT Support still registered staff in Standard (owner member list: staff / repair); IT console access was denied. The selector should reflect or lock to the invitation scope rather than silently overriding a user's selection. The invited specialist also landed on a customer-style empty request screen, reinforcing the previously recorded role-navigation problem.

## 2026-11-06 — Active assignment after specialist revocation needs clearer handling

Status: Operational UX observation; no unauthorized access was demonstrated.

Owner revoked the test specialist while the synthetic QA case was assigned to it. The owner queue then displayed Assigned: Unassigned but the action label remained Update assignment. The test account's sessions were invalidated and staff access stayed denied after re-login. The owner explicitly reassigned the case to tharun afterward. Review whether revocation should visibly unassign/requeue affected cases and notify the owner; current assignment handover is unclear.


## Remediation status — November 6, 2026

The user subsequently authorized fixes. Role navigation, coherent active-context summaries, missing-note clarification, invitation scope UI, revoked assignment release and backward Tab navigation are implemented. An additional visible-assignee correction and delivery flush concurrency fix were included. See FINAL-TEST-REPORT.md for exact browser vs automated evidence and remaining external setup requirements. The original entries above remain as historical reproductions, not current unresolved findings.


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
