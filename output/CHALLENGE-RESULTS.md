# Synthetic challenge evaluation results

These are recorded API-harness results, not a browser rehearsal, human usability study or production accuracy benchmark. The questions were authored before the challenge run and were not added to the reviewed resolution sources or matching rules.

Dataset: synthetic challenge v1. SHA-256: `fca84197c9a223a295f345436f572442d3b4fe6de9333192403a1834af82098d`.

| Measure | local deterministic regression | live Hindsight/model |
|---|---|---|
| Run / completed at | ea7648c4 / 2026-11-06T16:22:54.315Z | bd80dcd8 / 2026-11-06T16:31:42.897Z |
| Completed domains | 10/10 (100.0%) | 10/10 (100.0%) |
| Positive questions evaluated | 30/30 (100.0%) | 30/30 (100.0%) |
| Correct source-backed fix with memory ON | 16/30 (53.3%) | 30/30 (100.0%) |
| Fix withheld with memory OFF | 30/30 (100.0%) | 30/30 (100.0%) |
| Negative questions with no inappropriate recommendation | 30/30 (100.0%) | 30/30 (100.0%) |
| Recovery scenarios fully verified | 2/10 (20.0%) | 10/10 (100.0%) |
| Median ON request latency, milliseconds | 32 | 5375 |
| Median OFF request latency, milliseconds | 27 | 912 |
| Overall harness result | NOT PASS | PASS |

Each domain adds three negative controls: conflicting environment, missing environment and unrelated billing. These repeated control types do not represent 30 independently sampled real-world hazards. A recommendation is correct only if its source ID and exact reviewed steps match; live runs also require Hindsight attribution. Latencies include service time and bounded retries; they do not measure customer time savings.

Recovery requires a saved initial recommendation. If that recommendation was missed, the recovery scenario cannot be verified. Do not interpret a zero repeated-fix counter as success for an unexercised recovery path.

## local deterministic regression

Full synthetic evidence: [evaluation-ea7648c4.json](evaluation-results/evaluation-ea7648c4.json).

| Domain | Correct ON | Safe OFF | Negative controls | Recovery verified |
|---|---:|---:|---:|---|
| display | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | No |
| wireless | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | No |
| battery | 0/3 (0.0%) | 3/3 (100.0%) | 3/3 (100.0%) | No |
| printer | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | No |
| vpn | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| audio | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | No |
| camera | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| storage | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | No |
| email | 2/3 (66.7%) | 3/3 (100.0%) | 3/3 (100.0%) | No |
| application | 1/3 (33.3%) | 3/3 (100.0%) | 3/3 (100.0%) | No |

### Missed or failed positive checks

| Domain | Question | ON decision | OFF withheld |
|---|---|---|---|
| display | Every time the computer starts, the picture rapidly alternates between bright and dark. | status | Yes |
| wireless | I keep getting kicked off the wireless network and have to reconnect. | status | Yes |
| wireless | The Wi-Fi works briefly, loses its connection, then does it all over again. | status | Yes |
| battery | A full charge disappears far too soon, even when the computer is doing very little. | status | Yes |
| battery | The battery percentage falls unusually fast while the notebook sits idle. | handoff | Yes |
| battery | I unplug the laptop and it runs out of battery much sooner than it should. | handoff | Yes |
| printer | A sheet is trapped in the printer and the job cannot continue. | status | Yes |
| printer | Printing has stopped because paper is wedged in the feed path. | status | Yes |
| audio | A video is playing but nothing can be heard from the built-in speakers. | status | Yes |
| audio | The speakers stay completely quiet when I play audio. | status | Yes |
| storage | I cannot save anything because the drive has no room left. | status | Yes |
| email | My mailbox has stopped updating with new messages. | status | Yes |
| application | The program quits unexpectedly as soon as I launch it. | status | Yes |
| application | I launch the app, then its window unexpectedly closes before I can use it. | status | Yes |

## live Hindsight/model

Full synthetic evidence: [evaluation-bd80dcd8.json](evaluation-results/evaluation-bd80dcd8.json).

| Domain | Correct ON | Safe OFF | Negative controls | Recovery verified |
|---|---:|---:|---:|---|
| display | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| wireless | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| battery | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| printer | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| vpn | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| audio | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| camera | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| storage | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| email | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |
| application | 3/3 (100.0%) | 3/3 (100.0%) | 3/3 (100.0%) | Yes |

## Limits and next evidence

- Synthetic reviewed steps establish workflow behavior, not that the advice repairs real equipment.
- The dataset is now observed. Keep it as a regression set; obtain independent customer wording for the next blind evaluation.
- Same-language, ten-domain sample only. Other languages, complex multi-issue tickets and adversarial prompts need separate evaluation.
- This challenge does not replace the existing publication, retirement, company-isolation and HTTP regression checks.
- No real participants, customer-time savings, business deployment or screen recording are claimed. Use USER-PILOT.md and JUDGE-DEMO.md for those next steps.
- Live runs use separate temporary databases and Hindsight namespaces. Synthetic cloud memories may remain in the recorded namespace; existing workspace records are not used.
