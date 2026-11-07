# Continuum: implementation and verification

## Product and company model

Continuum is a reusable support agent for service businesses. Each company has isolated customers, cases, preferences, appointments, and reusable knowledge. The standard service and IT adapters are schema presets; the agent is not limited to the marketing examples of device repair.

Owners create companies at `/desk`, manage their team at `/team`, and supervise both schema workspaces at `/operator?provider=repair` or `/operator?provider=it`. A customer joins using a company-specific signup link. Specialists join through expiring, single-use, email-bound invitations. Public registration cannot choose a privileged role. Owners can revoke specialist access and sessions.

An account currently belongs to one company and has one unique email address. Multi-company account switching is not implemented. Existing records migrate atomically into the isolated `legacy` workspace, not into a new company's workspace. A local application administrator can promote an existing legacy account with `node scripts/grant-owner.js email@example.com`. Back up an existing deployment before upgrading.

## Confirmed learning workflow

1. Customer A opens a request and asks for help.
2. A specialist case captures the service record, relevant memories, conversation, and activity.
3. A specialist claims it, or the owner assigns someone in that company and schema workspace.
4. The assignee records progress, ETA, priority, and troubleshooting steps with attempted/failed/succeeded outcomes. Updates appear in A's conversation.
5. The specialist proposes symptoms, applicability, and reviewed solution steps. This creates a pending solution; it is not shared with B.
6. A confirms whether it worked. Acceptance resolves the case, records a private resolved outcome, and retains reusable knowledge in a company/provider-specific Hindsight bank. Rejection reopens work and keeps the candidate out of shared recall.
7. B's question is matched by Hindsight semantic retrieval, followed by a model relevance check. Product and version restrictions are independently checked. Unknown applicability produces a clarification request; conflicts exclude the fix.
8. Verified steps are delivered verbatim from the reviewed source. They are not expanded with generated procedures. Multiple competing matches ask for specialist guidance rather than merging fixes.
9. Retiring a resolution excludes it from recall and later model context. The historical UI record remains auditable. A background worker retries remote memory synchronization when configured.

Local mode uses a conservative concept/synonym matcher for demos. It is not a substitute for the live semantic-retrieval evaluation. Environment parsing handles explicit product/model and version constraints conservatively; unrecognized restrictions require confirmation rather than implying broad compatibility.

## Reuse outcomes and recovery

Each recommended resolution has one outcome receipt per customer/ticket/resolution. **It worked** resolves the request and records success. **Still need help** reopens it, creates or updates a specialist case with the attempted steps and conversation, and records failure. Duplicate submissions do not inflate counts or duplicate cases. A later recurrence can change a successful attempt to failed; a failed attempt needs a revised specialist solution rather than being toggled back into a success.

A failure report pauses new reuse pending staff review. It does not permanently retire knowledge automatically. The specialist must explain whether to keep or retire it, and review must include the latest failure reports. Even after the fix is kept, the customer who already failed it is excluded from repeat recommendations. These controls are part of the existing chat and specialist library.

An explicit request for human help or a confirmed workflow proposal does not require an available generative model. The agent asks for missing action details, does not invent note content or IDs, and does not create duplicate handoffs when a case is already open. Failed-fix reports made in chat remain proposals until the customer confirms sending them.

## Customer facts

Contact channel, contact time, approval, language, and accessibility preferences can be customer-wide. New preferences supersede older preferences in the same category. Technical failures and missed commitments stay on their ticket. Multiple facts can be extracted from one message, including phrases such as "did not help" and "no improvement". Obvious credential-bearing messages are excluded from fact retention.

Fact extraction is conservative English pattern-based extraction, not a complete multilingual understanding or automated anonymization guarantee. Staff privacy review remains necessary. Turning memory off also removes prior conversation context from model inputs so the comparison cannot reuse an earlier learned answer.

## Connect an existing database

The gateway defaults to **read-only**. A business hosts a thin authenticated HTTPS gateway in front of its database and exposes:

`GET {gatewayBase}/customers/{externalCustomerId}/requests`

The response is an array of up to 100 objects. Default fields are:

```json
[
  {
    "id": "SR-100",
    "customerId": "customer-42",
    "title": "Printer service",
    "issue": "Paper jam",
    "status": "Waiting for parts",
    "eta": "2026-12-20",
    "assignedTo": "Service team"
  }
]
```

