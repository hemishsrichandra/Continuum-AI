# Knowledge sources, sync, review and suggestions

How a company's support knowledge gets into Continuum, how it is reviewed, how up to three suggestions reach a customer, and how to measure
all of it honestly. Everything here is tenant-scoped: a company's sources, sync runs, records, search, outcomes and specialist cases are
never visible to another company.

## 1. Supported sources and what is (and is not) verified

| Source | Needs from the server owner | Notes |
| --- | --- | --- |
| CSV (pasted or uploaded in the console) | nothing | stored sealed with the source, up to `DATA_SOURCE_CSV_MAX_BYTES` (default 10 MB) |
| CSV file on the server (`csv_file`) | `DATA_SOURCE_CSV_DIRS` | **streamed from disk** in bounded batches; up to `DATA_SOURCE_CSV_FILE_MAX_BYTES` and `DATA_SOURCE_CSV_MAX_ROWS` |
| SQLite file | `DATA_SOURCE_SQLITE_DIRS` | opened read-only |
| PostgreSQL | optional `pg` package, `DATA_SOURCE_POSTGRES_DRIVER=pg`, `DATA_SOURCE_POSTGRES_HOSTS`, `…_PORTS` | read-only session, TLS required |
| MySQL / MariaDB | `npm install mysql2`, `DATA_SOURCE_MYSQL_DRIVER=mysql2`, `DATA_SOURCE_MYSQL_HOSTS`, `…_PORTS` | read-only session, TLS required |
| SQL Server | `npm install mssql`, `DATA_SOURCE_MSSQL_DRIVER=mssql`, `DATA_SOURCE_MSSQL_HOSTS`, `…_PORTS` | read-intent connection, TLS required. **SQL Server has no read-only session mode: give Continuum a login that can only `SELECT` the one table.** |
| REST / JSON | owner-approved websites (*Allowed websites*) or `DATA_SOURCE_ALLOWED_ORIGINS` | page, offset, cursor and next-link paging (see below) |

**What is verified.** The SQLite, CSV, REST and PostgreSQL paths run against real local databases/servers or mock drivers in CI. The MySQL/MariaDB
and SQL Server adapters are tested against mock drivers that check the exact SQL, the bound values and the read-only/TLS settings, and the
real `mysql2` 3.x and `mssql` 12.x packages were checked to expose the API the adapters call. **They have not been run against a live MySQL or SQL
Server**: do that in the pilot sandbox below before relying on them. Anything not installed or not allow-listed is reported as
"configuration-required", never faked as a success. Other databases: implement the small adapter contract in
`server/source-adapters.js` (`batches({ row, conn, mapping, checkpoint, mode, since, batchSize })` yielding `{ rows, checkpoint }`) and register it in
`createDataSources`; read through `buildPageQuery` or an equivalent bounded, read-only query.

Credentials are encrypted with the existing integration key (`INTEGRATION_ENCRYPTION_KEY`), never returned by any API, never logged, and never
echoed in an error. Editing a source shows that a credential is *stored*; a blank credential field keeps it.

### REST paging, retries and limits

`pagination` is one of `none`, `page` (`pageParam`, `pageStart`), `offset` (`offsetParam`), `cursor` (`cursorParam` + `nextCursorPath`, e.g. `meta.next`) or
`next_link` (`nextLinkPath`, e.g. `links.next`, or `header:link` for an RFC 5988 `Link` header). `pageSize` and `limitParam` set the page size.
Only an empty page (or no next cursor/link) ends a read: a short page proves nothing because a server may cap page sizes. Every request,
including each follow-up link, is re-validated: https (or an explicitly allowed development loopback), an approved origin, public DNS answers
only, the connection pinned to the validated address, **no redirects**, and a follow-up link must stay on the configured website. Responses are limited
(`DATA_SOURCE_MAX_RESPONSE_BYTES`), time-limited (`DATA_SOURCE_FETCH_TIMEOUT_MS`), and retried a bounded number of times
(`DATA_SOURCE_RETRIES`, `DATA_SOURCE_RETRY_BASE_MS`) on timeouts and HTTP 429/500/502/503/504, honouring `Retry-After` up to
`DATA_SOURCE_MAX_RETRY_AFTER_MS`; a longer wait stops the sync with a resumable error instead of sleeping through it.

### CSV validation

UTF-8 (with or without a byte-order mark) and UTF-16 with a byte-order mark are accepted; anything else is refused, never guessed. Header names must be
unique and every mapped column must exist (an unmapped-by-typo safety column would otherwise silently disable a safety restriction). A row whose column
count does not match the header is reported with its line number and counted as invalid, never padded or dropped silently. An unterminated quote is
reported with the line it started on. Row and size limits fail explicitly (`DATA_SOURCE_CSV_MAX_ROWS`, `…_MAX_BYTES`).

## 2. Sync semantics

* **Bounded work.** Rows are fetched, mapped and written `DATA_SOURCE_BATCH_SIZE` at a time (one transaction per batch). One run pauses after
  `DATA_SOURCE_MAX_RECORDS` records (default 100,000, a safety limit and **not** a cap on knowledge): the status becomes *paused part-way* and the next run continues.
  There is no global pool cap. The engine hands the event loop back between batches.
