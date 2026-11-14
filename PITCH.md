# Continuum: the pitch

**One line:** support that remembers what worked. A fix a customer confirms becomes the answer for the next customer with the same problem, checked against their device and your safety rules, and private to your company.

Everything below is true of the code in this repository today. Every number says where it came from and what it does not prove. The older reports are archived in [`docs/`](docs/DOCS.md); you do not need them to judge this.

---

## 3-minute script

Run `npm run seed:sample` once, then `npm run serve:sample` (open `http://localhost:3300`). The sample company is synthetic and says so on screen. This rehearsal disables the chat model, external memory, and neural embeddings; it demonstrates reviewed knowledge reuse with local matching. For the isolated offline demo page alone, no setup is needed: `npm start`, then `/demo`.

| Time | Say | Show |
|---|---|---|
| 0:00 | "Support teams solve the same problem again and again, and the answer lives in one specialist's head." | Home page. Let the **Watch a fix teach the system** timeline play: fix fails → specialist solves → customer confirms → next customer helped. |
| 0:25 | "Watch it happen." | `/demo` → **Play the walkthrough**. Click *Next step* through Customer A's flickering screen, the failed standard step, the specialist's fix, A's "It worked". Memory counter goes 0 → 1. |
| 1:10 | "Customer B says the same thing in different words." | Step 5: B writes "the monitor keeps blinking whenever it boots" and gets A's fix straight away. |
| 1:30 | "This offline example recognizes synonyms and checks the failure symptom." | Scroll to **Same problem, different words** → *Blinking on boot*. Compare literal keywords with **offline concept matching**. Then try a sticky key or a screen that stays black: neither should reuse the flicker fix. Explain that unfamiliar wording can be missed and incorrect matches remain possible outside tested cases. |
| 2:00 | "Now the company's view." | Sign in as the sample owner. **How support is going**: *Repeat problems answered without a specialist*, 25% before the first reusable fix, 88% after, labelled **SYNTHETIC SAMPLE DATA**. |
| 2:25 | "Trust and control." | Open the customer view: the progress strip (*standard step didn't help → company fix worked → specialist not needed*), the *Why this fits* line, *Where this came from*. Click **Take a 30-second tour**. |
| 2:50 | "Nothing here is a black box, and nothing is claimed that we did not measure." | Close on the limits table below. |

### 60-second fallback (record this once)

No video is checked in: it has to be a screen recording of your own machine. Shot list, exactly one minute, no narration needed (use captions):

1. 0–10 s: home page timeline. 2. 10–35 s: `/demo`, *Play the walkthrough*, pressing *Next step* quickly. 3. 35–50 s: the keyword-vs-meaning card, *Blinking on boot*. 4. 50–60 s: the owner dashboard, the 25% → 88% card with its SYNTHETIC label.

If the network fails on stage, `npm start` on a laptop is enough: the `/demo` page keeps its state in memory for your session only, with no database and no external service.

---

## What is measured, and what it does not prove

| Claim | Number | How it was measured | Does **not** prove |
|---|---|---|---|
| Right fix found for a reworded problem | Regression 20/20 · challenge 27/30 · held-out 29/30 · validation 20/30 · typo sets 20/30 and 18/30 | `node scripts/evaluate.js [--challenge\|--holdout\|--validation\|--informal\|--informal2]`; fresh query-only tickets; [record](evaluation/remediation-results.json) | Real customers. These are invented wordings written by the authors. |
| Incorrect suggestions in tested negatives | **0 of 36 negatives recommended in each set**; 0 memory-off leaks; 0 repeated failed fixes | Wrong device, missing environment, unrelated questions and six same-device different-symptom cases | General accuracy or safety. The added six negatives repeat across sets; these are 216 evaluated cases, not 216 independent questions. |
| Repeat problems answered without a specialist | **25% before the first reusable fix (1 of 4), 88% after (7 of 8)** | `npm run seed:sample` drives the real API (requests, chat, outcomes, hand-offs, confirmations) in that order | Anything about real customers: **synthetic**, tiny, and a before/after of different requests, not a controlled experiment. |
| Scale | **10,000 stored fixes, 50 simultaneous chats: about 7 s to clear the whole round; one retrieval about 123 ms** (was 668 ms and about 23 s before this round's index and query-plan fix) | `npm run load-test`; in-process, one Node thread, offline embeddings, SQLite only | Network, browser or remote-embedding latency. It is roughly 7 chats per second per process: fine for a pilot, not for a large launch without more work. |
| Automated checks | Current results and skipped checks are recorded in [the remediation plan](docs/REMEDIATION-PLAN.md) | `npm test`, `npm run test:http`, `npm run test:browser` | Live service reliability or general answer accuracy. |
| Accessibility | **0 axe violations** (WCAG 2.2 AA tags) on the owner overview, cases, knowledge and team views, the customer conversation, visits and activity views, and every step of the owner and customer tours (the scan caught a contrast failure in the new tour card, now fixed) | axe-core in the browser against the sample company | The specialist tour, public pages and the demo page were not scanned this round, and no manual screen-reader testing has been done. |

### Not done, on purpose and in the open

- **Offline generalisation is weak.** On the separate 32-paraphrase semantic corpus, the historical SQLite and Chroma-local recall@3 were 9.4% and 3.1%. After the conservative symptom gate, the current SQLite result is **3.1%**; current Chroma was unavailable. The higher six-set scores above use different, familiar vocabulary and do not establish general semantic quality. See [the measured record](evaluation/remediation-results.json).
- **Neural embeddings remain unmeasured.** Configure a dedicated `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_API_KEY`, then run `npm run benchmark:semantic` with Chroma running. Chat credentials are separate. The regular application supports neural embeddings; the isolated `/demo` always uses local matching. Better recall must be measured rather than assumed.
- **Precision has a recall cost.** Under the same independent-query protocol the old code returned five wrong display suggestions per set. The new gate rejects those, but also withholds some valid unfamiliar descriptions. Historical pitch numbers used source-conditioned tickets and are not directly comparable.
- **No real pilot yet.** The protocol is in [`docs/USER-PILOT.md`](docs/USER-PILOT.md) and `scripts/pilot-replay.js` replays real solved tickets. A few quotes from 3–5 real support people would be worth more than any feature here.
- **Tickets still live in a JSON-collection store**, not proper SQL tables. That is the largest architectural gap and a project of its own.

---

## What was built to make the AI visible and safe

- **Literal keywords vs offline concept matching**, side by side on the demo page. The concept matcher checks problem relevance, device compatibility and safety. Device words alone never count as a keyword match. This is a lexical baseline comparison, not a neural-model benchmark.
- **"Why this fits"**: one grounded sentence per suggested fix. A model (when a key is configured) may only describe the stored text; the answer is rejected unless it is one short sentence with no new number, link, command, quote or unfamiliar words, and otherwise a template restates the stored fields. Customer text is scrubbed before it leaves, and credential-like text is never sent.
- **Near-miss learning**: "Still need help" can say why (nothing changed / different problem / couldn't do a step / made it worse). The failure is stored with device and version facts only, never the customer, and lowers that fix's rank only for customers in a similar situation (a failure on firmware 5 says nothing about firmware 4). The effect is capped.
- **Stale-fix detection**: a fix is flagged when its recent success rate drops, when it has not been reconfirmed for 180 days, or when several recent customers *on the same model* report a newer version than the fix covers. Nothing changes automatically.
- **Customer progress**: "tried A, trying B, a specialist is next", on the conversation itself.
- **Role tours** (customer, specialist, owner): four or five one-sentence steps, keyboard-operable, closable with Esc.

## Questions you will be asked

**"Is this a trained model?"** No. It stores and retrieves reviewed fixes; no model weights change. The model, when configured, only rephrases or explains stored text.

**"What stops it recommending something dangerous?"** Safety restrictions and device/version conditions are checked before ranking and similarity can never override them. Imported and unconfirmed fixes are labelled as such, and credential-like or risky instructions are rejected on the way in.

**"What if a fix goes bad?"** Two consecutive failures or a drop in reliability pauses it for review; near-misses demote it for similar customers; stale-fix detection surfaces it before customers hit it.

**"Where does customer data go?"** Each company's knowledge stays its own. Personal details are removed before anything is saved for reuse. A model sees customer words only if the company configured one, and only after scrubbing.

**"How would you scale it?"** Add the vector index (ChromaDB, already supported with an optional access token), move to more than one process, and move tickets into SQL tables. The load test shows where the limit is today instead of guessing.

## Current verification

The old batched-sync failure note is obsolete. Use [the remediation plan](docs/REMEDIATION-PLAN.md) for the current test record and deferred live checks. GitHub Actions runs regression/HTTP checks on Node 20 and 22, plus browser checks on the recommended Node version; local validation does not establish a remote CI result.

## Housekeeping a judge may ask about

- Git history was scanned for secrets: `.env` was **never committed** and none of the current keys appear in any commit. Rotate the exposed keys anyway (Groq, Hindsight, Resend, Google client secret): [`docs/SECURITY-HOUSEKEEPING.md`](docs/SECURITY-HOUSEKEEPING.md).
- Per-service staff permissions, scheduled source sync and an optional Chroma access token (`CHROMA_TOKEN`) already exist. This round added job reconciliation (failed, late and abandoned updates to the company's ticket system now show in the owner's status panel) and a key-rotation script.

## Run it

```bash
npm install
npm test                 # the suite
npm run seed:sample      # synthetic sample company with before/after history
npm run serve:sample     # http://localhost:3300 with every external service switched off
npm run load-test        # 10,000 fixes, 50 simultaneous chats
```

More: [`README.md`](README.md) · [`SETUP.md`](SETUP.md) · [`docs/`](docs/DOCS.md) (architecture, audits, test reports, older write-ups)