1. The server operator adds the trusted origin to `PROVIDER_ALLOWED_ORIGINS` in `.env` and restarts.
2. The company owner configures the gateway URL, token, and flat JSON field mapping in **Company & team**. Tokens are encrypted at rest and never returned by the status API.
3. The owner links a Continuum account to the external customer ID. Customers cannot supply another person's external ID to the sync API.
4. The linked customer selects **Import/Sync service records**. Records are validated and imported atomically. Foreign-customer records reject the entire import. Existing records survive failed fetches.

Only explicitly allowed origins are contacted; redirects are rejected. HTTPS is required in production. The gateway must perform its own authorization and query its database safely. Do not expose raw database credentials to the browser. Use a least-privilege read-only database identity for this bridge.

Provider action delivery is optional and must be explicitly enabled by the owner. A capabilities handshake verifies the supported contract before encrypted jobs are queued. Stable replay keys, ordered creation/dependent updates, restart recovery, and exact provider receipts are implemented. See [PROVIDER-GATEWAY.md](PROVIDER-GATEWAY.md). A real business endpoint has not been supplied; the adapter was verified using an isolated HTTP service, including a lost acknowledgement after a remote commit. Calendar bookings remain on the existing calendar integration. Change-data capture, arbitrary SQL, automatic schema discovery, and vendor-specific drivers are not implemented.

## Local configuration and launch

`.env` is in the project root and ignored by Git. The required Hindsight and compatible model settings were verified on this computer. Strict live mode is enabled locally. Email and Google Calendar remain optional and require their own credentials and consent; no email or calendar activity was used for the AI evaluation.

```sh
npm ci
npm test
npm run test:http
npm run verify:live
bash scripts/start-wsl.sh
```

Run these under WSL with Node 22. On this computer, the verified Linux runtime is also installed in `~/.local/share/continuum-node/node-v22.16.0-linux-x64`; the startup script uses it if Node is not otherwise in PATH.

## Verification on November 6, 2026

- All 51 automated tests passed. Coverage includes account security, company isolation, customer approval/rejection, assignment/revisions, progress/ETA, preference isolation/supersession, retired prompt context, provider contract mocks, and gateway encryption/customer binding/atomic imports.
- HTTP checks cover the original website plus team/operator routes and assets.
- A live synthetic Hindsight/model evaluation passed 14 checks: no fix before publication, no reuse before customer approval, successful cloud retention, five unseen paraphrases, conflicting environment exclusion, two unrelated-query exclusions, Memory OFF, company isolation, and retirement in an existing conversation.
- Live evidence: `data/live-verification-fe1d76c0.json` (ignored runtime data). This is one synthetic resolution evaluated against varied questions, not a broad production answer-quality benchmark.
- A provider rate limit interrupted the first run. Bounded retry handling was added, and the complete rerun passed. Long outages or exhausted quotas still return explicit errors in strict mode.
- Browser verification used an isolated database and local responses: owner signup, customer link, invitation generation, customer signup, ticket creation, handoff, specialist assignment, progress, proposed solution, and customer acceptance. No real emails or calendar events were created.

The broader evaluation now covers ten distinct synthetic issues: 20 differently worded positive queries, 30 incompatible/missing-context/unrelated controls, and ten failed-fix recovery checks. Both local and live runs passed. The live report is `data/evaluation-e5bcf3de.json`: 20 correct verified fixes with memory ON, zero with OFF, zero inappropriate recommendations in the negative cases, and zero repeated failed fixes. This is a controlled regression dataset, not measured real-customer impact; see [evaluation/README.md](evaluation/README.md).

SQLite remains a single-host deployment. A real provider pilot, production operations, broader independent language/domain evaluation, and a full assistive-technology audit remain separate rollout work.


## Report remediation

Owners land on Company & team; specialists land on their service queue. Owner/staff personal-request navigation is removed, and /desk?view=personal redirects to their role dashboard. Customer-workflow APIs reject these roles; separate customer accounts perform requests and confirmations. Account & security and Sign out are directly available on company/console pages. Dialogs wrap forward/reverse Tab. Invitation signup uses the invitation's scope without a misleading selectable category. See COMPANY-INTERFACE.md for current verification.

Context summaries are assembled from the current ticket and active memory ledger in one coherent view, excluding retired preferences and unrelated technical history. They no longer concatenate separate generated reflections. Hindsight remains the semantic recall/learning backend.

Revoking staff atomically releases active assignments, increments revisions, resets the customer-visible team and records the handover while invalidating sessions. New assignments immediately update the customer-visible assignee. Concurrent delivery flush requests await the running batch.

Post-remediation verification: 54/54 automated tests, HTTP checks and 14/14 live checks passed (data/live-verification-368c560d.json). See FINAL-TEST-REPORT.md.
