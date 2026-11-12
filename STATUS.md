# Status — what is implemented, tested and not done

Dates and counts below come from runs in the build environment (Node v22.23.4, npm 10.9.9, Linux) on a fresh `npm ci`.

## Baseline (before this work)
`npm ci` ok; `npm test`: **79 passed, 0 failed** (fresh run, not copied from the README). No Hindsight, model, email or Google credentials were available in the environment, so those integrations were not exercised live.

## Current verification
`npm test` — see the final numbers in the repository's last commit message / the run recorded at the bottom of this file. Also executed and passing: `npm run demo`, `npm run demo:multi`, `npm run demo:learning`, `npm run test:http`. Browser checks (Playwright/Chromium): `/demo` full chain, mobile layout (no horizontal overflow at 390 px), reset, tab isolation, axe WCAG A/AA scan (0 violations after the guided scenario); main app: owner console (dashboard, queue, passport preview, proposals), customer A/B flow with the learned-source banner, owner data-source create → dry run → sync. No console errors or 5xx responses in those runs.

## Implemented
* Phase 0 fixes with regression tests: negated/Android/iOS/range compatibility, preserved “Fictional demo only” qualifiers, `/api/book/cancel` role guard.
* Migration 5 (+ backup, backfill, FTS), unified `memory_pool` with tenant + service scoping.
* Scoring module and hybrid retrieval; standard → ≤3 sequential memory fixes → specialist flow; per-service editable diagnostic schema with dynamic customer fields.
* Learning: PII scrubbing, secrets rejection, `C_init`, confirmation deadlines, overdue publication with honest labelling, SLA escalation, case timeline, self-correcting flags, versioned revisions, review.
* Data-source mediator (CSV, SQLite, REST, PostgreSQL-with-driver) with mapping UI, dry run, safe upsert, encrypted secrets.
* `/api/companies/:id/intelligence` and the staff dashboard; passport detail cards; revise/review UI.
* Isolated `/demo` with its own API namespace, UI, tests and `npm run demo:learning`.

## Deliberate deviations from the master prompt (and why)
* **`/operator` and `/team` were kept** rather than replaced by `/desk`: removing them would break bookmarks, auth redirects and existing tests. The company/specialist upgrades live in those pages.
* **Existing gateway connector kept.** `server/connector.js` (customer directory, request snapshots, confirmed actions) still serves existing repair/IT customers; the new mediator is the knowledge-ingestion path. Chatbot `adapter` stays `repair|it` as the ticket-record shape.
* **Memory toggle removed from the customer workflow**, but the server still honours an explicit `memory:false` API flag as a privacy opt-out (and the *Memory lab* comparison uses it).
* **Hindsight** remains for per-ticket customer memory; company-knowledge retrieval is the local pool (the old Hindsight-ranked recall was replaced; two tests that exercised it were replaced by pool tests).
* After a failed learned fix the next customer message presents the next suggestion; with nothing further eligible the case is handed to the specialist queue immediately (so closing the browser does not strand it).

## Not done / limitations
* `server/provider-actions.js` was **not** consolidated or reduced; hardcoded scheduling paths and the marketing booking feature were left intact (no regression risk taken).
* Remote embeddings and the real overdue-email follow-up are implemented but were **not exercised against live services** here (mock-tested; email follow-up only when Resend is configured).
* The PostgreSQL adapter was tested with a mock driver only; the `pg` package is not a dependency.
* The local embedding is lexical-conceptual, not neural; paraphrases outside its concept list may need the remote embedding backend (never exercised against a live model here).
* No load/performance testing beyond the test suite; demo sessions are in-memory (lost on restart) with a 500-session cap.
* All data in tests, demos and screenshots is synthetic. Nothing here measures real customer or business impact.

## Run history
* `npm test` (two consecutive full runs): **165 tests, 165 passed, 0 failed** (~67 s each). Baseline was 79; this work added regression, scoring, memory-pool, self-correcting, follow-through, data-source, migration-v5, intelligence and demo-isolation suites and replaced two obsolete Hindsight-recall tests.
* `npm run demo`, `npm run demo:multi`, `npm run demo:learning`, `npm run test:http`: all pass.

## RAG strengthening (follow-up run)
Measured on synthetic data with a fresh `npm ci` environment (Node v22.23.4). Recall = the right reviewed fix recommended for a reworded problem; every set also checks 30 negative questions (wrong device, missing environment, unrelated), memory-off leakage and repeated failed fixes.

| Set | Recall before | Recall after | Unsafe / wrong | Notes |
| --- | --- | --- | --- | --- |
| Regression (20 questions) | 20/20 | 20/20 | 0/30 | unchanged |
| Challenge (30) | 22/30 | 30/30 | 0/30 | informed the synonym list |
| Held-out (30) | 19/30 | 30/30 | 0/30 | diagnosed from its misses, so no longer clean |
| **Validation (30)** | — | **26/30 first measurement, 27/30 final** | 0/30 | written after the changes; measured once before further generic fixes found by other probes |

