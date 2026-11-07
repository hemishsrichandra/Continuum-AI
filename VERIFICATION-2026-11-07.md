# November 7 verification and fixes

Scope: B10–B13 plus C1–C7 and D1–D12 from the supplied checklist. Results distinguish visible browser interaction, isolated automated API checks, and live integration checks. A pass applies to the tested cases, not all possible natural-language inputs.

## Reproduced defects and corrections

1. **A question could replace a real preference.** “How do I prefer to be contacted?” and “How should the team contact me?” matched the extraction rules as new contact instructions. They now create no preference facts. Explicit instructions such as “Could you please text me instead of calling?” still work.
2. **Replacement replies used the old preference.** Facts were extracted only after answering. The current message now overrides conflicting recalled preferences before composing its reply; its evidence identifies the current message as the source. Preference statements and contact-method queries use authoritative workflow replies rather than model rewrites. Persistence still happens after a successful answer, and comparison remains read-only.
3. **Retired preferences could return through old model history.** History now excludes exchanges linked to retired facts, including the original statement and answers quoting them. An incoming replacement also excludes conflicting preference exchanges. Old messages remain visible as history.
4. **A displayed context summary stayed stale.** Refreshing records or changing the memory toggle now clears the old summary. The user can generate a fresh summary from the active ledger.
5. **Customer resolution left specialist work open.** Generic Issue resolved now closes the same request's active specialist case and advances its revision atomically. Stale specialist edits fail. This path does not publish knowledge. The pending customer-confirmation guard remains enforced.
6. **Hypothetical booking could overpromise delivery.** The booking explanation now states the review/confirmation gate and calendar connection requirement without generating promises about email or technician arrival. It creates no action.

Regression tests reproduced defects 1, 2 and 5 before the corresponding fix. Prompt inspection verifies retired-preference exclusion even without archiving first. Browser retests verified corrected preference replies, summary clearing, and synchronized request/case closure.

## Checklist results

| Check | Result | Verification and observed behavior |
|---|---|---|
| B10 Chat persistence / New conversation | Passed | Browser reload preserved chat. Go back preserved it; Confirm archived active messages while the ticket, notes, visit and memories remained. Automated restart/archive checks passed. |
| B11 Activity / metrics | Passed | Browser created one request, note and visit; activity and counts matched. Helpful feedback changed the percentage once. Ordinary chats did not inflate confirmed actions. |
| B12 Generic outcomes | Fixed, passed | Browser tested Reopened, Follow-up required, Resolved, and rejection of generic resolution during pending specialist confirmation. After the fix, customer and specialist both showed Resolved. |
| B13 Validation / duplicate protection / retry | Passed | Empty title/note blocked. Rapid double confirmation produced one record. A temporary local proxy dropped a committed chat response; Retry safely replayed one exchange. A saved note followed by a failed refresh displayed “saved, but ... couldn’t refresh”; reload showed one note. Main services stayed running. |
| C1 Memory toggle | Passed | Browser OFF withheld a previously saved email preference; ON returned it. Model-prompt checks exclude old chat when OFF. The visible ledger and record remain. |
| C2 Cross-request / replacement | Fixed, passed | Browser carried email from display request A to unrelated battery request, then replaced it with text. Question-only queries no longer replace it. Automated checks cover customer isolation and supersession. |
| C3 Ticket-specific failures / commitments | Passed | Display context recorded restart failure and missed ETA. The unrelated battery summary contained its own issue and contact preference, with no display outcomes. Automated scope checks also passed. |
| C4 Summary | Fixed, passed | Browser summary showed battery issue, current status, active preference and no recorded outcome. Old summary cleared after replacement. Automated retirement/unrelated-fact exclusion passed. |
| C5 Retire fact | Fixed, passed | Browser retirement moved the preference out of active context; fresh conversation did not recall it. Automated inspection also verifies no retired preference in model history without requiring a fresh conversation. |
| C6 Memory lab | Passed | Browser ON returned exact confirmed synthetic steps; OFF withheld them. Confirmed actions remained unchanged. Automated snapshot comparison also checked no saved chat, fact, action or reuse receipt. |
| C7 Fake credentials | Passed | Synthetic `api_key=synthetic-not-a-real-key Please email me.` produced no preference fact. Automated test checks the stored ledger. No real credential was used. Chat persistence is still allowed. |
| D1 Handoff / duplicates | Passed | Browser inspected and confirmed handoff; repeating the request identified the existing queued case. Staff history contained the ticket, conversation and relevant failed/missed context. Automated memory-OFF handoff check excluded recalled memories. |
| D2 Queue / assignment | Passed | Browser owner claimed the case and customer saw QA owner as assignee. Separate-identity automated tests enforce company/category boundaries and staff permissions. |
| D3 Progress / ETA / troubleshooting | Passed | Browser saved In progress, High priority, future ETA and failed Restart attempted step. Customer saw the progress message and ETA. Automated tests cover alternate status and stale revision rejection. |
| D4 Proposal / publication gate | Passed | Browser checkbox validation blocked submission until acknowledged; submitted candidate appeared Awaiting confirmation. Automated and live checks withheld the unconfirmed candidate from customer B. |
| D5 Reject / revise / accept | Passed | Browser rejected the main disposable candidate, which stayed unpublished; accepted an isolated synthetic candidate. Automated flow rejected, revised and accepted a new candidate. Live acceptance returned synced. |
| D6 Reuse / environment | Passed | Browser paraphrase returned exact synthetic steps; conflicting Model Z firmware 9 withheld them; a fresh request without model/version asked for prerequisites. Live Hindsight checks passed five held-out paraphrases and incompatible-environment control. |
| D7 Unrelated / competing matches | Passed | Automated and live invoice questions withheld the device fix. A new isolated automated fixture genuinely retrieved two distinct applicable procedures and returned clarification instead of merged steps. The competing branch was not manually exercised in the browser. |
| D8 Success / recurrence | Passed | Browser It worked resolved B. Double-click recurrence reopened B with one queued case and preserved the attempted fix. Automated receipts/count checks passed. |
| D9 Failed reuse / recovery | Passed | Automated fresh failure and browser recurrence both produced contextual recovery, failure count and paused reuse. Further questions withheld the same steps. Direct failed-recommendation, replay and restart checks passed automatically. |
| D10 Keep review | Passed | Browser empty explanation blocked; explained Keep removed the pause. Failed B still received the existing-case response rather than the steps. Automated test also rejects an obsolete review after a newer failure. |
| D11 Retire knowledge | Passed | Browser library showed Retired · retired for the isolated fixture. Live existing-conversation query withheld the retired fix. Automated prompt checks excluded retired steps from later model history. |
| D12 Concurrent assignment | Passed automatically | New test uses an actual separate specialist identity: owner reassigns; stale staff progress fails 409; refreshed former assignee fails 403; customer assignee remains correct. This was not represented as a new two-profile manual browser test. |

