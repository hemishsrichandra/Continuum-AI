# External chatbot prototype

This integration adds an owner-only option under **Account & security → External chatbot → Manage integration API keys**. No existing demo, customer, import or troubleshooting interface is redesigned. The fictional external company chatbot is a separate server and origin in `examples/external-chatbot/`. No dependencies are added.

## Start and demonstrate

Use Node 20.12+ and the existing installed dependencies. Keep the existing `.env` and database settings. `npm start` starts Continuum with its normal configuration. No new platform credentials are needed for the local adapter.

For a demonstration without changing the current demo's data, run another instance on an unused port with a **new absolute database path**. For example, from the repository root:

```sh
DATABASE_FILE=/tmp/continuum-external-prototype.sqlite \
FRONTEND_PORT=3500 API_PORT=3501 APP_URL=http://localhost:3500 \
NODE_ENV=development REQUIRE_EMAIL_VERIFICATION=false ENABLE_OUTBOX_WORKER=false \
VECTOR_STORE=sqlite EMBEDDING_PROVIDER=local OPENAI_API_KEY='' HINDSIGHT_BASE_URL='' \
npm start
```

Do not reuse an existing database path for this isolated demonstration. This command leaves the current `.env` file and running demo alone. The SQLite fallback indexes/retrieves locally; production can keep its existing embedding/vector configuration.

1. Visit `http://localhost:3500/desk`, create a fictional company owner account and sign in. Use the Device repair service. Existing company owners can instead use their configured service and previously imported knowledge.
2. Open **Team and data sources → Knowledge sources → Connect a source**. Choose **CSV (pasted or uploaded)**, name it **Synthetic external chatbot fixture**, and upload `examples/external-chatbot/synthetic-knowledge.csv`. This CSV is invented demonstration knowledge, not a live company database.
3. Map Record ID → `id`, Title → `title`, Symptoms → `symptoms`, Solution steps → `steps`, Applies to → `environment`, Safety restrictions → `safety`. Leave the source verification declaration unchecked, save, select **Preview first** (three valid records), then **Sync now**. For a real database, use the existing configured database source and its existing preview/sync controls instead.
4. Open the specialist console (`/operator`) for the same service, **Knowledge → Needs you**. Review the three imported fixes and approve each with a review note. This is the existing approval flow. When using Chroma, the existing indexing worker runs normally; the SQLite fallback can retrieve approved imports immediately while vector indexing catches up.
5. Open **Account & security → Manage integration API keys**. Select the same service, name the integration, select the three reviewed synthetic records, confirm privacy/safety and audience approval, and create the key. Copy it from the one-time server-rendered page into the company backend's secret environment. It cannot be retrieved again. New versions require a new key/audience approval; revoke the old key when rotating.
6. In a separate terminal, start the fictional company's backend. Enter the key using a hidden prompt, without putting it in shell history or a command-line argument:

```sh
read -rs 'CONTINUUM_INTEGRATION_KEY?Paste integration key: '; echo
export CONTINUUM_INTEGRATION_KEY
CONTINUUM_API_URL=http://localhost:3500 CHATBOT_PORT=3400 \
node examples/external-chatbot/server.js
```

