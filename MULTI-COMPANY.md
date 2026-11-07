# Multi-company support prototype

This extends the existing SQLite records, operator console, verified-resolution retrieval and company gateway. Learning means retrieval and reuse of reviewed knowledge; model weights are not trained.

## Identity, workspaces and migration 4

`accounts.id` remains the global identity and all existing password hashes and account IDs are preserved. Registration normalizes email; a database expression index also enforces uniqueness on `lower(trim(email))`. Email is never a foreign key.

`company_memberships` has the composite primary key `(company_id, account_id)`, a company-specific customer/staff/owner role, active/revoked status, and the existing staff adapter permission. An account can therefore be a customer in A and a specialist in B. Runtime authorization and role-grant scripts use this table. The old account company/role columns and `staff_access` are retained for database compatibility only; changing them does not grant access.

Migration **4**, in `server/database.js`, runs in an immediate SQLite transaction and records its version only after successful completion. It backfills memberships, creates default repair/IT chatbots for every existing company, pins existing sessions to their original membership/service, backfills legacy tickets, handoffs, conversations, resolutions and memories, and changes external mappings to `(company_id, account_id)` uniqueness while retaining `(company_id, external_id)` uniqueness. Existing learned-fix receipts become durable learned attempts with an explicit legacy standard-stage skip. No database is reset and migration does not invalidate otherwise valid sessions. A normalized-email collision stops migration transactionally for deliberate administrative resolution, rather than merging identities.

Default chatbot IDs are `<company-id>:repair` and `<company-id>:it`; additional chatbot IDs are UUIDs. A chatbot's schema adapter cannot be changed after creation. This separates service identity from the adapter that translates its service records. Tickets in the same adapter can belong to different chatbots without sharing cases or knowledge.

Sessions have explicit `active_company_id` and `active_chatbot_id`. Each protected request reconstructs its profile from current active membership; company and chatbot IDs supplied by clients are references to validate, not authorization. The browser sends `X-Workspace: <company-id>|<chatbot-id>` on requests. A stale tab receives HTTP 409 after another tab switches the same session. Switching reloads the desk and clears the selected ticket, drafts, proposals, memory UI and pending actions. Proposals are also looked up in their original customer/company/chatbot scope. Other sessions retain their own selection.

Existing-account joining uses authenticated `POST /api/auth/join` with a customer signup code or an email-bound invitation token, followed by `POST /api/auth/workspace`. Code-based joins always grant customer access and are idempotent. Invitations remain expiring and single-use, and can deliberately promote an existing customer when the owner explicitly invited that account as staff. Revoked access cannot be restored with a public signup code; a fresh owner invitation can restore only its specified role. Accounts without an active membership can still authenticate and join a new company. Verification, recovery, CSRF, rate limits and global session revocation remain in place.

Owners manage memberships in **Company & team**. Removing specialist privileges preserves the person's customer membership and other companies' permissions. Revoking a membership blocks that company's subsequent requests and releases its active assignments. Owners cannot revoke themselves or another owner through this prototype control.

Administrative role grants now require an explicit company:

```sh
node scripts/grant-owner.js existing@example.test company-id
node scripts/grant-staff.js existing@example.test repair company-id
```

These commands operate on an existing active membership and record an audit event.

## Configuring services

Owners use **Company & team → Support services** to edit names, purposes, supported topics, diagnostic field names, allowed actions, immediate escalation topics, support routes and standard playbooks. **Add a service** copies a starting configuration into a new chatbot identity. Use the company/service selector on customer and operator pages to open it. The repair and IT defaults use the same troubleshooting engine. Staff retain their existing adapter permission within each company; owners can access all its services.

The API is `GET/POST /api/company/chatbots`. Updates require the current configuration `revision`; the server rejects stale revisions and adapter changes. Knowledge scope is always `company_chatbot`; cross-company scope is rejected. Customers cannot change configuration. Business actions are checked against the configuration's allowlist outside the model. A service that disables in-app handoffs presents its configured alternate support route without claiming a case was submitted.

Example standard playbook:

```json
{
  "id": "network-connection-check",
  "version": 2,
  "topics": ["network", "offline", "vpn"],
  "environment": "Model X firmware 4",
  "steps": "Check the approved connection profile once and test connectivity."
}
```

`environment` is optional for generally applicable playbooks. Product/version conflicts exclude a playbook; uncertain applicability prompts clarification. Changing steps should increment the playbook version. An attempt saves an immutable snapshot regardless of later configuration edits. Playbooks are a short ordered list of topic matches and verified steps, not a workflow programming language. For required diagnostic fields, customers can enter `environment: Model X firmware 4` or another configured `field_name: value`; API callers may send a `context` object. Context from the selected ticket is also used when it explicitly identifies an environment.