Honest reading: the independent number is about **87–90% recall with zero wrong or unsafe recommendations**, not 100%. 12 near-miss hard negatives (shared words, different need) produced 0 suggestions, with a positive control proving the check can fail. Remaining validation misses: three paraphrases that the concept map does not cover. All figures are synthetic and not customer-impact measurements.

Changes: the pending-fix re-show now uses the hybrid retriever (it used a keyword check); a strong retrieval match can bypass the topic-word gate; a broader concept map and concept-weighted local embedding (v2); a sentence mentioning "email" is no longer misread as a contact preference; stop-word list extended.

Full run at that point: 177 tests, 177 passed.

## Flaw-register validation (latest run)
Every item of the independent flaw report was checked against the code (see `FLAW-REGISTER-STATUS.md`). Reproductions of the report's own cases (negated model, Android 14 vs 15, stripped demo warning) were already fixed; the report was right about several things that were still open and are now fixed with tests: spaced/grouped phone numbers and street addresses not redacted (E17), prompt-injection text in imports (F05), a single failure able to flag a fix at `C_init` 0.75 (F08), silent embedding dimension mismatch (F16), device/version silently overwritten by a later message (E06), first-match playbook choice (E11), no view of requests before escalation (E16), editable case timeline (E40), localhost-only bind (E38), and no restore drill for the migration backup (F20). End-to-end browser testing also found and fixed a real UI bug (the device-confirmation form did not render for the conflict stage).

Items deliberately **left open** (and why) are listed in `FLAW-REGISTER-STATUS.md`: JSON-collection storage (E21), bot-granular staff access (E28), scheduling/time zones (E29/E30), external-job reconciliation (E31), scheduled ingestion (E32), a central route registry and `app.js` layering (E33), UI componentisation (E34), cohort-specific reliability (F26), analytics scale (F36) and a retention policy (F37).

Latest full run: `npm test` **193 tests, 193 passed, 0 failed** (~82 s). `demo`, `demo:multi`, `demo:learning`, `test:http` pass. Browser end-to-end (Chromium) re-run on a fresh database: demo (0 → 1 → User B → reset, tabs isolated, mobile layout), customer flows (learned-source banner, device-conflict form), owner console (dashboard, passport preview, open-requests table), data-source create → dry run → sync: no console errors and no server errors.

## Hardening follow-up (latest run)
Environment: Node v22.23.4, Linux, fresh `npm ci`. All figures are from synthetic data or synthetic load and say nothing about real customers.

**Verification:** `npm test` **232 tests, 232 passed, 0 failed** (~95 s). `demo`, `demo:multi`, `demo:learning` and `test:http` pass. Chromium end-to-end on fresh databases: the `/demo` chain, customer learned-fix and device-conflict flows, the owner console, open-requests table, data sources (including the new sync-interval field), the new specialist service-access panel, and the customer data download/erase controls: no console errors, no 5xx. (Running several browser scripts against one server trips the app's 5-sign-ups-per-hour rate limit; that is expected behaviour, not a defect.)

**Implemented in this round**
* Per-service staff permissions (Migration 6) with enforcement, owner API/UI, case release and audit.
* Scheduled data-source sync run by the worker, atomically claimed.
* Customer data export and erasure, plus optional (off by default) retention.
* Tenant-scoped, index-backed reads and writes. With 30,000 rows belonging to another company: chat 3,756 → 5.5 ms, create request 1,187 → 4.3 ms, customer workspace 1,017 → 4.5 ms, staff queue 552 → 3.0 ms, dashboard 80 → 1.9 ms.
* Typo-tolerant matching with a false-positive audit against ~25,000 common words, cue-based name redaction, and a tooling path to evaluate on your own data and a live embedding model.

**Retrieval on typo/slang wording** (written to be hard; 0 wrong or unsafe recommendations in every set): `informal` 14/30 before → 24/30 after (that set informed the matcher, so it is not clean); `informal2`, written afterwards and measured once, **25/30 (83%)**. The earlier sets are unchanged (regression 20/20, challenge 30/30, held-out 30/30, validation 27/30).

**A real bug found by the new work:** a stray “never” earlier in a sentence negated a later device mention (“the inbox never updates, Model WRONG firmware 99”), which hid a device mismatch and let a fix through. Negation now applies only to the mention it directly governs; covered by `rag-quality` and `audit-fixes` tests.

**Still not done / cannot be claimed**
* **No validation on real support text** and **no run against a live embedding model** — neither data nor credentials exist here. `node scripts/evaluate.js --file …` and `--embeddings` exist so you can run both; until then accuracy on real customers is unknown.
* **“Air tight” is not a claim this project can make.** Remaining known limits: tickets/conversations are still JSON records (hot paths are now scoped, but one very large tenant is still O(its own data) per request); bare personal names with no cue word cannot be detected; per-cohort reliability is not tracked; scheduling/time zones and external-job reconciliation are untouched; no central route registry or `app.js` layering; the PostgreSQL adapter and remote embeddings have only been tested with mocks. See `FLAW-REGISTER-STATUS.md`.
