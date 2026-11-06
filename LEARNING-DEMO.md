# Continuum: human resolution becomes useful memory

## What the documents establish

The original proposal explicitly describes learning from outcomes, avoiding failed fixes, human escalation, and becoming the support team's collective memory. Its concrete acceptance scenarios concentrate on returning customers, and its privacy section isolates provider/customer memory. It does not explicitly define the complete cross-customer publication/approval workflow. The hackathon guide explicitly encourages domain expertise from past conversations and visible improvement over time. The reviewed-resolution workflow bridges these requirements without sharing private customer transcripts.

## Current workflow

1. Customer A creates a request and asks a troubleshooting question.
2. The assistant uses private history and any matching human-verified resolutions. Without either, it provides a general response or prepares a handoff; local mode is labeled and is not evidence of live AI performance.
3. Customer A requests a specialist. The handoff contains their service context.
4. An authorized specialist opens `/operator`, reviews the case, and enters matching symptoms, applicable environment, and verified solution steps.
5. The specialist explicitly confirms that the solution worked and that reusable content contains no customer-identifying details or credentials. Basic email/phone/credential checks supplement this human review; they are not an automatic anonymization guarantee.
6. The resolution is persisted, sent to A as a specialist follow-up, and retained in a separate provider knowledge bank in Hindsight. Private conversation history remains customer-scoped.
7. Customer B in the same service business asks a similar question. Recall retrieves active approved resolutions; the model receives them as evidence and should check applicability before recommending steps.
8. Compare the same query with memory OFF. Inspect sources, learned-resolution count, memory backend, and model backend. Retire obsolete knowledge in the specialist console and repeat.

The current service businesses are the two existing provider namespaces, repair and IT. Shared resolutions never cross that boundary. This is not yet a multi-company SaaS tenancy model; separate companies must not share one provider namespace.

## Provision the specialist

Create a real staff account at `/desk`. Then, as the local application owner, run:

```sh
node scripts/grant-staff.js your-staff-email@example.com repair
```

Use `it` instead of `repair` for IT support. Open `/operator` while signed in. Public registration never grants staff permissions. Customer B must use a separate customer account in the same service workspace.

## Required configuration for the actual learning demo

Put credentials in `.env`, not in chat:

```dotenv
HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io
HINDSIGHT_API_KEY=your_hindsight_key
HINDSIGHT_BANK_PREFIX=continuum-your-team
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_model_key
OPENAI_MODEL=gpt-4o-mini
REQUIRE_LIVE_INTEGRATIONS=true
```

Use the Hindsight Cloud UI to create your account/key, or run the open-source Hindsight service and supply its URL. The model endpoint can be an OpenAI-compatible provider; use that provider's base URL, key, and exact model identifier. Restart after changing configuration. Strict mode must report API failures rather than passing off local fallback responses as a live demonstration. Verify the response details show Hindsight and the configured model, and that resolution publication reports `synced`. A `local` or `pending` status does not prove live Hindsight learning.

Email and Google Calendar are optional for this demo. See SETUP.md only if you want verification emails or calendar sync. In local development, accounts can be created without email configuration; production requires email verification.

## Grading alignment

| Criterion | Weight | Demonstrable evidence |
| --- | --- | --- |
| Innovation | 30% | A real human resolution improves a separate customer's answer, rather than simply replaying the same customer's preference. |
| Hindsight Memory | 25% | Retain after human verification; Recall before B's answer; inspect provenance; compare OFF; retire obsolete knowledge. Live credentials are essential. |
| Technical implementation | 20% | Staff authorization, customer isolation, SQLite durability, provider separation, explicit applicability, privacy review, and regression tests. |
| UX | 15% | Customer chat → specialist queue → published resolution → B's better response, with visible source/sync state. |
| Impact | 10% | Measure repeat escalations and correct reuse on held-out similar questions. Do not invent savings or percentages from a single synthetic case. |

The automated cross-customer regression is in test/learning.test.js. It verifies before/after, OFF, unrelated queries, private-context exclusion, staff authorization, and retirement. It is a local deterministic regression, not a live semantic-retrieval benchmark.

A live synthetic run on November 6, 2026 used Hindsight Cloud and Groq's `openai/gpt-oss-120b`. Human resolution publication reported `synced`; B retrieved zero verified resolutions before publication, one afterward, zero with memory OFF, and zero after retirement. The generated answer used the verified fix. Evidence is saved in `data/live-verification-0cfaa9e2.json`. Run `node scripts/verify-live.js` to repeat in an isolated temporary database and separate Hindsight bank namespace. This validates the integration and learning workflow for one case; paraphrased held-out queries and broader answer-quality evaluation remain needed.

The guide also requires Hindsight, use of Band AI Desktop, a repository, demo video, live judge demonstration, an explanation of memory use, and the specified article/social/video deliverables. These external submission requirements are not completed by source-code changes. There is no guarantee of a judging score.
