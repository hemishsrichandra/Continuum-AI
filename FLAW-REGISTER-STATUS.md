# Flaw register — validation against the current code

Source: the consolidated “Existing Flaws and Future Implementation Risks” report (E01–E40 existing, F01–F38 prospective). Each item was checked against the **current** repository by reading the code and, where the report gave a reproducible case, re-running it. Status words:

* **Fixed** — behaviour changed and covered by an automated test.
* **Mitigated** — risk reduced, a known residual remains (stated).
* **Open** — not addressed in this work (stated why).
* **Decision** — a product choice that deliberately differs from the report's recommendation.

Test names refer to files under `test/`. All figures come from synthetic tests, not production use.

## A. Existing findings

| ID | Status | What changed / why it stays open | Evidence |
| --- | --- | --- | --- |
| E01 negated facts accepted | Fixed | Typed positive/negated mentions; any conflict makes a fix ineligible. Re-ran the report's exact case: now incompatible. | `regressions-phase0`, `audit-fixes` (E05), `scoring` |
| E02 Android/iOS versions | Fixed | OS families, versions and ranges are evaluated; a different OS family is a conflict. Android 14 vs 15 → incompatible. | `regressions-phase0`, `scoring` |
| E03 demo warning stripped | Fixed | Simulation/safety qualifiers are never removed from customer advice. | `customer-advice`, `regressions-phase0`, `demo-isolation` |
| E04 role allowlist vs real cancel path | Fixed | `/api/book/cancel` added; a matrix test now asserts every customer endpoint rejects owner/staff sessions and customers cannot reach staff areas. A single central route registry was **not** built (see E33). | `audit-fixes` (E04) |
| E05 free-text negation/range/time | Mitigated | Structured conditions with negation, version ranges and now **historical** mentions (“previously had a Model Y” is not the current device). Unknown required facts withhold the fix and ask. Residual: complex temporal prose is not parsed; it fails safe (clarify). | `audit-fixes` (E05) |
| E06 context silently overwritten | Fixed | A later message that names a different device/version asks which is right and changes nothing; only an explicit form answer replaces it, and a pending learned fix that no longer applies is withdrawn (skipped, not a failure). | `audit-fixes` (E06) |
| E07 24-record fallback truncation | Fixed | Retrieval scans every active passport in the caller's service, ranks, then limits to 3. Residual: it loads the service's active rows per query (fine for thousands, not millions). | `memory-pool` |
| E08 fallback vs live quality gap | Mitigated | One retrieval pipeline for offline and remote embeddings; the backend used is reported with each answer. Offline recall on synthetic sets: 100% regression/challenge/held-out, 87–90% on an independent validation set; never validated against a live embedding model. | `rag-quality`, `STATUS.md` |
| E09 Hindsight 6-document cap | Fixed (for company knowledge) | Company knowledge no longer goes through Hindsight. Per-ticket customer memory still does. | `memory-pool` |
| E10 conflicting fixes suppress all | Fixed | Up to three are presented one at a time, ranked; conflict is not an all-or-nothing discard. | `memory-pool` (main flow) |
| E11 first-match standard playbook | Fixed | Playbooks are ranked by topic overlap, config order breaks ties. | `audit-fixes` (E11) |
| E12 one attempt per source | Fixed | `sequence` 1–3 per ticket, unique per sequence. | `memory-pool`, `migration-v5` |
| E13 one failure globally flags | Fixed | Per-passport counters; flag at 2 consecutive failures, or reliability < 0.55 once ≥ 2 outcomes exist; safety incident quarantines immediately. | `self-correcting`, `scoring` |
| E14 no version lineage | Fixed | Immutable versions with parent pointer; old row superseded atomically. | `self-correcting` |
| E15 no deadline follow-up | Fixed | Persisted confirmation tasks, worker tick, SLA escalation; silence is never success. | `follow-through` |
| E16 unified queue | Fixed | `GET /api/operator` now also lists every open request in the service that is not yet escalated (customer, status, attempts, timeline), and a `request_opened` event starts each timeline. | `audit-fixes` (E16), `follow-through` |
| E17 narrow PII filter | Mitigated | Added grouped/spaced phone numbers (e.g. `+91 98765 43210`), street addresses, national ID numbers, titles + names; versions/IPs/build numbers are preserved. Residual: an unprompted bare personal name cannot be detected by patterns; mitigation is the specialist's preview plus the rule that any redaction blocks auto-publication (failure-closed). | `audit-fixes` (E17), `scoring` |
| E18 success and sharing coupled | Decision | The memory toggle was removed on request. Publication still needs a specialist-reviewed, scrubbed passport **and** the original customer's explicit “It worked”. A separate “authorisation to share” step was not added. |  |
| E19 memory-off semantics | Mitigated | Customer copy now says what is and is not retained. No data export/deletion controls were added. | UI |
| E20 remote memory eventually consistent | Mitigated | Company knowledge is local and authoritative. Per-ticket Hindsight sync is unchanged. |  |
| E21 whole-collection JSON load/save | Open | Tickets, conversations and audit still live in the JSON `records` store. New v5 data is relational and indexed. Re-architecting the older store was out of scope. |  |
| E22 tenant scope inside JSON | Mitigated | All new tables carry `company_id` with composite foreign keys and every query is scoped. Legacy JSON collections still rely on application filters (covered by the cross-company tests). | `memory-pool`, `data-sources`, `intelligence` |
| E23 one gateway per company | Fixed | Any number of data sources per company/service with their own mapping, secret and health. The legacy gateway still allows one. | `data-sources` |
| E24 flat mapping only | Mitigated | Dotted paths for nested JSON/REST fields; CSV/SQL are flat. No transforms (deliberately: no code execution). | `data-sources` |
| E25 100-record cap | Mitigated | Mediator limit is 2000 with an explicit error; no cursor paging. The legacy gateway cap of 100 is unchanged. |  |
| E26 resync overwrites local changes | Fixed (mediator) | Reviewed, revised, flagged or failure-tracked records are never overwritten. The legacy gateway's `Object.assign` is unchanged. | `data-sources` |
| E27 only repair/IT | Mitigated | Diagnostic schema, playbooks and knowledge are now domain-agnostic and editable; the ticket-record adapter enum is still `repair|it`. | `data-sources` |
| E28 staff not bot-granular | Open | Staff are still scoped to their adapter. |  |
| E29 shared slot model | Open | Scheduling untouched to avoid regressions. |  |
| E30 hardcoded time zone | Open | As above. |  |
| E31 failed external jobs | Open | `provider-actions` not changed. |  |
| E32 manual sync only | Open | Sync is owner-triggered; a scheduled poller was not built. |  |
| E33 monolithic `app.js` | Open | Routes were added to the same file; no layering refactor. Guarded by the E04 matrix test. |  |
| E34 large UI files | Open | UI grew; no component refactor. Browser smoke tests were run instead. |  |
| E35 isolated demo | Fixed | Separate store, API, UI, zero start, hash-checked database isolation. | `demo-isolation` |
| E36 intelligence layer | Fixed | Company-scoped endpoint and dashboard; confirmed, unconfirmed and imported are separate. Residual: aggregates scan JSON collections (see E21). | `intelligence` |
| E37 stale test evidence | Fixed | Fresh `npm ci` runs recorded with counts and durations in `STATUS.md`. |  |
| E38 localhost-only bind | Fixed | `HOST` env var (default loopback); the internal API listener stays on loopback. TLS and a trusted proxy are still the operator's job. | `check-http` (default), docs |
| E39 flush fairness | Open | Hindsight flush unchanged. |  |
| E40 editable audit | Mitigated | `case_events` is append-only at the database level (update/delete abort). The legacy `audit` JSON collection is still editable. | `audit-fixes` (E40) |