## Durable troubleshooting

The operational tables are `troubleshooting_context` and `troubleshooting_attempts`. Each attempt records its stable ID, company, chatbot, customer ID, ticket ID, standard/learned source, fix ID and snapshot, diagnostic context, outcome, exchange ID, optional reuse receipt and handoff IDs, and creation/outcome timestamps. A database uniqueness constraint permits at most one attempt per source per customer/company/chatbot/ticket.

| Current state | Customer event or evidence | Next state |
| --- | --- | --- |
| New issue | Required context missing | Ask for context |
| Context ready | Applicable standard playbook | Standard attempt pending |
| Context ready | No standard playbook applies | Persist explicit skip, consider learned fix |
| Standard pending | It worked | Resolved |
| Standard pending | Still need help | Consider learned fix |
| Learned stage | Applicability uncertain | Ask for environment clarification |
| Learned stage | Compatible published solution | Learned attempt pending |
| Learned stage | No suitable fix or memory off | Submit/reuse company human case |
| Learned pending | It worked | Resolved; record reuse success |
| Learned pending | Still need help | Submit/reuse human case; request knowledge review |
| Any unresolved state | Direct request for human help or immediate escalation rule | Prepare a handoff for explicit confirmation |
| Human case active | Further troubleshooting request | Wait for the company's specialist |

`POST /api/troubleshooting/outcome` requires `attemptId`, boolean `worked`, and `confirmed: true`. Retrying the same outcome is idempotent. An opposing finalized outcome receives HTTP 409, including after restart. Exact reports such as “It worked”, “That worked”, “It didn't work”, and “Still need help” use the same durable feedback path. Ambiguous failure reports retain the existing review-and-confirm handoff convention. A positive reaction, helpful rating, silence, status question or preference never counts as success.

The customer UI continues after a failed standard fix. The operational feedback API records that outcome first; API clients should then post another chat message such as “Continue troubleshooting” to request the next stage. A generic **Update outcome** cannot bypass pending fix feedback or specialist confirmation. New symptoms after a resolved issue should use a new ticket. A direct handoff remains **prepared** until its explicit confirmation succeeds; automatic escalation after exhausted troubleshooting is reported as **submitted** only after the local case commit succeeds. External gateway delivery, when enabled separately, still has its own pending/confirmed receipt.

The existing operator console shows the service queue, diagnostic ticket context, complete standard/learned attempt snapshots and outcomes, conversation history, assignment, progress and proposed solutions. Existing revision checks, owner assignment restrictions and audit trails remain. Rejected solutions stay private and continue the human case. Duplicate handoff submissions reuse the active case and mark the reviewed proposal as completed.

## Memory and publication

Private context remains scoped by customer + company + chatbot. Default services retain their original private-bank names to preserve history. Additional services receive independent private scopes. Raw customer conversations, preferences and identifying information never become a shared conversation bank.

Shared knowledge uses `knowledge:<company-id>:chatbot:<chatbot-id>`. A specialist must claim the case, propose structured symptoms/environment/steps, and affirm a privacy review. The original customer must confirm it worked before publication. Rejected or unconfirmed proposals are excluded. Retrieval validates local published records, chatbot/company scope, relevance, product/version compatibility, retirement, review state and failed-fix suppression, including equivalent republished steps. The server renders approved troubleshooting steps; a model cannot authorize an action or advance the state machine.

Reuse failure opens/reuses a human case, records the attempted steps, and pauses the resolution pending the existing revision-checked review/retirement policy. A review can make it eligible for other customers, but cannot cause the same customer to repeat previously failed steps in that company/chatbot scope. Outcome statistics continue to use the existing `resolution_uses` table.

Customer replies present the procedure as ordinary advice. A narrow presentation formatter removes attribution headings and phrases such as “specialist-provided”; original approved steps, authorship and provenance remain in source details and stored records. Required human-contact steps, product/version conditions and safety warnings are preserved. Existing learned chat replies receive the same presentation when read, without rewriting their audit history. The formatter does not generate new repair procedures.

Memory off disables optional AI recall and long-term retention for that exchange. It does **not** delete case records, saved conversations or the minimal attempt/context records needed for workflow continuity and duplicate prevention. Standard playbooks and human support remain available. Feedback APIs accept `memory: false`; the UI forwards the current setting. Specialist confirmation with memory off resolves the case as `confirmed_private` without publishing a shared-memory document or retaining a private AI outcome fact. This prototype does not offer a later publication toggle for those private confirmations.

