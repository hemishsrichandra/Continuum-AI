# Semantic search: SQLite + ChromaDB hybrid retrieval

SQLite remains the **source of truth**. ChromaDB is a **rebuildable index** that makes the semantic half of retrieval fast. If ChromaDB is missing, down or wiped, Continuum keeps answering from SQLite and rebuilds the index when it returns.

```
Customer message
   │  sign-in, company and service scope, diagnostics, privacy scrub
   ├─ SQLite FTS5  ──► top-K keyword candidates ┐
   └─ ChromaDB     ──► top-K semantic candidates ┤  merge
                                                 ▼
                    re-read every candidate from SQLite
                    (company, service, status, origin gates)
                                                 ▼
                    safety + compatibility gates  (similarity can never override)
                                                 ▼
                    hybrid score → reliability → top 3 → customer feedback
```

## What lives where

| Data | SQLite | ChromaDB |
| --- | --- | --- |
| Accounts, tickets, conversations, passports, versions, evidence, feedback, publication status | **authoritative** | never |
| Vector of each *active* passport, plus company/service/origin/version/hash metadata | the embedding blob is kept for the offline fallback | **index only** |
| Customer text, names, ticket ids | yes | **never** (only de-identified shared fixes are indexed) |

ChromaDB cannot make a fix recommendable: a returned id is accepted only if SQLite still shows it as `active`, in the right company and service.

## Setup

1. Start ChromaDB (pick one):
   - `docker compose up -d chroma` (the compose file has **not** been run where it was written: Docker was not installed there), or
   - `pip install chromadb==1.5.9` then `npm run chroma:start` (this is how it was verified).
2. In `.env`: `VECTOR_STORE=chroma` and `CHROMA_URL=http://127.0.0.1:8000`.
3. Start Continuum (`npm start`). The first run queues every active fix; the background worker indexes them (or run `npm run index -- drain`).
4. Check `npm run index -- health`, or the **Status** panel in the owner console.

Without `CHROMA_URL`, nothing connects anywhere: Continuum runs in *basic mode* on SQLite.

### Embeddings

| `EMBEDDING_PROVIDER` | What it is |
| --- | --- |
| `local` (default) | Offline hashed-concept vectors. Fast and private, but **not a neural model**: paraphrases outside its concept list can be missed. |
| OpenAI-compatible (`EMBEDDING_MODEL` + `OPENAI_API_KEY`) | A real semantic model. Documents are embedded once by the indexing worker; only the customer's query is embedded at request time (small bounded cache). Text is passed through the privacy scrubber first, and a credential-like text is never sent. |

**Changing the model** is safe: every model has its own collection (`<namespace>_knowledge_<model>_<hash>`), so vectors from different models are never compared. Run `npm run index -- reindex` to fill the new collection; the old one can be deleted afterwards.

## Keeping SQLite and ChromaDB consistent

The two cannot share a transaction, so indexing is a persistent *desired state* loop:

* Database triggers (migration 7) mark a passport `pending` whenever it is created, edited, superseded, retired, flagged, deleted, moved, or unflagged, from any code path.
* The worker reads the **current SQLite row** and makes the index match: only `active` knowledge is indexed; anything else is removed.
* Upserts use the passport id, so retries and duplicates cannot create a second vector.
* Unchanged content (same text, same model) is never embedded again.
* A failing ChromaDB leaves the SQLite change committed; the job retries with backoff (30 s doubling to 1 h) and is shown as *failed* after 8 attempts until someone retries it (`npm run index -- retry-failed` or **Try again** in the owner console). Nothing is reported as indexed before ChromaDB acknowledged it.
* Knowledge the index has not caught up with yet is still searched, directly from SQLite, so a lagging index never hides new fixes.
* `npm run index -- reconcile` removes vectors that should not exist and re-queues active fixes that are missing.

## Retrieval details

