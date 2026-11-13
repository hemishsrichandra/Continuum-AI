# Continuum AI architecture

Continuum has two deliberately separate modes. Nothing in the isolated demo shares state, code paths that touch storage, or network access with the main application.

```
Main application (authenticated, company-scoped)           Interactive Learning Demo (/demo)
  web/ (desk, operator, team)                                web/demo.html · demo.js · demo.css
  server/app.js  ── routes ──────────────────────────┐       server/demo-learning.js
  auth · companies · chatbots · troubleshooting      │         in-memory Map keyed by an unguessable
  learning · reuse · follow-through · intelligence   │         per-demo session id (X-Demo-Session)
  memory-pool (hybrid RAG) · data-sources · providers│         answered BEFORE auth, session, DB or
  SQLite (better-sqlite3), migrations 1–5            │         integration code; never receives the store
                                                     │         imports only pure helpers
                                                     └─ shared PURE modules: scoring · applicability · privacy · context
```

## Main application

### Unified company memory (Migration 5)
All reusable knowledge is a **Resolution Passport** row in `memory_pool`, always scoped by `company_id` **and** `chatbot_id`:

| Origin | Meaning | Customer-confirmed? |
| --- | --- | --- |
| `standard_playbook` | Owner-configured starting playbook, mirrored from the service configuration | no (company-configured) |
| `company_db_sync` | Imported from the company's own data source | no |
| `specialist_confirmed` | Specialist fix the original customer confirmed with “It worked” | **yes** |
| `auto_published_overdue` | Specialist fix published after the confirmation deadline | **no** — labelled `UNCONFIRMED BY CUSTOMER` |

Other tables: `memory_pool_fts` (FTS5, kept in sync by triggers; always joined back to the scoped table, never used as a security boundary), `follow_through_tasks`, `case_events` (case timeline), `company_data_sources` (connection secrets encrypted with AES-256-GCM), and a rebuilt `troubleshooting_attempts` with a `sequence` column so one ticket can hold up to three sequential suggestions. Versions form a lineage (`lineage_id`, `parent_version_id`, `version_number`); the previous row is marked `superseded` in the same transaction and never mutated.

### Scoring (`server/scoring.js`, unit-tested in `test/scoring.test.js`)
```
C_init       = 0.40·P_passport + 0.35·S_diag + 0.25·R_author
P_passport   = 0.25 each: symptoms, applicability, safety (blank is not evidence; "none identified" counts only after review), steps
S_diag       = matched / explicit conditions, 0 on any conflict, 0.5 when there are no conditions
R_author     = 0.85 declared-verified import · 0.75 new specialist · 0.5 unverified import · acceptance rate once ≥3 decided proposals
S_hybrid     = 0.65·max(0, cosine) + 0.35·NormBM25
NormBM25     = coverage · (−bm25 / best −bm25 among FTS hits)      (0 without a lexical hit)
W_reliability= (2·C_init + successes) / (2 + successes + failures)
S_final      = 0.55·S_hybrid + 0.25·S_compat + 0.20·W_reliability     retrieve only if S_final ≥ 0.70, at most 3
```
`S_compat` is 1.0 only when every required condition explicitly matches. Any conflict (negated or different model, wrong OS family or version, explicit range, safety restriction, hazard word) makes a candidate **ineligible regardless of score**; unknown required facts withhold the candidate and trigger a clarification.

**Embeddings.** The offline default is a *local hashed concept embedding* (`local-hashed-concepts-v2`): a concept map normalises synonyms (screen/monitor/panel/picture → `display`; flash/strobe/shimmer → `flicker`; "no sound" → `silent audio`, …), and shared concepts are weighted above incidental words and character n-grams. It is lexical-conceptual, **not** a neural semantic model, so wording outside the concept map scores weakly unless a remote embedding is configured. If `EMBEDDING_MODEL` and an OpenAI-compatible key are set, real embeddings are used, and any failure falls back to the local representation. Rows embedded by an older local version are re-embedded on first use.

**Gates around retrieval.** A pending fix is re-shown only if the *new message* still retrieves it through the same hybrid scoring and compatibility gate (the ticket text alone cannot make an unrelated message look relevant). A strong, compatible retrieval match also counts as in-scope when the customer's wording contains none of the service's topic words; otherwise the topic-word list still routes off-topic requests away.

**RAG quality evidence** (`test/rag-quality.test.js`, run with `npm run evaluate -- [--challenge|--holdout|--validation]`): recall floors plus absolute zero-tolerance checks (no wrong/unsafe recommendation, no memory-off leak, no repeated failed fix), 12 near-miss "hard negatives" with a positive control, cross-domain precision, determinism and legacy-embedding upgrade.

### Customer flow (`server/troubleshooting.js`)
Collect required diagnostic fields (per-service editable schema) → applicable standard playbook → explicit *It worked* / *Still need help* → eligible memory suggestion #1 → #2 → #3 → specialist. Failed fixes are never repeated for that customer; a standard playbook shown in the ticket is excluded from retrieval; refreshing never advances or repeats; silence is never success. Explicit human help and hazard/immediate topics bypass suggestions.