* **Resumable.** SQL sources are read with a **keyset** (`WHERE id > last ORDER BY id`), not an offset, so rows inserted or removed between runs cannot make a
  resumed run skip or repeat records. The checkpoint is committed in the same transaction as the batch it describes. After a failure, a crash or a pause
  the next run resumes from the last committed checkpoint; a worker that died is detected by its expired lease.
* **Never overlapping.** A source holds a lease while syncing; a second manual or scheduled run is refused (HTTP 409). Writes are idempotent upserts keyed by
  company, source and external id, so a replayed job changes nothing.
* **Complete means complete.** `last_synced_at` and the *Up to date* badge only move when a run reaches the end of the source. A failed, cancelled,
  paused or partially-run sync is shown as such, keeps its progress (except *Cancel*, which discards it), and **never retires anything**.
* **Full and incremental.** A *full* sync reads the whole source. If (and only if) the owner marked the source an authoritative snapshot, a full scan that
  reached the end (across any number of resumed runs; each record is stamped with its scan) retires records the source no longer lists. They are
  restored, through the normal review policy, if the source lists them again. An *incremental* sync is only offered when the source can prove what changed:
  SQL sources with the "Last updated" column mapped, REST sources with a "modified since" parameter. It reads rows at or after the durable high-water mark
  (inclusive, minus `DATA_SOURCE_LOOKBACK_SECONDS` for timestamps), which handles ties and late arrivals; updates are idempotent; it **cannot see deletions**, so it
  never retires, and a full sync is run automatically every `DATA_SOURCE_FULL_SYNC_HOURS` (default 168). The result always says `mode: full|incremental` and, when an
  incremental sync was wanted but not possible, why. Rows with an empty "Last updated" value are only picked up by full syncs.
* **Per-source status.** Freshness (*never / up to date / overdue / paused part-way / failed / paused*), consecutive failures, saved progress, the high-water mark and the
  last runs (mode, trigger, result, counts) are shown on each source card and in `GET /api/company/data-sources`.
* **Scheduling.** Only sources an owner gave a sync interval are ever scheduled; nothing runs against an external system before that. The worker
  tick is fair across companies (round-robin, `DATA_SOURCE_SCHEDULER_PER_TICK`), runs at most one source per company at a time and
  `DATA_SOURCE_SCHEDULER_CONCURRENCY` in total, retries a failed source after `DATA_SOURCE_SCHEDULER_RETRY_MINUTES` doubling up to its interval, and continues a paused-part-way run on
  the next tick. Pausing a source stops its schedule; *Sync now* and *Full re-sync* always work manually.

## 3. Fields, compatibility and review

Mapped fields: `externalId`, `title`, `symptoms`, `steps` (required) and `problemCategory`, `productFamily`, `model`, `applicability`, `safety`, `updatedAt`, `sourceVersion`
(optional), plus diagnostic columns for the service's own diagnostic schema. Existing sources and records keep working unchanged.

* **Model** becomes a mandatory condition when the record names one: a customer who has not said which model is asked, never assumed; a different stated model excludes the
  fix. **Product family** is mandatory only when the service asks customers for a `product_family` diagnostic field. **Problem category** only nudges ranking (a match helps, a
  different stated category lowers the score a little, an unknown one changes nothing). A blank value in the source adds no condition. Every decision is explained (`reasons`, `structured`).
  Values are the company's own; nothing is hard-coded to one company's categories.
* **Review.** Imports from a source that is not declared verified are held for review (`pending_review`) and are never recommended. *Owner-declared verified* raises
  initial confidence but is shown as such; customer-confirmed success is a separate, stronger state. Each passport shows review status, verification basis, source,
  source record id, source version, last seen and retirement reason.
* **Conflicts.** Two live records from different places with the same problem, different fixes and overlapping applicability become a conflict. The unreviewed
  imported side is quarantined; the owner decides (*Knowledge review*): keep one, keep both, or retire both. Nothing picks a winner automatically.
* **Staleness.** A source may set "mark records stale after N days absent from a *complete* sync". Staleness is computed against the last complete sync, so a paused, failing
  or partial source can never make knowledge stale. It is a report; nothing is deleted.
* **Audit trail.** `knowledge_events` is append-only (database triggers) and records imports, updates, withdrawals, reappearances, conflicts, decisions, source edits and shadow-mode
  changes with ids and reasons, never record text.

## 4. Suggestions, outcomes and handoff

By default (`SUGGESTION_MODE` unset or `choose`) the customer is shown **up to three** eligible suggestions, each with why it matched, its source label and any applicability
warning, and **nothing is recorded as tried** until they press *Try this one*. Choosing re-validates the suggestion against current knowledge, records one attempt, and leaves the
others untried. Outcomes: *worked*, *did not work* (the only one counted against a fix), *doesn't apply*, *can't try*, and *asked for a specialist* (API `outcome: human_requested`;
in the UI, *Talk to a person*). Repeating the same answer is harmless; a different final answer is refused. `SUGGESTION_MODE=auto_first` restores the legacy behaviour (the best
suggestion is recorded the moment it is shown) for older deployments; it is not recommended.

