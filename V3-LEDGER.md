# V3 acceptance ledger

Status of each item in `Continuum_AI_V3_Final_Claude_Code_Master_Prompt.md`, written from what was actually run. "Browser-checked" means clicked through against a local, seeded database. Nothing here is a production claim.

Categories used by the brief: **(A)** missing requirement, **(B)** regression risk needing tests, **(C)** confirmed test failure. No (C) was found; the full suite passes (see the commands at the end).

| ID | Item | Status | Evidence | What is still open |
| --- | --- | --- | --- | --- |
| V3-01 / 02 | No manual "Matching symptoms" in the demo, operator proposal or operator revision forms; backend derives the searchable text | **fixed and tested** | `test/derived-symptoms.test.js`; `server/learning.js` (`draftPassport`), `memory-pool.js` (`revise`), `demo-learning.js`, `scoring.js` (completeness is title, environment, safety, steps) | The indexed document is exactly Title + sanitized original issue + steps, so the old "Applies to" suffix is gone and applicability stays separate metadata (the F4 test was updated to match). Imports keep their real source symptom field. |
| V3-03 | Role-correct assignment | **fixed, tested, browser-checked** | `test/claim-release.test.js` (claim, release, two simultaneous claims, 403 on someone else's case, owner reassign, awaiting-confirmation); specialist claim and release clicked in a browser | Server now accepts an empty `assignedTo` as a release by the assignee or an owner. |
| V3-04 / 10 | Up to three suggestions together, per-choice outcomes | **partially implemented** | `test/suggestion-choices.test.js`; browser-checked choose flow | The best-ranked suggestion is still created as the first pending attempt; the other eligible ones (up to two) are previews the customer can choose instead (`POST /api/troubleshooting/choose`, re-validated against current state; the set-aside one is `skipped`, not failed). It is not yet "nothing counts until selected". Outcomes `not_applicable`, `unable_to_try` and `human_requested` are stored as skipped with a reason (migration 10) and never count as failures; `worked` and `did_not_work` are unchanged. |
| V3-05 | Natural device names, ticket device seeding | **partially implemented** | `test/device-matching.test.js`; `test/continuum.test.js` | MacBook, iMac, Dell XPS, ThinkPad, iPhone, iPad, Surface, Pixel, Galaxy, HP/Lenovo lines. Windows, macOS, Ubuntu, Android, iOS already existed. **Not** added: Linux as a family, and bare category words (laptop, desktop, phone) are not treated as devices. |
| V3-06 | De-noising / normalization before RAG | **not implemented** | none | No optional normalizer and no measurements. Nothing here claims 50 ms or a 60%-to-95% gain. |
| V3-07 | Safe generic partial match | **fixed and tested** | `test/device-matching.test.js` (gate and end to end) | "Generic" is inferred: a named hardware device without a version, firmware or leftover environment words. Then, with no conflict and no safety hit, S_compat is 0.5 and the fix stays in play only if S_hybrid is at least 0.65 (and still must reach the 0.70 final score). The advisory text is exact. A different named device, denied ownership, a different OS, a mandatory version/firmware or a safety restriction still blocks. Advisory display was browser-checked only as part of the choice cards, not with a partial-match fixture. |
| V3-08 | Scalable source sync | **partially implemented** | `test/batched-sync.test.js`; `npm run benchmark:sync` | SQLite and PostgreSQL are read in batches (`DATA_SOURCE_BATCH_SIZE`, default 500) and written one transaction per batch; a run pauses at `DATA_SOURCE_MAX_RECORDS` (default 100,000) as `deferred` and the next run resumes from the stored offset. Nothing is dropped or retired on a paused or resumed run, and retirement still needs one uninterrupted full run of an authoritative source. Concurrent syncs of one source are refused. **Not done:** CSV (1 MB paste) and REST (one bounded response) are still single reads that are sliced, not paged; no incremental/changed-only sync. |
| V3-09 | Owner workflow | **partially implemented** | existing tests plus the above | Add, preview (first 2,000 rows, says when truncated), sync, resume, remove and status exist. **Not done:** a separate connection-test button, mapping/source edit screens, pause/disable and a schedule editor beyond the existing interval field. |
| V3-11 | Copy matches behaviour | **fixed** | `web/pages.js` | Removed "Found for Customer B in 40 ms", replaced "only after It worked" and "nothing is reused until a customer confirms" with wording that allows labelled imported, owner-approved and unconfirmed fixes, and marked the Home workspace preview as illustrative. Not every string in the product was audited line by line. |
| V3-12 | New UI reliability on real routes | **partial** | manual checks recorded in `STATUS.md` | axe and manual browser checks on the main routes in both themes; no automated browser suite, no WebGL-absent run, no low-power mobile run. |
| V3-13 | Migrations and vector concurrency | **partial** | existing `index-integrity` and migration tests, whole suite on fresh databases | Migration 10 is additive and idempotent and runs on every fresh database in the suite. A dedicated run of migrations 8 to 10 against a copy of an older fixture database was not added. |
| V3-14 | Demo-account hints, member/invitation/flag/deferral flows | **tested** | `test/demo-signin-hints.test.js`, `members-invites.test.js`, `defer-and-flag.test.js` | Hints are off unless `DEMO_SIGNIN_HINTS` is set **and** `NODE_ENV` is explicitly `development` or `test`; a missing or other value (including `production`) disables them, as the brief requires. Nothing stops someone setting both on a public host on purpose. |
| V3-15 | Editor components | **partial** | saved and reloaded a service in a browser earlier | No automated tests for the tag/row/playbook editors. |
| V3-16 | API contracts for every visible action | **partial** | server tests for the new routes | No browser-driven tests of every screen. |

## Measured, and what it does not show

`npm run benchmark:sync` (synthetic SQLite source, local vectors, this Windows machine, batch size 500), written to `evaluation/sync-benchmark.json`:

| Records | Sync time | Rate | Peak process memory | Retrieval median / p95 | Recall@3 on each record's own wording |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1.0 s | about 960 per second | 90 MB (68 MB before) | 13 ms / 17 ms | 38 of 40 |
| 10,000 | 10.1 s | about 995 per second | 183 MB (101 MB before) | 341 ms / 375 ms | 40 of 40 |

The recall column is an easy case (the query repeats the record's own words) and says nothing about paraphrases; see `SEMANTIC-SEARCH.md` for the harder, honest figures. Retrieval at 10,000 records without ChromaDB is noticeably slower than at 1,000, so a live vector index matters at that size. These are one machine and one workload, not guarantees.

## Commands actually run

```
npm test                      # 347 tests: 346 pass, 1 skipped (Windows symlink case), 0 fail
npm run benchmark:sync        # the table above
```
- `npm run test:http`, `npm run verify:chroma` (10\/10) and `npm run test:chroma` also pass after these changes.
