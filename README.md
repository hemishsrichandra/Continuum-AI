# Continuum AI

Continuum is a front desk for device repair and IT support. It reads the provider's current status and ETA, recalls relevant history, and prepares service actions for customer confirmation. The two fictional providers use different schemas behind a shared adapter interface.

## Run locally

Requires Node.js 20.12 or later. The project has no npm dependencies.

```sh
npm start
```

Open http://localhost:3000/desk. Choose a demo identity and use the prefilled access code `246810`. The frontend proxies API requests to the backend. The backend uses port 5000 when available and chooses an available port when macOS or another app has claimed the default. Set `FRONTEND_PORT` and `API_PORT` to override them.

The default preview uses a local memory ledger and scripted responses. Demo writes persist in `data/demo.json` across restarts. Demo identities and the public demo code are for fictional records only.

## Enable Hindsight and a language model

1. Copy `.env.example` to `.env`.
2. Set `HINDSIGHT_BASE_URL` to `https://api.hindsight.vectorize.io` or your self-hosted API URL. Add your Hindsight API key and use a unique bank prefix.
3. Set `OPENAI_API_KEY`. For a compatible provider, set `OPENAI_BASE_URL` and `OPENAI_MODEL` as well.
4. Set `REQUIRE_LIVE_INTEGRATIONS=true` for the judged run. Chat then surfaces integration errors instead of falling back to local responses. If a confirmed service action succeeds and retention fails, its record is saved locally and memory sync is marked pending.
5. Restart the app and run a comparison. Check that the memory-on response trace says **Hindsight** and shows the configured model.

Hindsight banks are isolated by provider and customer, and recall and reflection use a strict ticket tag. Continuum retains important preferences, outcomes, and confirmed actions. The response shows the provider record and recalled evidence separately. Retiring a ledger entry invalidates its extracted facts in Hindsight and keeps a local audit entry.

## Judge demo

| Identity | Ask | What memory changes |
| --- | --- | --- |
| Alice Morgan | What is the status of my laptop repair? | The ETA comes from the same provider record in both runs. Memory adds her callback preference. |
| Bob Sharma | My phone is still offline. What should I try? | The agent recalls the failed reboot and prepares a handoff. |
| Carol Rao | My VPN is still down. What should I do? | The IT adapter supplies current status. The missed commitments prompt a handoff for network operations. |

1. Open **Memory comparison** and run a suggested question. Expand the evidence chips to show exactly what was recalled.
2. In **Front desk chat**, tell Alice, “Please email me before ordering a replacement screen.” Verify again and run the same status question to show what persisted across sessions. The memory ledger shows the new preference.
3. As Carol, send the suggested chat prompt, review the handoff, and confirm it. Expand **Provider activity** to show the queued record.
4. Use **Reflect** to summarize the current ticket's history, then retire a memory and repeat the comparison.

```sh
npm test
npm run demo
```

The tests use the same request handler as the web server. They cover both provider schemas, confirmation, account isolation, restart persistence, simultaneous booking, memory retirement, and the Hindsight/model API contracts with mocked responses. The CLI demo runs the three comparisons with a separate Hindsight bank prefix when configured.

The hackathon also requires teams to use [Band AI Desktop](https://www.band.ai). Open this folder there and run the commands above for the judged walkthrough. The submission packet separately requires the GitHub repository, demo video, live demo, memory explanation, and each team member's content deliverables.