A specialist case is opened when the customer asks for a person, a safety concern is reported, or no suitable suggestion remains. It carries a **brief**: the unresolved question,
what triggered the handoff, the facts the customer gave, every suggestion tried with its outcome and provenance (origin, version, source, source record, confirmed/reviewed), and counts of
real failures. Personal details are scrubbed. Claim/release ownership is unchanged.

Outcomes and confirmations are auditable **ranking signals** (reliability, near-miss demotion); nothing is trained, and raw conversation text is never promoted to knowledge without
specialist review.

## 5. Shadow mode and evaluation

* **Shadow mode** (*Knowledge review → Shadow mode*, `GET/POST /api/company/shadow`): opt-in per service, off by default. It ranks suggestions in the background for live
  conversations without showing them or changing any outcome; a failure is recorded and swallowed. It stores only the ticket id, the query *length*, the ids and scores of the top three,
  counts and timing (pruned after `SHADOW_RETENTION_DAYS`, default 30), and, when a specialist later solves the case, how closely the ranked fixes resembled the real solution (a word-overlap proxy).
* **Offline replay**: `node scripts/pilot-replay.js --file tickets.csv --label real [--evaluate-after 2026-06-01]`. Default is a rolling time-ordered replay. With `--evaluate-after` it
  is a **strict holdout**: knowledge is built only from tickets before the date and the later tickets are scored without ever being learned from. Tickets without dates are called out
  (`ordering: FILE ORDER …`) because order then proves nothing about leakage. The summary reports top-1/top-3 match, coverage, escalation and abstention rates, incompatible and unsafe
  suggestions (judged against the ticket's full facts), calibration bands and ECE, and a `dataLabel`. **Synthetic data is labelled synthetic and is never evidence of production quality**;
  the automatic match is a proxy, and only the `human_match` column filled in by a specialist is a quality claim.

## 6. Tests

* `npm test` — unit and integration (SQLite, local HTTP servers, mock drivers; no network, no credentials).
* `npm run test:browser` — real-browser tests (Playwright driving Chrome, Chromium or Edge) against the real server: source setup, validation failure, editing with masked credentials, a large paused-and-resumed
  import, choosing a suggestion, every outcome, specialist handoff and the customer permission boundary. They **fail loudly** if no browser is found; set `BROWSER_PATH` to a Chromium-based
  executable. They are not part of `npm test` so a machine without a browser does not silently skip them.

## 7. Manual pilot checklist (authorized company sandbox only)

Use a sandbox or a read-only replica with a login that can only read the one table. Never commit credentials or customer data.

1. **Configure** the server (`.env`, see `.env.example`): the connector allow-lists above, `INTEGRATION_ENCRYPTION_KEY`, and the driver package for your database.
2. **Connect** the source as the owner. *Test connection* → confirm the columns look right and incremental support is reported correctly.
3. **Map** fields; run **Preview**: check valid/invalid counts, redactions and the "would need review" count against what you expect.
4. **Sync completeness:** run *Sync now* until *Up to date*. Compare the source's row count with *records added* (plus invalid/skipped, each explained). Pull the plug mid-sync (or *Cancel*/*Pause*) and confirm
   it resumes without duplicates and that nothing was retired. Add, edit and delete rows in the source; run an incremental and a full sync and confirm updates arrive and deletions are retired only by the full sync (authoritative sources).
5. **Review:** with the source not declared verified, confirm imports wait for review and are not suggested; approve a few; check *Knowledge review* for conflicts and stale items.
6. **Recommendations:** as a test customer describe a known problem with and without the model/family; confirm up to three suggestions, the stated reasons, that unrelated or incompatible fixes are absent, and that nothing is counted until you choose one.
7. **Outcomes:** exercise worked, did-not-work, doesn't-apply, can't-try; confirm only did-not-work raises a fix's failure count.
8. **Escalation:** ask for a person and exhaust the suggestions; confirm the specialist case has the brief, the tried suggestions and provenance, and no personal details.
9. **Shadow mode:** turn it on for a day, confirm customers see no change, then review coverage and agreement; turn it off.
10. **Isolation:** sign in as a second company and confirm none of the above is visible.

## 8. Known limitations

* MySQL/MariaDB and SQL Server are not verified against live servers; SQL Server cannot enforce a read-only session, so use a read-only login.
* The stored CSV (`csv_sync`) lives in the database up to `DATA_SOURCE_CSV_MAX_BYTES`; use `csv_file` for large files. A resumed CSV re-reads (but does not re-write) the rows before its checkpoint.
* Incremental sync cannot see deletions and ignores rows with an empty "Last updated" value; a periodic full sync covers both.
* Conflict detection compares records by their title words and fix wording (not meaning); a neural embedding model improves matching but is not used for conflicts.
* "Resembles" in shadow mode and replay is word overlap, not a judgement of whether a fix was correct.
* SMS/email notifications for failing sources are not sent; failures are visible on the source card, in run history and in the worker lane status.
