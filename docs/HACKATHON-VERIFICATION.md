# Verification — 14 November 2026

This report records checks actually run against the current working tree. It does not assert that every possible user input or external integration has been tested. The main app is running at http://localhost:3100. No GitHub push was performed.

## Results

| Check | Actual result |
| --- | --- |
| Final `npm test` | **471 passed, 0 failed, 2 skipped**; 473 total, about 54 seconds |
| `npm run test:browser` | **14 passed, 0 failed**; existing customer/owner/source/page tests plus external integration |
| `npm run test:http` | Passed routes/assets, SQLite persistence, cookie auth, CSRF, scope guards, sign-out, safe replay, proxy and body validation |
| Demo-specific regression checks | **18 passed**, including the new hazard/fallback regression |
| Full browser accessibility/responsive audit | **30 page/viewport states**; zero detected WCAG A/AA/2.1-AA violations, zero page JavaScript errors, zero document horizontal overflow after fixes |
| Main-app rehearsal | **20 passed** using the prepared synthetic accounts on port 3100 |
| Live Hindsight/retrieval verification | **14 passed** using an isolated synthetic namespace; confirmed retention synced, paraphrase retrieval, rejection, scope and retirement checks |
| Configured model probe | Passed one grounded synthetic request through `compose`; configured model `openai/gpt-oss-120b` returned a response. This is an availability/grounding smoke check, not a broad quality benchmark |
| Synthetic data preparation replay | Passed first preparation and repeat run against an isolated database; same ticket/source IDs retained |
| `git diff --check` | Passed |

The skipped tests require a reachable live ChromaDB at localhost:8000. ChromaDB was unavailable, so no live-Chroma success is claimed. The configured main app uses basic/local knowledge retrieval, which was exercised.

Accessibility pages: Home, How it works, Product, Pricing, Book a call, Privacy, Terms, Security, Interactive demo, signed-out desk, owner Team, owner console, owner Knowledge, integration-key settings and customer desk, at **1280 px and 390 px**. Main-app owner, specialist and customer screens were additionally checked with populated accounts. Screenshots were inspected for the principal layouts. Automated axe checks and sampled keyboard/browser flows do not replace testing every interaction with assistive technology.

## Reproduced issues fixed

1. **Demo standard fallback ignored reported hazards.** Learned retrieval withheld hazardous requests, but the isolated demo could still offer a restart from its hardcoded playbook. The common compatibility/safety gate now runs before either learned or standard suggestions. A burning/smoking/swollen-battery report is queued for a specialist with no troubleshooting attempt. Regression covers both empty and taught demo sessions.
2. **Interactive demo desktop overflow.** The decorative canvas extended outside the document. Its right edge/width are now bounded locally in the demo stylesheet; the 1280 px audit now fits exactly.
3. **Invalid CSS variable expression.** The demo navigation’s `var(--var(--surface))` was corrected to `var(--surface)`.
4. **Stale live-verification assumptions.** The live test script still expected company knowledge to be attributed to Hindsight and assumed a displayed answer was immediately an attempted fix. It now explicitly uses suggestion-choice mode, read-only previews and checks the actual grounded choice content. Hindsight retention and company-pool retrieval are tested as distinct capabilities.

No broad visual redesign or retrieval-threshold relaxation was made. The 21st review reported informational hardcoded-color notices in existing styles/tokens; those were not treated as proven defects or used to justify a color-system rewrite.

## Prepared main-app data

Added five fictional accounts and two explicitly synthetic companies through normal registration/invitation APIs. The primary company has one owner, one Device repair specialist and two customers; the secondary company has its own owner, with Bob additionally holding a customer membership there.

Prepared through authenticated workflows:

