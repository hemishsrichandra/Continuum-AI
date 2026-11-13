# Charging issue: Customer A → specialist → Customer B

Verified on November 7, 2026, in the isolated fictional demo at localhost port 3211. The original requests and sessions were preserved with a verified SQLite online backup before restarting the demo. The ordinary server on port 3100 was left untouched.

## What was wrong

Customer A's charging request repeatedly received `environment: …` even after saying they could not confirm the environment. The default repair service also had only a connectivity playbook, so a charging issue could not exercise the desired standard-first path.

The prompt now asks for the device model and operating-system version in plain language. If the customer says “I don't know” or “I am not able to confirm…”, the bot prepares a specialist handoff for explicit confirmation rather than repeating the question. Required diagnostic checks and the final handoff confirmation remain enforced. Old conversation messages are preserved as history.

Repair defaults now include a versioned `charging-connection-check` playbook. It checks the approved charger's connection and charging indicator without recommending device disassembly. Existing owner configurations are preserved; the fictional Company's stored configuration was updated through the owner UI to add this playbook.

## Observed browser flow

| Step | Actual result |
| --- | --- |
| Customer A says device details are unavailable | Clear specialist handoff proposal; no repeated environment prompt |
| Customer A confirms the handoff | Charging case appears in Company A's existing operator queue |
| Owner claims the case and proposes the labelled fictional ChargeDemo solution | `pending_confirmation`; **0 shared memory documents** |
| New Customer B registers using an email-bound customer invitation | Separate customer account in Company A's Device repair service |
| B reports the same symptoms on Model ChargeDemo version 1 | Configured charging playbook shown first; standard outcome pending |
| A confirms the fictional specialist solution | `published`; **exactly 1 shared memory document** |
| B selects Still need help on the standard check | Standard attempt finalized as failed; confirmed specialist solution retrieved |
| B opens Sources & response details | **1 verified resolution · Local demo memory · 1 recalled** |
| B selects It worked on the learned solution | Learned attempt succeeded; request Resolved; **1 successful reuse** |

B did not need a new human case. Both attempts and the successful reuse receipt were verified directly in the isolated SQLite database. Database integrity remained `ok`.

Customer A's ticket: `SR-7337C7D6-FA1E-40FC-AA1A-CAF165560B21`.

Customer B's ticket: `SR-6B5474A0-7E63-4B5B-A487-E7EB15ED28A1`.

Shared resolution: `4a01f408-d745-4715-9f7f-79df50223b06`.

## Reopening and repeating the test

- Customer A remains available at `http://localhost:3211/desk` using `one@example.test`.
- Customer B's separate browser session is at `http://127.0.0.1:3211/desk`, using `charging-b@example.test`.
- Both use the existing fictional password: `fictional demo passphrase 2026`.
- The owner console uses `owner-a@example.test` in the same company and service.

Create a **new** Customer B request with the same symptoms and `Model ChargeDemo version 1` to repeat it. The standard check should still come first. Only choose Still need help if simulating its failure; It worked ends troubleshooting at that stage. Do not use a different company, service or conflicting device version when checking compatible reuse.

All specialist instructions and successful outcomes in this demonstration were explicitly fictional/simulated. No physical laptop repair was verified. Memory here is local company/chatbot-scoped retrieval, not model-weight training. Live Hindsight, email, calendar and gateway integrations remain disabled.

Customer-facing wording was subsequently generalized: Customer B now reads “Select the approved training battery profile and test charging again.” The fictional source label and specialist attribution remain available in Sources & response details. The approved source and completed attempt records were preserved. This is a presentation change, not a new repair procedure.

## Checks

`npm test`: **79 passed, 0 failed** after the customer-facing wording update. Coverage includes the exact unavailable-environment wording, plain-language clarification, charging standard-first ordering, customer-confirmed publication, successful cross-customer reuse and preservation of prerequisites/warnings while hiding attribution. `npm run test:http`, JavaScript syntax checks and `git diff --check` also passed.

Local, ignored artifacts: `output/multi-company/charging-customer-b.png` and `output/multi-company/charging-test-results.json`.