The prompt syntax above is for zsh (the repository owner's shell). On bash use `read -rs -p 'Paste integration key: ' CONTINUUM_INTEGRATION_KEY` followed by `export CONTINUUM_INTEGRATION_KEY`.

7. Visit `http://127.0.0.1:3400`. Ask **The display flickers after startup.** with environment **Model X firmware 4**. The adapter sends a server-to-server Bearer request and the page renders up to three real eligible fixes, reviewed steps, sources, version IDs and the unconfirmed-evidence label. Expand **Actual Continuum API response** to inspect the JSON.
8. Clear the environment to see clarification. Ask **The satellite antenna has a broken mast.** to see no match. Set **Model Z firmware 9** to check incompatible knowledge is excluded. New conversation generates a different integration-scoped reference; it does not establish customer identity.
9. Return to the account key-management page and revoke the credential. The external chatbot now displays the invalid/revoked credential state. Stop the separate example server and unset `CONTINUUM_INTEGRATION_KEY` when finished.

No external suggestion creates a ticket, customer identity, attempt, reuse event or success/failure outcome. Environment facts are supplied with each question and are not retained between requests.

## API contract and example

`POST /api/v1/external/suggestions`, JSON, `Authorization: Bearer <key>`.

```json
{
  "question": "The display flickers after startup.",
  "conversationId": "company-chat-42",
  "environment": { "environment": "Model X firmware 4" }
}
```

`environment` is optional. Its keys must be non-personal diagnostic fields in the selected service schema (or `environment`); values are strings up to 300 characters. Question: 1–1400 characters. Conversation ID: 1–120 opaque letters/digits/`_ . : -`. Body limit: 8192 bytes. Unknown body fields, including company/service/customer IDs, are rejected. Credentials allow 30 requests per minute, persisted in SQLite; 429 includes `Retry-After`. Production should additionally rate-limit invalid credentials at the ingress.

Example using a backend environment key without printing it or placing it in process arguments:

```sh
CONTINUUM_API_URL=http://localhost:3500 node --input-type=module <<'JS'
const response = await fetch(new URL('/api/v1/external/suggestions', process.env.CONTINUUM_API_URL), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CONTINUUM_INTEGRATION_KEY },
  body: JSON.stringify({ question: 'The display flickers after startup.', conversationId: 'company-chat-42', environment: { environment: 'Model X firmware 4' } })
});
console.log(response.status, await response.json());
JS
```

Successful responses always contain `conversationRef`, `preview: true`, `suggestions`, `clarification`, and a `status` of `suggestions`, `clarification_required`, or `no_match`. Clarification can accompany suggestions. Each suggestion contains `id`, `title`, reviewed `steps`, optional applicability `advisory`, `provenance` (source/origin/version/review/customer-confirmation flags), and `unconfirmedEvidence`. No ranking score is represented as a success probability. Empty results are explicit, not filled with invented or below-threshold fixes.

Key listing: authenticated owner `GET /api/company/integration-keys` (metadata only). Revocation: authenticated owner `DELETE /api/company/integration-keys/:id` with the normal session CSRF header. Creation is deliberately a native authenticated form at `/api/company/integration-keys/manage`; the one-time full secret is delivered as no-store HTML with scripts disabled, never JSON to frontend JavaScript. Browser automation used in tests reads that page only to configure the test backend.

## Boundaries

- Keys contain 256 random secret bits plus a random management prefix. Only SHA-256 hashes and non-secret metadata are stored. Scope comes exclusively from the credential row, and services must remain active.
- Every key approves up to 100 specific content hashes in one company/service. Only active, present, locally reviewed company imports and explicitly approved owner playbooks qualify. Personal ticket-derived resolutions, conversations and customer-specific records are excluded even when reviewed. No raw source receipts, ticket IDs or customer records are returned as provenance.
- The existing memory-pool retrieval ranks and deduplicates candidates and applies relevance thresholds, compatibility and safety gates. The approved audience is filtered before ranking. The bounded approved set is considered explicitly so internal records cannot crowd it out of the candidate window. Credential and audience status are rechecked after asynchronous retrieval.
- Conversation references are HMACs scoped to the credential. The service stores no external conversation content/context. Reusing an external ID across credentials cannot merge conversations. Caller facts are claims used for compatibility, never verified identity or authorization.
- The separate adapter uses a fixed configured API origin, a fixed endpoint, a server-side key, no redirects and a timeout. Its browser uses only `/chat` on its own company backend. The adapter forwards only the preview response schema and never the authorization header or raw upstream errors. The local example binds only to loopback and labels fixture data clearly.

## Verification

Focused integration checks: `node --import ./test/setup-windows-cleanup.js --test test/external-chat.test.js`.

Browser round trip: `node --import ./test/setup-windows-cleanup.js --test e2e/external-chat.e2e.mjs` (installed Chrome/Chromium/Edge required).

Regression suite: `npm test`. Tests use temporary/in-memory databases. Some existing tests and the adapter/browser checks require permission to open loopback listeners.

Results on 14 November 2026:

- Focused integration + external browser checks: 4 passed, 0 failed. Includes real HTTP servers and a real browser, import/preview/sync/review, key creation, three rendered suggestions, clarification, no match and revoked-key display.
- Final `npm test`: 470 passed, 0 failed, 2 skipped (live ChromaDB unavailable). Credential, tenant/service/conversation isolation, zero/one/three suggestions, safety, unreviewed/private/withdrawn/changed knowledge, CSRF, validation, rate limits, preview-only bookkeeping and secret exclusion are checked.
- `npm run test:browser`: 14 passed, 0 failed, including existing customer, owner/source and page checks plus the new external flow.
- `git diff --check`: passed. No GitHub push was performed.

## Remaining production work

This is a local generic adapter, not a deployed connector for a named chatbot platform. A real platform needs its server-side webhook/API/SDK documentation, deployment credentials, secret manager, TLS endpoint, and its own customer-session authentication. Map its user message and opaque conversation ID to this contract server-side; validate platform webhook signatures and session ownership there. Do not embed the key in a widget, browser bundle, chatbot URL, or analytics.

Before public deployment, add ingress protection for invalid tokens, TLS and log-header redaction, shared capacity/concurrency controls, credential expiration/automated rotation, audit events and owner notifications, a reviewed audience update workflow, operational monitoring, and a clear retention policy for credential metadata. The demonstration adapter has only a local IP limiter and no production company login. Knowledge approval and content review remain human responsibilities; redaction is defense in depth. Conversation state is intentionally stateless; interactive outcomes, confirmed customer identity and platform-specific handoffs are future work. No live company database or external chatbot platform connection is claimed by the fixture demonstration.
