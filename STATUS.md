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

## SQLite + ChromaDB hybrid RAG upgrade and audit fixes (latest)

Branch `feature/chroma-hybrid-rag`. Environment: Windows 11, Node 24.13, ChromaDB 1.5.9 (pip) with JS client 3.5.0; `better-sqlite3` raised to `^12` so it installs on Node 24. Full detail: [UPGRADE-AUDIT.md](UPGRADE-AUDIT.md), [SEMANTIC-SEARCH.md](SEMANTIC-SEARCH.md).

**Verification (final run):** `npm test` **272 tests, 271 passed, 0 failed, 1 skipped** (the symlink test needs Windows Developer Mode). `npm run demo`, `demo:multi`, `demo:learning` and `test:http` pass. A live test against a real ChromaDB server passes (`npm run test:chroma`; it skips itself when no server is reachable). One manual browser pass of the owner console, mobile width and the demo (see UPGRADE-AUDIT.md).

**Implemented:** ChromaDB vector index with durable, idempotent indexing from SQLite (triggers + worker, reconcile, reindex, per-model collections, SQLite-only fallback); hybrid retrieval with indexed device facets and adaptive widening; embedding service with a privacy boundary; central privacy sanitizer; safety-restriction fix; per-version verification; approval gating for imports and authoritative-snapshot reconciliation; DNS-pinned REST and allowlisted, TLS, read-only PostgreSQL connectors; durable retried erasure tasks; assigned-case SLA milestones; independent worker lanes; demo attribution and session fixes; owner Status panel.

**Measured (synthetic, same offline embedding for all systems; table in UPGRADE-AUDIT.md):** recall@3 about 0.91-0.97 for the original and the SQLite-only upgrade at 100 / 1,000 / 10,000 fixes, 0.95-0.99 with ChromaDB, zero wrong-device recommendations. At 10,000 fixes the SQLite-only path took roughly a third of the original's median time; the ChromaDB path was not faster. Timings are noisy.

**Still not done / cannot be claimed**
* No neural embedding model was run (none configured): paraphrase quality is still that of the offline concept list. No live Hindsight, email, Google or PostgreSQL server was available, so those paths are covered only by mocks and failure-path tests.
* `docker-compose.yml` has not been run (Docker is not installed here); the same ChromaDB version was run through pip.
* Deferred: splitting `server/app.js` and replacing JSON collections (item 20), a per-company SLA editor, demo-session persistence.
* Windows-only: `npm test` uses `test/setup-windows-cleanup.js` to ignore file-lock errors when deleting temp folders.

## UI redesign (branch `feature/ui-redesign`)

Dark-first design with a light theme, glass surfaces, and 3D used only where it explains something. Rough reference mock: `design-preview/index.html`.

**What changed**
* **Design system:** `web/theme.css` defines tokens for both themes. The legacy stylesheets (`styles.css`, `demo.css`) had their ~300 hard-coded colours converted to those tokens, so every screen follows the theme. `theme-init.js` applies the saved theme before first paint; the toggle sits in the navigation.
* **Home:** a Three.js "memory constellation" hero (lazy-loaded, paused off-screen, static frame for reduced motion, removed if WebGL is missing), a tilting product preview, a pinned four-step scroll story, tilt cards. Three.js is MIT-licensed and served from this site (`/vendor/…`) because the security policy only allows scripts from this origin.
* **Navigation:** Home, Product, How it works, Pricing, Demo, plus Sign in and Try the demo. The style guide is no longer linked.
* **Sign-in:** a split screen with three modes (Sign in / Join a team / Create a company) and one secondary link; "Schema adapter" became "Type of support".
* **Customer workspace:** removed the "Memory lab" tab and the "Confirmed actions" / "Helpful responses" tiles; "Request a specialist" became "Talk to a person"; data and privacy controls sit behind one disclosure.
* **Owner console:** a sidebar (Overview, Cases, Knowledge) instead of one long page; Knowledge has In use / Needs you / Older versions filters; plain-language labels; the data-source form is a four-step wizard and exposes the new "complete snapshot" option.
* **Demo:** shared navigation, the constellation behind the headline, glowing progress steps.

**Verified:** `npm test` 272 tests, 271 passed, 0 failed, 1 skipped; `npm run test:http` passes with the new assets. axe (WCAG A/AA) reported **0 violations** on Home, Product, How it works, Pricing, Team and the console's Overview, Cases and Knowledge in dark, and on Pricing and all three console sections in light. Axe found four real contrast problems, which were fixed; the light-theme Home page had one of them (step numbers) and was **not re-scanned** after the fix. No horizontal overflow at 375 px on Home, Pricing, the console and the demo. The guided demo still runs end to end.

