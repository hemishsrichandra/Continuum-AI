# Upgrade audit: SQLite + ChromaDB hybrid RAG and the 21 audit items

Branch: `feature/chroma-hybrid-rag` (off `main`); `git checkout main` returns to the previous code.
Everything below was run on Windows 11, Node 24.13, ChromaDB server 1.5.9 (pip) with JS client 3.5.0. All data is synthetic.

## Result of the 21 items

| # | Item | Status | Evidence / what to know |
| --- | --- | --- | --- |
| 1 | Safety restriction bypass (empty `keywords`) | **FIXED** | Keywords and trigger terms are derived from the restriction text, not only from author input; legacy rows are covered at evaluation time. A restriction no machine can evaluate now blocks the fix until a specialist rewrites it. `hybrid-rag` test 1 |
| 2 | Personal data in imported diagnostics | **FIXED** | Personal-data field names are rejected; nested values are scrubbed. `knowledge-integrity` |
| 3 | Personal data in revised passports | **FIXED** | Every passport insert (imports, revisions, auto-published, specialist) passes the recursive sanitizer in `insertPassport`; credential-shaped content is rejected. `hybrid-rag` test 2 |
| 4 | Demo credits User A wrongly | **FIXED** | Each learned fix stores its originating and confirming user; every label and timeline line is derived from it. `demo-attribution` |
| 5 | Withdrawn external records stay active | **FIXED** | Only a *complete* snapshot from a source the owner marked authoritative may retire records; partial, empty, failed or mostly-invalid reads never do. Retired records leave the index. `knowledge-integrity` |
| 6 | Unverified imports become active | **FIXED** | Imports wait in the existing `flagged_for_review` status until approved; declared-verified sources are indexed at once. New verification states: `import_pending_review`, `imported_approved`. |
| 7 | Revision inherits verification | **FIXED** | Verification is derived per version (`verificationOf`); customer-facing labels no longer say "customer-confirmed" for a revision. `knowledge-integrity` |
| 8 | Full memory-pool scan per query | **FIXED** (with a limit) | Bounded FTS5 + vector candidates, adaptive widening. Without ChromaDB, pools ≤ 300 are still compared in full (stored vectors) and larger pools use FTS candidates only. See benchmark. |
| 9 | Raw queries sent to external embedding services | **FIXED** | Text passes the privacy scrubber first; credential-like text is never sent. `hybrid-rag` test 3 |
| 10 | Embedding cache discards vectors | **FIXED** | Document vectors persist (ChromaDB and the SQLite blob); queries use a bounded LRU; nothing clears the cache wholesale; unchanged content is never re-embedded. |
| 11 | DNS rebinding on REST sources | **FIXED** (unit-level evidence) | Resolve once, validate every address, connect to that address, verify TLS against the original host, no redirects, size/time caps. Tested with an injected socket layer; **not tested against a real rebinding DNS server**. |
| 12 | PostgreSQL destination restrictions | **FIXED** | Host and port allowlists, public-address check, TLS required, discrete driver settings (no raw connection string, unknown options refused), read-only session, bounded waits. |
| 13 | Incomplete erasure | **MITIGATED** | Now also covers diagnostic context, per-attempt context, audit copies, cached operation responses and closed-case summaries, and can withdraw fixes learned from the request. Retained on purpose and **stated to the customer**: request records, appointments, specialist updates, the summary of a still-open case. Not a claim of total deletion. |
| 14 | Best-effort remote deletion | **FIXED** (retry) / **BLOCKED** (verification) | Durable, idempotent, retried tasks visible to owners. The memory service has no read-back call, so completion cannot be verified remotely. Tested with a stub; the live Hindsight service was not available. |
| 15 | Overdue auto-publication | **ALREADY FIXED** (race) + **hardened** | The customer's answer and the worker already ran in atomic transactions; a 6-iteration concurrent test confirms the invariant. Added blockers for unresolved safety, missing applicability and credential-like content. |
| 16 | Worker blocking | **FIXED** | Each task is its own lane with timeout, backoff and status. A stuck task still occupies *its own* lane until it settles (JavaScript cannot cancel it). `hybrid-rag` test 20 |
| 17 | SLA only covers unassigned cases | **FIXED** | First response, specialist inactivity, follow-up and resolution milestones, one escalation per reason, waiting-on-customer excluded. Policy is per deployment (env); a per-company editor is **DEFERRED**. |
| 18 | Demo sessions in memory | **MITIGATED** | No silent eviction (a full demo refuses new sessions), consistent expiry, per-session reset. Sessions are still lost on restart (clear message); persistence **DEFERRED** to keep the demo simple and dependency-free. |
| 19 | PostgreSQL driver | **PARTIAL** | `pg` is now an optional dependency; connection set-up and failure paths run against the real driver. A successful query against a live PostgreSQL server was **not tested** (none available); query construction is covered by the mock driver. |
| 20 | Architectural coupling | **DEFERRED** (mostly) | New code is layered (`vector-store`, `vector-index`, `embedding-service`, `net-guard`, `privacy-sanitizer`, `system-health`), but `app.js` is still the large controller, collections are still JSON records and the repair/IT assumptions remain. Rewriting these was judged riskier than the value for this upgrade. |
| 21 | Production verification | **PARTIAL** | Final run: `npm test` 272 tests, 271 passed, 0 failed, 1 skipped (a symlink test Windows cannot run without Developer Mode); `demo`, `demo:multi`, `demo:learning`, `test:http` pass; a live ChromaDB test passes. Browser pass (below). Not a production-readiness claim: no live email, Google, Hindsight, PostgreSQL or embedding-model credentials were exercised. |

