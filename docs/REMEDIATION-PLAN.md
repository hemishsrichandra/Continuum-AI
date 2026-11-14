# Project review remediation — 14 November 2026

Baseline: `869e414`. This plan tracks the verified findings from the project review.

| Phase | Changes | Completion check | Status |
| --- | --- | --- | --- |
| 1. Matching correctness | Shared symptom relevance gate; keep environment checks independent; same-device different-symptom negatives in tests and evaluations | Reported false matches rejected in demo and customer workflow; valid paraphrases and safety cases checked; six evaluation sets rerun | Complete |
| 2. Client rate limits | Safe client identity through internal proxy; explicit trusted upstream proxies; consistent authentication/booking buckets | Separate clients receive independent budgets; forged headers cannot select a bucket; existing account limits remain | Complete |
| 3. Claims and worker scope | Correct pitch/README/demo labels and setup; replace full-store reads in follow-through with targeted queries; document remaining architecture work | Claims tied to current evidence; worker behavior and tenant isolation tests pass | Complete |
| 4. Verification and CI | Install declared development dependencies; run full suite, HTTP, browser and retrieval checks; add GitHub Actions | Record actual results and skipped/unavailable checks below | Complete locally; remote CI awaits a push |

## Follow-up requiring external input

- Neural benchmark: configure a dedicated embedding endpoint, model and key, then run `npm run benchmark:semantic`. Compare recall and false suggestions on the same corpus; improvement is not assumed.
- Hosted deployment and recorded video: choose a host and submission destination, rehearse the intended demo, then record/publish.
- License: the owner must choose the intended permissions before adding a license.
- Pilot: obtain consent and real solved tickets; run the replay tooling and report the sample size and limitations.
- Larger architecture work: migrate JSON ticket collections into dedicated tables, finish replacing unscoped store access, and refactor large modules independently after the correctness fixes.
- Lower-priority UX/capacity work: replace raw outcome labels, add a specialist to the synthetic sample company, and assess a bounded password-hashing queue under realistic load. Keep the password-strength requirement.

## Validation record

Checks ran on macOS with Node 20.20.2. Tests that open local listeners were run with local networking enabled; the initial sandbox-only run failed because loopback listeners were blocked, not because of application assertions.

| Check | Result |
| --- | --- |
| `npm test` | **469 tests: 467 passed, 2 skipped, 0 failed**. Skips are the two live Chroma suites; Chroma was unavailable. |
| `npm run test:http` | Passed. Isolated database; pages, auth, CSRF, proxy, validation, isolation and replay. |
| `npm run test:browser` | **13 passed, 0 failed**, headless installed Chrome. Installed the already-declared `playwright-core` dependency; package/lock files were unchanged. |
| Six `evaluate()` runs | Independent-query scores: **20/20, 27/30, 29/30, 20/30, 20/30, 18/30**; **0/36 incorrect recommendations per set**, zero memory-off leaks, zero repeated failed fixes. |
| Same-protocol baseline at `869e414` | **20/20, 27/30, 29/30, 24/30, 22/30, 22/30**; **5/36 incorrect recommendations per set**. Baseline was run from a temporary snapshot using the corrected evaluator and the same added negatives. |
| `benchmark:semantic` | Current SQLite recall@3 **0.031**, 0/18 forbidden recommendations. Chroma and neural rows unavailable, not estimated. |
| Worker-scope regression | Overdue publication runs without reading `store.data` and uses scoped writes; a foreign tenant's identically named ticket cannot suppress a local SLA escalation. |
| Proxy security regressions | Verified client budgets, independent login/signup clients, right-to-left trusted-proxy traversal, forged/internal-header rejection, canonical IPv4/IPv6 identity, consistent booking identity. |
| File checks | `git diff --check`, JSON parsing, YAML parsing, JavaScript syntax checks passed. |
| GitHub Actions | Workflow added for Node 20/22 regression and HTTP checks and Node 22 browser checks; not executed remotely in this session. |

## Matching behavior and evidence limits

The shared gate requires `S_hybrid >= 0.5` and evidence of a stored failure concept when that failure is recognized by the existing synonym/typo vocabulary. Matching a device, component or startup timing cannot replace a missing recognized failure. Existing safety/device gates and the final ranking threshold remain in force. This is conservative offline matching, not a general semantic classifier; it can miss unfamiliar valid descriptions, and does not prove that all false matches are eliminated.

The six added display negatives repeat across all six sets. The total of 216 evaluated negative cases is not 216 independent questions. Current results and misses are in [remediation-results.json](../evaluation/remediation-results.json); the older pitch's source-conditioned counts use a different protocol. Recall floors were deliberately rebaselined for independent requests and the stricter symptom policy, rather than adding synonym rules to fit the evaluation misses. The before/after record makes the loss of recall visible.

No live model, neural embedding, Hindsight, real connector, hosted deployment, pilot or load-test result is inferred from these offline checks. The recorded historical load test is unchanged.