**Not verified / limits:** axe was run on Home (scrolled through every section, both themes), the sign-in screen and the customer workspace in both themes and reported 0 violations once animations had settled (a scan taken 150 ms after switching theme caught colours mid-transition; that is a measurement artefact, and the one real finding, story steps dimmed with opacity, is fixed). Other pages were scanned in earlier rounds, not re-scanned here; this is not screen-reader or cross-browser certification. the Cases and Knowledge sections were not exercised with many cases; there is no automated browser test (all UI checks were manual); WebGL performance on low-end devices was not measured; the 3D scene adds about 175 KB gzipped of JavaScript, loaded only on Home and Demo.

## Latest audit fixes (branch `feature/audit-fixes-final`)

Built on the UI redesign and the SQLite + ChromaDB work. Details and the F-01 to F-08 table: [UPGRADE-AUDIT.md](UPGRADE-AUDIT.md). Privacy policy: [PRIVACY.md](PRIVACY.md).

**Fixed (with regression tests):** private-address bypass in the IP validator (F-01); personal data in passport evidence and provenance (F-02); stale vector-index worker overwriting newer state (F-03); applicability and safety edits not triggering reindexing (F-04); embedding responses mapped by order (F-05). The live verification also found and fixed a privacy gap in single-request erasure.

**Verification:** run on a clean clone with `npm ci`: `npm test` **303 tests: 302 pass, 1 skipped (a Windows symlink case), 0 fail**; live ChromaDB test, demos and HTTP check pass; `npm run verify:chroma` 10/10 on a real ChromaDB including a real outage and, after a real server restart, persisted vectors; two real worker processes (one killed mid-job) leave a consistent index.

**Measured, and not as good as earlier numbers suggested:** the default offline embedding scores recall@3 of about 0.03-0.09 on a held-out paraphrase set (the earlier ~0.9 figures used in-vocabulary paraphrases). It never recommended anything unsafe (0/18). The neural comparison is **blocked** (the configured endpoint, Groq, has no embeddings API), so no neural default has been chosen.

**Not done:** neural embedding comparison; `docker-compose.yml` run; splitting `app.js` (F-08, deferred); an automated browser test suite (axe scans are manual and dev-only).

## UI round 2: company hub, desk, operator and public pages

Driven by a written critique of the first redesign. What changed:

* **Company workspace (`/team`)** is five tabs (Overview, Team & access, AI services, Knowledge, Connections) instead of one long page. Owners no longer type JSON: topics and escalation words are tags, diagnostic questions are rows, playbooks are editable cards, gateway field mapping is labelled inputs, and data-source field matching is rows. Sync and dry-run results show as badges, the list of server-supported connection types is tucked into a collapsed section, and revoking access or removing a source asks first. Copy buttons for signup and invitation links.
* **Customer desk:** "It worked" is green, "Still need help" neutral, "Talk to a person" a separate ghost button. The specialist-confirmation prompt sits above the message box instead of pushing the conversation down. Model, latency and recall counts are shown only for demo accounts or with `?details=1`. Account actions are one menu with a role badge; on phones the request list is a short vertical list.
* **Operator:** Approve and Retire are two explicit buttons (no dropdown); unassigned cases show "Take this case"; the overview leads with what needs attention and folds the other figures away.
* **Public pages:** the hero constellation is larger and turns about 2.4x faster, to match the approved design; the four-step "watch a fix teach the system" animation is a section on Home and the same connected-node style marks progress in the demo. Real icons replace glyph characters, pricing has a segmented billing toggle and a ring on the featured plan, booking time slots look selectable, and the secondary call-to-action button is readable in light theme (it was white on white).

**Checked:** `npm test` 303 tests, 302 pass, 1 skipped; `npm run test:http` passes. axe (WCAG 2.x A/AA) reported 0 violations on all five `/team` tabs, the customer desk and operator overview, pricing, booking and about in both themes, and on Home once animations settled. One transient contrast flag appears on a decorative, aria-hidden story card while it is mid-fade; it passes at full opacity. No horizontal overflow on `/team` at 390 px.

**Not done from the critique (needs backend work or a larger rebuild):** reinstate a revoked member, resend an invitation, let a customer defer confirming a specialist fix, flag a case urgent or request an owner review, a master-detail case view replacing the nested accordions, redrawing the simulated screens inside the demo to match the real app, a sign-in screen that separates owner from customer demo accounts, and skeleton loading for booking slots. The new editors were exercised in a real browser (a service saved and reloaded unchanged) but the data-source wizard dialog and the Approve/Retire buttons were not clicked through end to end, and there is no automated browser test for any of this.

## Colour palette: Oxblood & Parchment

The cobalt palette was replaced by **Oxblood & Parchment** after a side-by-side preview (`design-preview/palettes.html`). Two colours do most of the work and one accent gets about a tenth.

* **Dark ("Medium wine"):** page `#150A0F`, cards `#2C1620`, raised `#42242F`, parchment text `#F5ECDF`, accent pale mint `#B8F2D0` (primary buttons and confirmed states, with dark green text).
* **Light:** page parchment `#F3E9DC`, surfaces `#FBF4EA` / `#E8DACA`, oxblood text `#2B0F16`. The primary button is oxblood with mint text, and wine `#7A1E33` is used for accent text.
* Solid surfaces replace the see-through glass. The hero word is a plain accent colour (no gradient). Customer chat bubbles invert (parchment on oxblood, or the reverse). The most urgent stat card and the closing band invert too, and the 3D sphere uses parchment or oxblood nodes with mint or wine hot nodes. Browser chrome colours and the style-guide swatches follow.