## Test evidence and limits

- Full automated suite: **67/67 passed**. Added focused checks cover the failures above, actual former-staff access, credential extraction, read-only comparison and competing procedures.
- `npm run test:http`: passed pages/assets, real-cookie authentication, CSRF, SQLite persistence, account isolation, sign-out, proxy validation and safe replay.
- `npm run verify:live`: **14/14 passed**, run `bccd804b`, November 7, 2026. Used isolated synthetic companies and a unique Hindsight bank prefix. Its published fixture was retired at the end. Private response JSON is in ignored `data/live-verification-bccd804b.json`.
- Additional live preference pass: **5/5 passed**, run `5995b790`: cross-request preference, immediate replacement, query preservation, OFF withholding, retirement without archiving. Report: ignored `output/live-preference-results.json`. Preliminary exact-wording checks were not all satisfied by model-generated phrasing (including a correct “by text” paraphrase); preference answers now use the authoritative workflow wording. These preliminary failures are not all evidence of incorrect saved facts.
- Browser used the existing local app on port 3100 for B tests. The C/D publication/reuse walkthrough used the same source in an isolated local database on port 3110, with local deterministic memory and synthetic accounts. Live cloud behavior was tested separately through the verification script; local publication was not labelled cloud synchronization.
- Screenshots remain private in ignored `output/manual-tests/`: `b11-b12-outcomes.png`, `b13-lost-response.png`, `b13-saved-refresh-failure.png`, `c1-memory-on-proof.png`, `d11-retired-qa-resolution.png`.
- Local English extraction and fallback paraphrase matching remain conservative. This pass is not a production security audit or a claim of general language accuracy.
- Real email delivery, Google Calendar consent/sync, and a real business gateway remain outside this checklist and still require their external configuration/credentials. No passing result here implies those are connected.

## Cleanup

The port-3100 spare request `QA B10-B13 manual 20261107` was resolved, its specialist candidate rejected/unpublished, its active specialist case closed, and its November 8 test visit cancelled. Audit history remains. The user's original screen and battery requests were not modified by these tests. Isolated QA knowledge was retired. Temporary proxy and QA server are stopped after completion; the normal app remains on port 3100.

Existing historical erroneous messages are preserved. The fixes prevent new incorrect extraction/context use; they do not silently rewrite old chats or restore a preference that a previous buggy query had already superseded. Affected users can explicitly state their current preference again or retire the incorrect ledger entry.