- Three reviewed display fixes from a CSV import.
- One reviewed IT VPN fix and one separate printer import waiting for approval.
- A specialist camera fix confirmed by Alice, then explicitly chosen and confirmed successful by Bob.
- A printer solution awaiting Alice’s confirmation, so publication can be demonstrated live.
- An assigned Wi-Fi investigation with ETA, failed attempted step, customer note and future service visit.
- A queued USB case, fresh display/camera/IT requests, and a private second-company router request.
- A revoked main-app integration key created during verification. It actually returned three suggestions before revocation and 401 afterward. No active verification credential was left behind.

The dashboard’s synthetic-data marker is enabled only for the two new sample companies. Existing customer/business data was not reused as demo content. A backup was made at `/tmp/continuum-before-demo-audit-20261114.sqlite` before additions. Comparison afterward confirmed all **9 pre-existing accounts**, their emails and password hashes were preserved. Local `.env` and configured secrets were not changed.

## What the core automated checks cover

Authentication/session/CSRF behavior; invitation/membership rules; staff service access; company/service/customer scope; request creation, notes, replay and validation; suggestion choice and distinct outcomes; standard troubleshooting; specialist handoff, assignment, progress and confirmation; publication and overdue labelling; retirement, revisions and failed-fix review; source preview/sync/paging/checkpoint/retry and network restrictions; knowledge imports/privacy redaction/review; embedding/index consistency; external API credentials, audience, revocation, limits and conversation references; privacy export/erasure; service and public booking rules; worker lanes; owner intelligence/status; public demo isolation and guided flow.

These feature families have tests, but this report does not claim every family received a new manual browser test in this pass. The main walkthrough, API-key flow, six-step demo and sampled UI states were separately exercised in real browsers.

## Retrieval quality and limitations

Fresh offline evaluations used independent queries and preserved the current gates:

| Synthetic set | Positive matches | Wrong recommendations on negative controls | Failed fixes repeated |
| --- | --- | --- | --- |
| Regression | 20 / 20 | 0 / 36 | 0 |
| Challenge | 27 / 30 | 0 / 36 | 0 |
| Held-out | 29 / 30 | 0 / 36 | 0 |

Memory-off controls withheld learned recommendations for all positive questions in all three sets. The four missed paraphrases concern brightness alternation, charge disappearing while idle, inaudible built-in speakers, and a stuck mailbox. The workflow escalated instead of inventing a fix. These are known limitations of local matching; no synonym/threshold change was made simply to improve the reported score. Use the rehearsed, grounded inputs in the walkthrough and do not present this as universal language understanding.

## Setup-dependent features

- **Email/recovery/verification delivery:** no configured sending account. Controls and token/delivery logic have automated coverage; actual inbox delivery was not performed.
- **Google Calendar OAuth:** not configured. Booking and calendar-file export work; external Google account synchronization was not tested live.
- **Real company databases/platforms:** fixture CSVs use the real importer. No live PostgreSQL/MySQL/SQL Server/REST company database or named external chatbot platform was connected for this pass. Adapter tests do not establish a live customer deployment.
- **Automatic deadlines:** covered with controlled test clocks. No production clock manipulation, artificial backdating of sample outcomes or forced overdue publication was used.
- **Payments:** pricing pages are informational. The app does not process a payment during this demo.

## Evidence and reproduction

The final walkthrough is [HACKATHON-WALKTHROUGH.md](HACKATHON-WALKTHROUGH.md). Local ignored machine-readable evidence is in `output/hackathon-verification-2026-11-14/`: UI audit, main-app rehearsal, model probe and retrieval evaluations. The live verification report is `data/live-verification-54bb8e9e.json`. Synthetic preparation progress/IDs are in `data/hackathon-demo.json`.

Commands run include `npm test`, `npm run test:browser`, `npm run test:http`, `npm run verify:live`, the demo regression files, 21st review and `git diff --check`. The broader page audit and main-app rehearsal used temporary Playwright scripts; their results are saved in the local evidence directory. Existing tests and these scripts used temporary servers or the newly authorized synthetic company; real user credentials were neither reset nor exposed.