**App shell fix:** the company, desk and operator pages used a shell rule that painted the whole page in the raised layer colour, which in dark mode made every card darker than the page and the screen one red wash. The page is now the darkest layer, borders are neutral parchment, headings are parchment instead of mint, and leftover blue values in the old stylesheet (selected rows, composer button, focus outlines, dialog backdrop, timeline dots) now use the palette.

Checked with axe (WCAG 2.x A/AA) in both themes: Home (five scroll positions), Product, About, Pricing, Booking, sign-in, the five company tabs, operator Overview, Cases and Knowledge, and the customer desk, all with 0 violations once animations had settled. Scans taken mid-fade or just after a theme switch can flag the decorative story cards and other transitioning colours; each of those passed when re-checked at full opacity. Not checked on real devices or with a screen reader.

## Backend and workflow items from the UI critique

Added, each with server tests (`test/members-invites.test.js`, `test/defer-and-flag.test.js`, `test/demo-signin-hints.test.js`):

* **Reinstate a revoked member** (`POST /api/company/reinstate-membership`, owner only). A member comes back as a customer by default; a former specialist may come back as a specialist only if they were one. Nobody can be reinstated as owner, and a customer cannot be promoted this way. Shown as buttons on the Team tab.
* **Resend an invitation** (`POST /api/company/invitations/resend`, owner only). The old link is removed the moment the new 48-hour link exists, the role and support type are kept, and a used invitation cannot be resent. A "Pending invitations" table shows open and expired invitations.
* **"I'll check and confirm later"** (`POST /api/resolutions/defer`, customer only). Moves the confirmation deadline by one confirmation window, at most twice (so at most two extra days). Only the customer's explicit request moves it; silence is still never treated as success, and after the extended deadline the usual rules apply. The desk shows the new date.
* **Flag urgent / request owner review** (`POST /api/operator/flag`). Urgent sets the request's priority to Urgent and restores the previous priority when removed. An owner review carries a note that is visible to the company team only (it is stripped from what customers receive, and credential-like text is refused); only an owner can close it. Owners see a "Needs your review" panel on the console overview.
* **Operator cases are a master-detail view**: a sortable list (urgent and owner-review cases first) beside one case, with Conversation, Update progress and Propose a solution as tabs instead of nested accordions.
* **Sign-in groups demo accounts** into "Company owner" and "Customer" when a local demo opts in with `DEMO_SIGNIN_HINTS` (set by `npm run demo:multi -- --serve`); never in production.
* **Booking slots load as placeholders**, and the demo's simulated screens use the same bubbles, buttons and window frame as the real workspace.

Checked in a real browser against the local demo: invite, resend, revoke and reinstate; flag urgent and assign a case in the new case view; sign-in with the owner group. axe reported 0 violations on the case view, the Team tab and booking in both themes. **Also checked in a browser afterwards** (against a local database seeded with a pending specialist proposal): the desk's "I'll check and confirm later" button (deadline moved, button and note shown), a specialist requesting an owner review through the dialog, the owner's "Needs your review" panel and closing the review, the redrawn demo screens through the guided scenario, and the desk in both themes with axe (0 violations). The production switch for sign-in hints is covered by a test of `demoSignInHints`. Not done: emailing invitations (links are copied by the owner, as before) and any backend fixes beyond the items above.

## Home journey

The four-step "Watch a fix teach the system" animation now loops continuously while it is on screen (it holds on the last step, resets, and repeats) and pauses when scrolled away or the tab is hidden. There is no Play or Replay button and no "fictional data" tag on that section. With reduced motion it shows the finished journey and does not animate.

## V3 round: what changed and what is still open

Full table: [V3-LEDGER.md](V3-LEDGER.md). In short:

* **Done and tested:** specialists no longer type "Matching symptoms" (the server derives the searchable text from the customer's own issue); one-click claim and release with an owner dispatch list; natural device names with the safe generic partial match and its exact advisory; marketing copy that no longer overclaims; sign-in demo hints that need an explicit local `NODE_ENV`.
* **Partly done:** up to three suggestions together (the best plus up to two previews the customer can choose instead, plus the outcomes not applicable, unable to try and human requested); batched, resumable sync for SQLite and PostgreSQL (CSV and REST are still bounded single reads).
* **Not done:** the optional query normalizer, a connection-test button and the source edit / pause screens, Linux and bare category words as devices, automated browser tests.
* **Measured** (synthetic SQLite source, this machine): 1,000 records in about 1 s and 10,000 in about 10 s, with peak process memory of 90 MB and 183 MB. Retrieval without ChromaDB took about 13 ms at 1,000 records and about 340 ms at 10,000.