## B. Prospective risks

| ID | Status | Notes / evidence |
| --- | --- | --- |
| F01 FTS/vector tenant leak | Fixed | Scope applied in SQL before candidates exist; FTS always joined to the scoped table. `memory-pool`, `data-sources` |
| F02 demo shares main DB/services | Fixed | No store, no network, hash-checked. `demo-isolation` |
| F03 timeout publication | Mitigated | Honest label, separate origin, never closes the case, policy gates, retire available. A customer rejection after publication flags the fix. `follow-through`, `audit-fixes` (F23) |
| F04 PII in indexes/embeddings | Mitigated | Scrubbed before embedding/FTS/storage. No automated deletion lifecycle across all copies. |
| F05 unsafe/injected content | Mitigated | Dangerous-instruction and prompt-injection patterns flag imports for review; retrieved text is shown verbatim and never sent to a model. `audit-fixes` (F05) |
| F06 unknown treated as compatible | Fixed | Tri-state gate: eligible / withheld-for-clarification / ineligible. `scoring` |
| F07 score normalisation | Fixed | Bounded cosine and BM25 normalisation documented and unit-tested. |
| F08 one failure flags via W | Fixed | Reliability rule needs ≥ 2 outcomes; tested at 0.55 boundaries. `scoring`, `self-correcting` |
| F09 completeness overvalued | Mitigated | `C_init` unchanged by spec, but auto-publication needs privacy review, no redactions, no risk flags, no hazards, not contradicted. |
| F10 diag similarity ≠ compatibility | Fixed | Compatibility is a separate deterministic gate. |
| F11 circular author reliability | Open | Acceptance history is used only after ≥ 3 decided proposals; circularity remains a design risk. |
| F12 duplicate fixes | Fixed | Dedupe by canonical step signature; same content as the standard playbook excluded. `memory-pool` |
| F13 order changes on refresh | Fixed | Attempts are persisted; refresh re-shows the pending one. `memory-pool` |
| F14 safety gate too late | Fixed | Hard filters before scoring. |
| F15 stale FTS/vector | Fixed | Triggers keep FTS in sync; status re-checked at delivery; old embedding versions are re-embedded. `memory-pool`, `rag-quality` |
| F16 embedding model/dimension drift | Fixed | Model name stored; wrong-length stored vectors are re-embedded; inconsistent remote dimensions fall back to local. `audit-fixes` (F16) |
| F17 import overwrites reviewer | Fixed | `data-sources` |
| F18 duplicate imports | Fixed | Unique (company, source key, version). `data-sources`, `migration-v5` |
| F19 SQLi / SSRF / secrets | Fixed | Allowlists, identifier validation, public-DNS check, no redirects, encrypted secrets. `data-sources` |
| F20 migration not reversible | Fixed | Backup before upgrade, idempotent, restore drill tested end to end. `migration-v5` |
| F21 two sources of truth | Mitigated | The pool is canonical for company knowledge; legacy resolution records remain for case history and are not used for retrieval. |
| F22 double publication | Fixed | Conditional claim + unique key. `follow-through` |
| F23 deadline vs confirmation race | Fixed | Both orders tested. `audit-fixes` (F23) |
| F24 task vs case state | Fixed | Proposal, publication and case status stay independent. `audit-fixes` (F24) |
| F25 version lineage race | Fixed | Unique (company, source, version) + status check inside one transaction. `self-correcting` |
| F26 context-free reliability | Open | Outcomes are not tracked per applicability cohort. |
| F27 inflated “verified” | Fixed | Distinct origins and separate counters. `intelligence` |
| F28–F30 demo ordering/isolation/real retrieval | Fixed | `demo-isolation` |
| F31 dynamic schema safety | Mitigated | Schema validated on save; required unknowns trigger clarification. No schema versioning. `data-sources` |
| F32 unsupported adapters hidden | Fixed | Unavailable adapters report configuration-required; PostgreSQL is mock-tested only. |
| F33 follow-up spam | Mitigated | One email per proposal (idempotent id), only when email is configured. No quiet hours/unsubscribe. |
| F34 outages block flow | Fixed | Offline retrieval, timeouts, fallback. `memory-pool` |
| F35 removed routes | Fixed | `/operator`, `/team`, scheduling kept; demo is additive. `check-http` |
| F36 slow analytics | Open | See E21/E36. |
| F37 lifecycle/retention | Open | No retention policy. |
| F38 big-bang risk | Mitigated | Delivered in phases with tests at each step. |

## C. Contradictions the report asked to resolve

1. **Verified vs overdue:** separate origin `auto_published_overdue`, never counted as confirmed, never closes the case.
2. **Two failures vs reliability:** resolved. A single failure never flags; the reliability rule applies only after two outcomes (previously, at `C_init` 0.75, one failure gave W = 0.50 and flagged).
3. **Standard first vs pool:** standard playbooks are pool rows with their own origin, shown first and excluded from learned retrieval.
4. **Demo “no memory pull”:** the demo retrieves only what was learned in that session.
5. **Company vs service scope:** every query is scoped to company **and** service.
6. **Schema flexibility vs safety:** mappings cannot affect tenant, auth, safety or review checks.
7. **Auto-publication vs privacy:** scrubbing, specialist preview and “any redaction blocks auto-publication” apply; a separate consent workflow is not built (see E18).