Migration moves legacy repair/IT shared memory into its corresponding chatbot scope and clears successful-sync markers for re-publication. Existing remote bank documents are left unchanged in their old banks and excluded from application recall; the application no longer queries those banks for shared knowledge. Remote recall must still map to an active locally authorized document and resolution, so old remote documents cannot widen scope. `previousSyncedTo` retains migration provenance. The ordinary memory worker/recall initialization republishes active documents into the new banks and preserves invalidation/retry state; successful synchronization clears its pending marker. No remote migration was executed during verification. Back up SQLite and the integration encryption key before upgrading, and retain old bank data according to your organization's retention policy.

Cross-company generalized knowledge is a possible future extension only with explicit review, publication and recipient-scope controls. It is disabled here.

## Customer gateway and secure linking

The existing allowlisted, encrypted-token gateway handles service imports and optional acknowledged business actions. There is still one connection per company. Owner-triggered directory lookup adds:

```http
GET <configured-base-url>/customers/<url-encoded-stable-external-id>
Authorization: Bearer <server-held-token>
Accept: application/json
```

```json
{
  "id": "external-123",
  "email": "customer@example.test",
  "displayName": "Fictional Customer",
  "companyId": "optional-expected-company-id"
}
```

The response must match the requested ID; optional company ID must match the tenant. The bounded response is validated before any write. Invalid responses or attempted email changes on an already-linked identity preserve existing data. Repeated imports upsert one `customer_directory` entry and never create an account or staff membership.

Owners call `POST /api/company/connector/lookup-customer` with `externalId` from **Import a customer record**. To link it, the person first authenticates, joins the company through its signup link/invitation, and verifies their account email. Then the owner uses **Link a customer**, or `POST /api/company/connector/customer` with `accountId` and `externalId`. The server requires an active customer membership and a verified normalized email matching the imported record. An unverified email match cannot claim an external identity. Unique company/external ID and company/account ID constraints prevent duplicate or conflicting links; one account can have mappings in multiple companies.

Customers then use the existing `POST /api/connector/sync` contract, `GET .../customers/<id>/requests`, and configured field mapping. Imports include the selected chatbot identity and remain atomic and idempotent. Credentials stay encrypted server-side; origins, redirects and tenant/customer bindings remain checked. There is no arbitrary SQL, browser credential handling, full-directory synchronization, or real company database connection in the demo.

## Reproducible fictional demo

Use the existing Node 22 Linux/WSL environment matching the installed native SQLite module:

```sh
npm run demo:multi
npm run demo:multi -- --serve
```

The first command exercises and asserts the complete scenario in a new OS-temporary database and removes it afterward. The second also serves the fictional state at `http://localhost:3211/desk`. It explicitly disables email, calendar, model, Hindsight, gateway integrations and workers. `--keep` preserves only the newly generated fictional database and prints its path. It never selects the user's normal database.

The scenario creates Company A with two customers and repair/IT services, publishes Customer 1's confirmed specialist solution after a failed standard fix, gives it to compatible Customer 2 after a failed standard fix, records success, demonstrates a separate learned-fix failure reaching A's queue, and verifies that A's IT service and Company B cannot retrieve that repair knowledge. Customer 1 joins and switches between A and B using one account.

Fictional browser logins are `owner-a@example.test`, `owner-b@example.test`, `one@example.test`, and `two@example.test`; the script prints the shared fictional password. Sign in as Customer Two to inspect successful learned reuse and a second failed reuse case. Sign in as Owner A to inspect the attempts and review controls. Customer One can switch companies at the top of the page. All credentials and service instructions are fictional.

## Verification and limits

Actual results are recorded in [MULTI-COMPANY-VERIFICATION.md](MULTI-COMPANY-VERIFICATION.md). Regression tests use isolated databases and mocked providers. The retrieval-only evaluation explicitly configures no standard playbooks; the separate multi-company tests exercise the complete standard → learned → human workflow.

Prototype limits: topic matching and diagnostic extraction are intentionally conservative, each issue gets at most one standard and one learned fix, staff permissions are adapter-wide within a company rather than separately delegated per chatbot, and directory imports are individual owner-triggered lookups. One SQLite host and one gateway per company remain the architecture. Live external providers and remote bank re-publication need deployment-specific validation; neither is claimed as connected by these checks.