## Retrieval benchmark (measured, synthetic)

Generated by `npm run benchmark` on 2026-11-13 (Windows 11, Node 24, ChromaDB 1.5.9 on localhost). All three systems use the **same offline embedding** (`local-hashed-concepts-v2`, not a neural model) and the same data: 150 paraphrased queries naming one specific device per pool size, plus up to 50 queries for devices that have no stored fix. "Original" is a port of the previous retriever (full scan of every passport per query).

| Fixes | System | Recall@3 | Precision@3 | Wrong-device rate | False recommendation (no fix exists) | Median ms | p95 ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | original (full scan) | 0.97 | 1 | 0 | 0 | 14.37 | 16.54 |
| 100 | upgraded, SQLite only | 0.97 | 1 | 0 | 0 | 15.61 | 17.66 |
| 100 | upgraded + ChromaDB | 0.99 | 1 | 0 | 0 | 19.86 | 64.35 |
| 1,000 | original (full scan) | 0.907 | 1 | 0 | 0 | 53.3 | 74.73 |
| 1,000 | upgraded, SQLite only | 0.907 | 1 | 0 | 0 | 7.31 | 43.3 |
| 1,000 | upgraded + ChromaDB | 0.953 | 1 | 0 | 0 | 69.71 | 249.48 |
| 10,000 | original (full scan) | 0.913 | 1 | 0 | 0 | 405.25 | 1332.09 |
| 10,000 | upgraded, SQLite only | 0.913 | 1 | 0 | 0 | 124.1 | 205.59 |
| 10,000 | upgraded + ChromaDB | 0.967 | 1 | 0 | 0 | 322.66 | 454.75 |

Indexing (ChromaDB, local embeddings):

| Fixes | Documents indexed | Seconds | Documents/s | Failed | Embedding API calls |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 109 | 0.47 | 232.7 | 0 | 0 |
| 1,000 | 1009 | 3.77 | 268 | 0 | 0 |
| 10,000 | 10009 | 33.07 | 302.7 | 0 | 0 |

How to read this honestly:

