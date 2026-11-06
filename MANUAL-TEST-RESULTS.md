# Manual browser tests — November 6, 2026

> Historical first-pass results. All functional findings below were subsequently addressed. Read the current checklist at the top of TESTING-FINDINGS.md and the final delivery section of FINAL-TEST-REPORT.md for current status. External integration and user-participation checks remain outstanding as documented there.

Performed by operating the visible localhost browser UI: typing text, using buttons and selectors, keyboard actions, refreshes, and a temporary mobile viewport. No API shortcuts, database mutation, source-code fixes, sign-outs, or account switches were used in this pass. The existing owner account, tharun, remained signed in. These are observed manual results, not a claim that every edge case or every integration has been tested.

## Results from this pass

| Check | Observed result | Assessment |
|---|---|---|
| Empty specialist proposal | Empty title blocked by browser validation | Passed |
| Missing testing/privacy acknowledgement | Submission blocked until acknowledgement selected for synthetic fixture | Passed |
| Customer rejection | Battery request reopened; specialist case returned to In progress; resolution rejected / not published | Passed |
| Revised proposal | Different synthetic steps became a new pending candidate; old rejection retained | Passed |
| Revised customer acceptance | Battery case resolved; new candidate published / synced | Passed |
| Memory lab positive control | Model B firmware 3 paraphrase returned exact revised synthetic steps ON; no verified fix OFF | Passed |
| Source details | ON cites human-verified resolution, Hindsight, compatible model, recall count and latency | Passed |
| Wrong model | Model Z firmware 3 did not receive Model B fix | Passed |
| Wrong version | Model B firmware 9 did not receive firmware 3 fix | Passed |
| Missing environment | Battery question without model/version asked to confirm Model B firmware 3; withheld steps | Passed |
| Unrelated question | Billing question did not receive battery fix or invented invoice data | Passed for relevance exclusion |
| Comparison side effects | Confirmed-action count stayed unchanged and conversation remained empty after comparison | Passed |
| Empty request / note | Required browser validation blocked both | Passed |
| Cancelled request | Go back discarded entered draft; request count stayed 2 | Passed |
| Double-click request confirmation | One QA request created; total rose from 2 to 3; persisted after reload | Passed |
| Explicit chat note | Exact intended note extracted; one saved note and activity entry after double-click confirmation | Passed |
| Missing chat note contents | "Please add a note to this request." prefilled "this request." | Failed; cancelled without saving |
| Repeated handoff | First double-click created one case; later attempt rejected with existing-case message; one QA case in queue | Passed |
| Missed commitment outcome | Synthetic report set Follow-up required; memory and activity recorded | Passed |
| Failed outcome | Synthetic report set Reopened; memory and activity recorded | Passed |
| IT queue navigation | Owner opened IT queue; no Standard cases or resolutions shown; returned to Standard | Passed for navigation/separation only |
| Account settings | Existing sessions visible; unavailable email/Google controls disabled with setup explanation | Passed for UI states only |
| Invitation validation | Invalid email blocked; Standard/IT selector operable; no invitation created | Passed |
| Mobile 390x844 | Workspace had no page-level horizontal overflow; request row internally scrolls; context and note dialog usable | Passed for sampled views |
| Mobile menu | Opens; Escape closes and restores focus | Passed |
| Keyboard note dialog | Forward Tab, typing, Go back via Enter, Escape and trigger-focus restoration worked | Passed |
| Backward Tab from first dialog control | BODY became active rather than last dialog control; possible browser-chrome behavior | Needs review |
| Persistence | Request, saved note, outcomes, and single specialist case remained after reload | Passed |

## Test records changed

- Original Battery drains quickly request: first synthetic candidate rejected, revised synthetic candidate accepted. Final status Resolved.
- Battery drain — rejection test: rejected / not published.
- Battery drain — revised synthetic test: published / synced. Clearly labelled synthetic steps, not real device advice. Left available for subsequent cross-account tests.
- New request QA applicability checks: SR-ADA60A70-86FE-43AF-8C43-EB50F16FB7E4.
- QA request has one explicit charger note, one specialist handoff, and two synthetic outcome records. Final customer status Reopened; specialist case Queued, unassigned.
- Existing screen resolution remains retired. Existing second-customer case was not changed.
- Mobile viewport override reset. Owner left in Specialist console.

## Deferred at the user's account-change boundary

Do not mark these passed based on the current owner-only walkthrough:
1. Invite and register a separate specialist; prove staff-only scope, claim restrictions, and owner-only team management.
2. Access revocation and its effect on the specialist's sessions.
3. Independent customer request/conversation isolation and separate-company knowledge isolation.
4. Full IT customer request, handoff, specialist proposal and customer confirmation workflow.
5. Successful resolution reuse by another customer and recurrence; review KEEP branch, ensuring failed customer cannot receive same fix again.
6. Sign out/sign in, wrong credentials, all-device sign-out, and persistence across account changes.
7. Password change/reset and email-verification flows require appropriate user participation and configured email.
8. Live email delivery and Google consent/calendar synchronization: unavailable setup in current UI.
9. Actual business gateway import/delivery: no company gateway or allowed origin configured.

The user previously manually exercised initial signup, request/chat, specialist progress, successful learning and reuse, reuse failure, retirement, notes, booking/export/cancellation, preference carryover, memory toggle, context retirement, new conversation and search/filter. Those are prior user-reported or screenshot-supported checks, not silently counted as fresh agent executions here. The contradictory reflection summary remains an open finding.

## Evidence

Screenshots are in output/manual-tests:
- battery-rejected.jpg
- battery-revised-published.jpg
- memory-comparison.jpg
- it-queue.jpg
- mobile-context.jpg
- note-parsing-issue.jpg
- outcome-history.jpg

See TESTING-FINDINGS.md for issues awaiting joint review. No application source was changed during this pass.


## Final follow-up completed

Separate-account, IT and sampled company-isolation tests were subsequently completed. The earlier deferred list is historical. See FINAL-TEST-REPORT.md for the final status, remaining limitations, test identities and outcomes.