* **Candidates:** top `LEXICAL_TOP_K` (20) from FTS5 plus top `VECTOR_TOP_K` (20) from ChromaDB, merged.
* **Adaptive widening:** fixes that differ only by device or version look identical to text search, so a fixed top-K can fill up with relevant-but-incompatible candidates. When a pass is full *and* turned away relevant fixes on compatibility, retrieval widens (×4, then ×16, capped by `CANDIDATE_CAP`, default 400) before giving up. It does not widen otherwise.
* **Score:** the original `0.65·semantic + 0.35·keyword` formula is unchanged. BM25 is already bounded to [0,1] by its own normalisation, so the two terms are comparable; Reciprocal Rank Fusion was considered but not adopted because no measurement here showed the current formula to be the problem.
* **Fallback without ChromaDB:** pools up to `SQLITE_SCAN_LIMIT` (300) are compared in full using stored vectors (nothing is re-embedded per query); larger pools use the FTS candidates only. This is a recall trade-off, measured in `evaluation/benchmark-results.json`.
* **Hard gates run first:** safety restrictions, applicability conditions, unknown mandatory facts, company and service scope. A high similarity can never override them.

## How good is the semantic search? (measured, and what is NOT measured)

`npm run benchmark:semantic` compares three systems on one held-out set (16 fixes, 32 customer paraphrases written to avoid the fixes' own words, and 18 queries where **nothing** may be recommended: wrong device, safety restriction hit, unrelated). Run on 2026-11-13:

| System | Recall@3 | Recommended where forbidden | Median ms | p95 ms | Embedding |
| --- | ---: | ---: | ---: | ---: | --- |
| A. SQLite only | 0.094 | 0/18 | 3.4 | 4.4 | local-hashed-concepts-v2 (offline, not neural) |
| B. Chroma + local vectors | 0.031 | 0/18 | 6.8 | 8 | local-hashed-concepts-v2 (offline, not neural) |
| C. Chroma + neural embeddings | not run | n/a | n/a | n/a | not run: the embedding endpoint (api.groq.com, model text-embedding-3-small) could not serve embeddings: Embedding provider returned HTTP 404. |

* **The default embedding (`local-hashed-concepts-v2`) is not neural and, on hard paraphrases, it barely works** (recall@3 about 0.03-0.09). Earlier figures around 0.9 came from paraphrases that share the offline concept list's vocabulary and must not be read as general semantic quality.
* **ChromaDB does not change that**: with the same local vectors it indexes them faster at scale, it does not make them semantic. The difference between rows A and B is two queries out of 32 and should be read as noise.
* **Safety held in every system**: 0 of 18 forbidden queries produced a recommendation, because compatibility and safety are hard gates that run regardless of the embedding.
* **The neural row is BLOCKED, not estimated.** It needs an embeddings-capable endpoint; the configured one (`api.groq.com`) returned HTTP 404 for embeddings, so no neural number exists. Set `EMBEDDING_MODEL` and a key for an OpenAI-compatible embeddings API and re-run the command to fill it in, then choose the default from that result.
* Latency and cost for a neural model are also unmeasured; cost scales with documents indexed once plus one query embedding per customer message (cached briefly).
* The corpus is small and synthetic. It says nothing about real customers.

## Recovery

| Situation | What to do |
| --- | --- |
| ChromaDB is down | Nothing; Continuum falls back to SQLite and retries. Status shows *Temporarily limited*. |
| ChromaDB data was lost or you moved servers | `npm run index -- reindex` |
| You changed `EMBEDDING_MODEL` | `npm run index -- reindex` (the new model gets its own collection) |
| Index and database disagree | `npm run index -- reconcile` |
| Jobs show *failed* | Fix the cause, then `npm run index -- retry-failed` |
| The upgrade must be undone | Unset `VECTOR_STORE`/`CHROMA_URL` (Continuum returns to SQLite-only search). Migration 7 only adds tables and columns; the pre-upgrade backup `<db>.pre-v5.bak` is untouched. Return to the previous code with `git checkout main`. |
