# Privacy, retention and erasure: what Continuum keeps and what it removes

This page states what the code does today. It is not legal advice and it does not promise that every copy of data disappears: some data is kept on purpose, and some copies (backups) are outside what the application can edit.

## Where personal data can live

| Place | What is in it | Reaches shared knowledge, search or an outside service? |
| --- | --- | --- |
| Conversations, remembered context, case files | What the customer wrote, preferences, hand-over copies | No |
| Requests and appointments | Request title and description, status, visits | No |
| Diagnostic context, troubleshooting attempts | Device/version answers collected while troubleshooting | No |
| Resolution Passports (shared knowledge) | Title, symptoms, steps, applicability, safety text | Yes, **after** the privacy scrub (below) |
| Passport evidence and provenance | Structured receipts: who confirmed, when, confidence breakdown | Staff-visible; **strict schema** (below) |
| Vector index (ChromaDB) | Vectors of **active, scrubbed** passports plus company, service, origin, version and a document hash | No customer text, names or ticket ids |
| Embedding provider (optional) | Scrubbed passport text and the scrubbed customer query | Only if you configure a remote model |
| Logs | Error messages only | No request bodies are logged |
| Backups (`db:backup`, `*.pre-v5.bak`) | A full copy of the database | **Not edited by erasure** |

## The privacy scrub (before anything is shared or sent out)

* **Passport text and nested data** (applicability conditions, safety restrictions, steps): emails, phone numbers (including spaced international formats), addresses, customer and device identifiers, names after cue words, tokens and keys are replaced; credential-shaped values are **rejected**, not stored. Diagnostic columns named like personal data (email, phone, customer id ...) are refused on import.
* **Evidence and provenance** follow a strict allow-list schema: unknown keys are dropped, text is scrubbed, identifiers must look like identifiers, credentials are rejected, and the same rules run when a receipt is written, when it is read back and in a one-off clean-up migration for rows stored earlier.
* **Embedding requests** carry only scrubbed text; a credential-like text is never sent.
* Limits: bare personal names with no cue word, and free-text identifiers that do not look like personal data, cannot be detected.

## What a customer's erasure request removes

Choosing "Remove my conversation content" (all requests, or one request):

* conversation messages and replies are blanked;
* remembered context for those requests **and customer-wide preferences learned from them** (for example "call me on ...") is blanked and invalidated;
* copies inside specialist case files, the audit trail and cached responses of repeated submissions are removed;
* diagnostic context and per-attempt context are cleared;
* the summary of a **closed** case is blanked;
* removal from the remote memory service is recorded as a **durable, retried task** (idempotent, visible to owners, never silently dropped). The service cannot confirm a deletion back to us, so completion means "the delete call succeeded", not "verified";
* optionally ("also withdraw fixes learned from this"), shared fixes sourced from those requests are retired, which also removes them from search and from the vector index through the durable indexing jobs.

## What is kept, and why

* **The requests themselves** (title, description, status) and **appointments**, so work in progress is not broken.
* **Specialist updates**, written by staff.
* **A short summary of a still-open case**, so the specialist can finish it. It is blanked when the case closes if the customer has asked for erasure.
* **Shared knowledge**, which is scrubbed before publication and unlinked from the erased request. It stays unless the customer also chose to withdraw it.
* **Operational counters** (for example how many times a fix worked) and the append-only case timeline, which contain no conversation text.
* **Reuse records** (`resolution_uses`) store the device/environment description used to match a fix; they are not scrubbed by erasure.
* **Backups**: copies made before an erasure still contain the data until they are rotated or deleted by whoever runs them.

## Retention (off unless configured)

`RETENTION_ARCHIVED_CONVERSATION_DAYS`, `RETENTION_FOLLOW_THROUGH_DAYS` and `RETENTION_OUTBOX_DAYS` expire archived conversation content, finished follow-through tasks and delivered outbox jobs after the given number of days.

## What administrators can see

The owner console **Status** panel and `GET /api/company/system-health` show, per company and without secrets: whether the search index is reachable, how many fixes are updating or need attention, background-worker errors, and pending or failed erasure tasks. Failed indexing and erasure work stays listed until retried (`npm run index -- retry-failed`, or **Try again** in the console). The vector database address and credentials are never returned to the browser.
