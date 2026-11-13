# V3 acceptance ledger

Status of each item in `Continuum_AI_V3_Final_Claude_Code_Master_Prompt.md`, written from what was actually run. "Browser-checked" means clicked through against a local, seeded database. Nothing here is a production claim.

Categories used by the brief: **(A)** missing requirement, **(B)** regression risk needing tests, **(C)** confirmed test failure. No (C) was found; the full suite passes (see the commands at the end).

| ID | Item | Status | Evidence | What is still open |
| --- | --- | --- | --- | --- |
| V3-01 / 02 | No manual "Matching symptoms" in the demo, operator proposal or operator revision forms; backend derives the searchable text | **fixed and tested** | `test/derived-symptoms.test.js`; `server/learning.js` (`draftPassport`), `memory-pool.js` (`revise`), `demo-learning.js`, `scoring.js` (completeness is title, environment, safety, steps) | The indexed document is exactly Title + sanitized original issue + steps, so the old "Applies to" suffix is gone and applicability stays separate metadata (the F4 test was updated to match). Imports keep their real source symptom field. |
| V3-03 | Role-correct assignment | **fixed, tested, browser-checked** | `test/claim-release.test.js` (claim, release, two simultaneous claims, 403 on someone else's case, owner reassign, awaiting-confirmation); specialist claim and release clicked in a browser | Server now accepts an empty `assignedTo` as a release by the assignee or an owner. |
| V3-04 / 10 | Up to three suggestions together, per-choice outcomes | **partially implemented** | `test/suggestion-choices.test.js`; browser-checked choose flow | The best-ranked suggestion is still created as the first pending attempt; the other eligible ones (up to two) are previews the customer can choose instead (`POST /api/troubleshooting/choose`, re-validated against current state; the set-aside one is `skipped`, not failed). It is not yet "nothing counts until selected". Outcomes `not_applicable`, `unable_to_try` and `human_requested` are stored as skipped with a reason (migration 10) and never count as failures; `worked` and `did_not_work` are unchanged. |
| V3-05 | Natural device names, ticket device seeding | **implemented, with one measured exception** | `test/device-matching.test.js`; `test/continuum.test.js` | MacBook, iMac, Dell XPS, ThinkPad, iPhone, iPad, Surface, Pixel, Galaxy and HP/Lenovo lines, plus Linux as a family (Ubuntu implies it; a plain "Linux" does not contradict an Ubuntu-only fix, it asks for the version). **Bare category words (laptop, desktop, phone) are deliberately not device facts:** adding them was tried and lowered recall on the informal wording set below its floor (22 of 30), so it was removed. |
| V3-06 | De-noising / normalization before RAG | **implemented (rules), measured on one example** | `server/query-normalizer.js`; `test/query-normalizer.test.js` | Deterministic rules turn a noisy message into a symptom, component, urgency and unconfirmed assumptions, while keeping negations and device facts; the ticket description and long context values are de-noised the same way, and the raw message is stored as written. An approved model can be plugged in (`queryProvider`), sees sanitized text only, has a 1.5 s limit, and is rejected if it changes or drops any device fact; any failure falls back to the rules. **No live provider is wired in**, and the measured gain is one worked example (S_final 0.556 to 0.730, tests print it), not a corpus-level accuracy figure. |
| V3-07 | Safe generic partial match | **fixed and tested** | `test/device-matching.test.js` (gate and end to end) | "Generic" is inferred: a named hardware device without a version, firmware or leftover environment words. Then, with no conflict and no safety hit, S_compat is 0.5 and the fix stays in play only if S_hybrid is at least 0.65 (and still must reach the 0.70 final score). The advisory text is exact. A different named device, denied ownership, a different OS, a mandatory version/firmware or a safety restriction still blocks. Advisory display was browser-checked only as part of the choice cards, not with a partial-match fixture. |
| V3-08 | Scalable source sync | **mostly implemented** | `test/batched-sync.test.js`, `test/owner-source-tools.test.js`; `npm run benchmark:sync` | SQLite and PostgreSQL are read in batches and REST APIs that page by number are read page by page (`pageParam`, `pageSize`); a run pauses at `DATA_SOURCE_MAX_RECORDS` and resumes from the stored offset (including the right REST page). Nothing is dropped, nothing is retired on a paused or resumed run, concurrent syncs are refused. **Still open:** a pasted CSV is one bounded 1 MB read, and there is no incremental changed-only sync. |
| V3-09 | Owner workflow | **mostly implemented** | `test/owner-source-tools.test.js` | Added: a non-mutating connection test (reads one small batch, echoes nothing), pause and resume (a paused source skips manual and scheduled syncs), REST paging fields, plus the existing add, preview, sync, remove, schedule interval and status. **Still open:** a dedicated screen to edit a saved mapping (the save endpoint accepts it, the UI only creates) and a schedule editor beyond the interval field. |
| V3-11 | Copy matches behaviour | **fixed** | `web/pages.js` | Removed "Found for Customer B in 40 ms", replaced "only after It worked" and "nothing is reused until a customer confirms" with wording that allows labelled imported, owner-approved and unconfirmed fixes, and marked the Home workspace preview as illustrative. Not every string in the product was audited line by line. |
| V3-12 | New UI reliability on real routes | **partial (blocked on a tool)** | manual and axe checks recorded in `STATUS.md` | No automated browser suite: adding the test driver (`npm install --save-dev playwright-core`, which would use the Edge already installed here) was refused by this session's permission rules, so it was not installed. The WebGL-off, reduced-motion and keyboard checks therefore remain manual. |
| V3-13 | Migrations and vector concurrency | **tested** | `test/migration-v10.test.js` plus the existing `migration-v4/v5` and `index-integrity` tests | A populated older database gets migration 10 added, keeps its knowledge, attempts and accounts, passes integrity and foreign-key checks, and re-opening changes nothing. Migrations 8 and 9 are exercised by the v4 upgrade test. |
| V3-14 | Demo-account hints, member/invitation/flag/deferral flows | **tested** | `test/demo-signin-hints.test.js`, `members-invites.test.js`, `defer-and-flag.test.js` | Hints are off unless `DEMO_SIGNIN_HINTS` is set **and** `NODE_ENV` is explicitly `development` or `test`; a missing or other value (including `production`) disables them, as the brief requires. Nothing stops someone setting both on a public host on purpose. |
| V3-15 | Editor components | **partial (blocked on a tool)** | saved and reloaded a service in a browser earlier | Needs the same browser test driver. |
| V3-16 | API contracts for every visible action | **partial (blocked on a tool)** | server tests for every new route | Needs the same browser test driver for screen-level tests. |

## Also done in this round

* **Invitation email is opt-in:** shown only when the server has email configured; asking for it without email set up is refused; nothing is queued unless the owner ticks the box; the queued message is sealed at rest (`test/members-invites.test.js`).
* **Could not reproduce the one-off erasure test failure:** 28 further runs of the erasure and privacy test files, 18 of them in parallel, all passed. The cause is unknown.

## Measured, and what it does not show

`npm run benchmark:sync` (synthetic SQLite source, local vectors, this Windows machine, batch size 500), written to `evaluation/sync-benchmark.json`:

| Records | Sync time | Rate | Peak process memory | Retrieval median / p95 | Recall@3 on each record's own wording |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1.0 s | about 960 per second | 90 MB (68 MB before) | 13 ms / 17 ms | 38 of 40 |
| 10,000 | 10.1 s | about 995 per second | 183 MB (101 MB before) | 341 ms / 375 ms | 40 of 40 |

The recall column is an easy case (the query repeats the record's own words) and says nothing about paraphrases; see `SEMANTIC-SEARCH.md` for the harder, honest figures. Retrieval at 10,000 records without ChromaDB is noticeably slower than at 1,000, so a live vector index matters at that size. These are one machine and one workload, not guarantees.

## Commands actually run

```
npm test                      # 362 tests: 361 pass, 1 skipped (Windows symlink case), 0 fail
npm run benchmark:sync        # the table above
```
- `npm run test:http`, `npm run verify:chroma` (10\/10) and `npm run test:chroma` also pass after these changes.