* **Scope of these numbers:** they use paraphrases within the offline model's vocabulary. On a harder held-out set the offline embedding scores recall@3 of only about 0.03-0.09 (see [SEMANTIC-SEARCH.md](SEMANTIC-SEARCH.md)); treat the figures below as a comparison of architectures, not of semantic quality.
* **Quality:** the upgraded retriever matches the original at every size (recall@3 about 0.91-0.97) and ChromaDB adds a few points (0.95-0.99). No system ever recommended a fix for the wrong device or invented a fix when none existed. The misses shared by all three (about 3-9%) are paraphrases the offline concept list does not cover; a neural embedding model is the way to improve those, and **none was available to measure**.
* **Speed:** at 100 fixes the original full scan is as fast as anything else. The advantage appears with scale: at 10,000 the SQLite-only path takes roughly a third of the original's median time. The ChromaDB path is **not** the fastest here: it adds a network round trip and a second scoring query per request, so at these sizes its benefit is recall and bounded work, not latency.
* **Noise:** timings come from one machine under normal load and varied noticeably between runs (the original's 10,000-fix median ranged from about 0.4 s to 1.3 s across repeated runs). Treat them as order-of-magnitude.
* **A problem this benchmark found and that was fixed:** with 1,000 near-identical fixes per topic that differ only by device, the first version reached recall@3 of 0.27 at 10,000 fixes, because text search cannot tell the devices apart and a fixed candidate cap cannot reach them all. Fixes are now found through indexed device facets, scored fairly, and retrieval only widens when nothing compatible was found.
* **Not measured:** failure recovery timing (covered by tests, not benchmarked) and embedding-API usage (the offline model makes no API calls).

## Behaviour changes to be aware of

* Imported records from a source that is **not** declared verified are now paused until approved (previously active immediately).
* A free-text safety restriction with no hazard word, condition or "if/when…" clause blocks its fix until rewritten.
* PostgreSQL sources need `DATA_SOURCE_POSTGRES_HOSTS`; TLS is required.
* Customer-facing source labels for revised fixes now say "not yet confirmed by a customer".
* `npm test` runs with `test/setup-windows-cleanup.js`, which only tolerates Windows file-lock errors when deleting temp folders.

## What changed

New: `server/{privacy-sanitizer,embedding-service,vector-store,vector-index,net-guard,system-health}.js`, `scripts/{vector-admin,benchmark-rag}.js`, `docker-compose.yml`, `SEMANTIC-SEARCH.md`, and eight test files.
Modified: `passports, memory-pool, scoring, data-sources, privacy-controls, follow-through, integrations, demo-learning, database (migration 7), troubleshooting, app` and the owner console (`web/operator.js`, `web/styles.css`, `web/demo.js`).
Dependencies: `chromadb@3.5.0`, `pg@8.20.0` (optional); `better-sqlite3` raised to `^12` so it installs on Node 24.
Migration 7 (additive, idempotent): `vector_index_state` + triggers, `erasure_tasks`, `sla_events`, import-tracking columns on `memory_pool`, snapshot columns on `company_data_sources`.

## Browser check (manual, one pass)

Owner console on a throwaway database with ChromaDB enabled and no external keys: the Status panel showed *Ready / 1 fix waiting for approval / All running*; a revised fix showed "Updated by a specialist, not yet confirmed by a customer" beside its older confirmed version; an imported fix showed "Customers will not see it until you approve it", and approving it through the form changed it to "Imported, approved by your team" and cleared the waiting count; no horizontal overflow at 375 px; the isolated demo ran User A -> specialist -> User B and reported "User A taught Continuum -> verified demo memory created -> User B benefited". The only console errors were pre-sign-in 401 session probes. This was manual: there is no automated browser test.

## Latest independent audit round (F-01 to F-08)

Branch `feature/audit-fixes-final` (UI redesign and the RAG upgrade included). Each fix was reproduced first, then fixed, then covered by a regression test. The audit's own test file was not available, so the regressions were written from the findings.

| # | Finding | Status | Changed files | Test evidence | Remaining risk |
| --- | --- | --- | --- | --- | --- |
| F-01 | IPv4-mapped IPv6 (hex spellings) passed the private-address check | **fixed** | `server/net-guard.js` | `test/net-guard.test.js`: ~50 blocked spellings (mapped, NAT64, 6to4, fe80::/10, documentation ranges), public addresses still allowed, DNS answers and PostgreSQL hosts checked. Reproduction showed it was broader than reported (`::ffff:a9fe:a9fe`, `fe90::`, NAT64, 6to4 all passed) | Egress filtering at the network level is a deployment responsibility; no real rebinding DNS server was used |
| F-02 | Evidence and provenance bypassed PII sanitisation | **fixed** | `privacy-sanitizer.js`, `passports.js`, `memory-pool.js`, `data-sources.js`, `database.js` (migration 8) | `test/receipt-privacy.test.js`: allow-list schema on write, read and migration; tokens/JWT/bearer rejected; review notes scrubbed; legitimate receipts and confidence scores preserved (the tests exposed that `P_passport` was being redacted as a "passport number"; fixed) | Bare names and serial numbers cannot be detected; the company's own external record ids are kept as identifiers |
| F-03 | Stale vector worker could mark an outdated job indexed | **fixed** | `vector-index.js`, `database.js` (migration 9), `vector-store.js` | `test/index-integrity.test.js` (retire and revise during embedding, expired lease, duplicate delivery, late stale write, retry) and `test/multi-process-index.test.js` (two real OS processes, one killed mid-job) | ChromaDB has no conditional write, so a late stale write is repaired by re-queueing (a short window of eventual consistency), not prevented |
| F-04 | Applicability/safety edits did not trigger reindexing | **fixed** | `database.js` (migration 9 triggers), `vector-index.js`, `memory-pool.js` | `test/index-integrity.test.js`: applicability-only, safety-only, trust-only, origin, version and non-index columns; device facets rebuilt; reconciliation compares document hashes | Facet repair happens at the next retrieval or worker pass, not instantly |
| F-05 | Embedding responses mapped by array order | **fixed** | `server/embedding-service.js` | `test/embedding-order.test.js`: reversed, shuffled, duplicate, out-of-range, missing, extra, NaN, wrong size, wrong model | Providers that omit `index` are refused unless `EMBEDDING_ALLOW_UNINDEXED=true` |
| F-06 | Real-stack verification | **verified** (with gaps) | `scripts/verify-chroma-live.js`, tests | Clean clone: `npm ci` ok; `npm test` **303 tests: 302 pass, 1 skipped (a Windows symlink case), 0 fail**; `npm run test:chroma`, `demo`, `demo:multi`, `demo:learning`, `test:http` pass; `npm run verify:chroma` 10/10 against a real ChromaDB (publish, revise, retire, erase, real outage via a TCP proxy, tenant isolation, reconciliation, app restart, migrations) and, after really restarting the ChromaDB server, the vectors persisted (phase b). The live scenarios found one real defect (single-request erasure left a customer-wide preference; fixed) | `docker-compose.yml` still not run (no Docker here); everything ran on one Windows machine |
| F-07 | Semantic quality and claims | **measured, neural BLOCKED** | `scripts/benchmark-semantic.js`, `evaluation/semantic-*` | Offline embedding recall@3 0.03-0.09 on held-out paraphrases, 0 unsafe recommendations; claims in the docs corrected | No neural number: the only configured endpoint (Groq) has no embeddings API. Defaults unchanged until that is run |
| F-08 | Architectural coupling | **deferred** | none | n/a | `app.js` is still large and collections are JSON records. Splitting them would not fix any reproduced defect and risks regressions; revisit when a boundary is changed anyway |

Also done: `PRIVACY.md` (what is deleted, kept and why), a skewed-tenant test (a 3,000-passport company does not slow or leak into a small one), a mixed-quality import test (duplicates, blanks, personal data, secrets, risky and injection text), and the earlier UI redesign (accessibility scans listed in STATUS.md).
