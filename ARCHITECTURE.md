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

**Embeddings.** The offline default is a *local hashed concept embedding* (concept-normalised tokens + bigrams + character 4-grams). It is lexical-conceptual, not a neural semantic model, and is labelled `local-hashed-concepts-v1`. If `EMBEDDING_MODEL` and an OpenAI-compatible key are configured, real embeddings are used and any failure falls back to the local representation.

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

## Isolated learning demo
See `DEMO_GUIDE.md`. `server/demo-learning.js` contains its own state and HTTP layer. `test/demo-isolation.test.js` enforces: only pure imports, no network calls, no main-database change (every table hashed before/after), no cross-session visibility, reset really clears.

## Migrations and safety
`Migration 5` is additive, transactional and idempotent; for file databases it first copies the database to `<file>.pre-v5.bak` (restore by copying it back while the app is stopped). Backfill creates passports for standard playbooks and published specialist resolutions with stable source keys, preserving company/service scope and prior outcome counts.