### Learning, follow-through and self-correction
* Proposals are scrubbed server-side (emails, phones, serials, IMEI, IPs, names) and secrets are rejected; `C_init` and its components are stored with the proposal.
* Customer **It worked** publishes immediately (`specialist_confirmed`). **Still need help** is a failure.
* At proposal time a `customer_confirmation_wait` task is persisted (default 24 h). The follow-through tick runs on the existing integrations worker (not per web request); each task is claimed with a conditional update and publication has a unique key, so retries/restarts/concurrent workers cannot double-publish. At the deadline with no response and `C_init ≥ 0.75` the fix is published as `auto_published_overdue`, unless a policy gate blocks it (high risk, dangerous instructions, redacted personal data, not privacy-reviewed, contradicted). Otherwise it is escalated. **The customer's case is never closed by auto-publication.**
* Reuse outcomes update `reuse_success_count`, `reuse_failure_count`, `consecutive_failures`. A fix is flagged for review at **2 consecutive failures or `W_reliability < 0.55`**; a single ordinary failure does not lock it out; a reported safety incident quarantines immediately.

### Data sources (`server/data-sources.js`)
`csv_sync`, `sqlite`, `rest_api`, `postgres`. Mapping → dry run → idempotent upsert keyed `import:<source>:<external id>`. Imports never overwrite locally reviewed, revised, flagged or failure-tracked records. SQLite: allowlisted directories, read-only, validated identifiers. REST: https + server-allowlisted origins, public DNS only, no redirects, size/time limits. Postgres needs the optional `pg` driver; unavailable integrations report *configuration-required* instead of faking success.

### Intelligence (`GET /api/companies/:companyId/intelligence`)
Owner/staff of that company only (tenant from the session). Reports customer-confirmed fixes, auto-published (unconfirmed) fixes separately, imports (not counted as learned), reuse outcomes by source, review flags, pending/overdue confirmations, SLA breaches and mean response times with sample sizes.

### Per-service staff access
Owners can restrict a specialist to particular services (`staff_chatbot_access`, Migration 6). With no rows a specialist keeps every service of their adapter (the old behaviour). Enforcement is in one place (`companies.mayUseBot`) and is used by workspace selection, the specialist queue, Resolution Intelligence and the assignable-staff roster. Narrowing access returns cases the specialist holds in a removed service to that service's queue and writes an audit record.

### Scheduled data-source sync
A source can carry `sync_interval_hours` (1–720). The worker tick calls `dataSources.runDue()`, which claims each due source with a conditional update that moves `next_sync_at` forward *before* syncing, so concurrent workers or a slow sync can never run a source twice. Failures are recorded on the source and retried at the next interval; local review decisions are preserved exactly as for manual syncs.

### Customer data controls and retention (`server/privacy-controls.js`)
`GET /api/privacy/export` returns the caller's own data in the workspace. `POST /api/privacy/erase` (optionally for one request) blanks the content of the customer's conversations and remembered context, clears the copies held in specialist case files, asks the remote memory service to invalidate remembered items (best effort) and unlinks shared knowledge from the erased request. Operational records (the request, status, appointments, specialist updates) are kept, and shared knowledge was already de-identified. Retention is **off by default**; `RETENTION_*` variables enable a worker-run sweep for archived conversations, finished follow-through tasks and old outbox jobs.

### Store access paths and scalability
Tickets, conversations and similar records still live in the JSON `records` store, but every hot path now avoids loading other tenants' data: `store.dataFor(companyId)` reads one company through expression indexes (`records_company`, `record_scope`), and `store.updateFor(companyId, change)` loads and writes only that company's slice and only the rows that changed. The full-store forms remain for cross-tenant background work. With 30,000 rows belonging to another company, request latency stayed at a few milliseconds (it was 0.5–3.7 s before); `test/scalability.test.js` enforces this and checks that scoped reads equal filtering the full store, that company ids sharing a prefix do not leak, and that scoped and full writes interleave safely. This is a mitigation, not a normalised schema: a single very large tenant is still O(that tenant's data) per request.

### Matching details worth knowing
* **Negation** applies only to the mention a negative word directly governs (“not a Model X”, “do not have a Model X”) and covers an adjacent attribute (“not Model X firmware 4”). A stray “never” earlier in a sentence no longer negates a later device (this previously could hide a device mismatch).
* **Typo tolerance** maps misspellings back to concepts with one edit (same first letter; last letter must match for short words; ambiguous matches are dropped; a curated vocabulary plus a blocklist for real words such as *internal* or *block*). `test/fixtures/fuzzy-neighbours.txt` is an audit of ~25,000 common words kept as a regression test: only intended inflections/typos may gain a concept.

## Isolated learning demo
See `DEMO_GUIDE.md`. `server/demo-learning.js` contains its own state and HTTP layer. `test/demo-isolation.test.js` enforces: only pure imports, no network calls, no main-database change (every table hashed before/after), no cross-session visibility, reset really clears.

## Migrations and safety
`Migration 5` is additive, transactional and idempotent; for file databases it first copies the database to `<file>.pre-v5.bak` (restore by copying it back while the app is stopped). Backfill creates passports for standard playbooks and published specialist resolutions with stable source keys, preserving company/service scope and prior outcome counts.
