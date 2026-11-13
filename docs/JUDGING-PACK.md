# Judging evidence pack

Start with [the challenge results](../output/CHALLENGE-RESULTS.md). They report the new dataset, local/live behavior, individual misses and limitations. Read the live column only when the completed live report is present; do not substitute local checks for live integration evidence.

## Present

- [Four-minute demo script](JUDGE-DEMO.md): setup, exact synthetic inputs, timed scenes and rehearsal checklist.
- [Final functional test report](FINAL-TEST-REPORT.md): previously completed manual, automated and accessibility checks.
- [Current findings](TESTING-FINDINGS.md): fixes, known limitations and deferred external setup.

## Reproduce

In WSL, with the project's Node 22 installation on PATH:

```sh
npm test
node scripts/evaluate.js --challenge
node scripts/evaluate.js --challenge --live
node scripts/summarize-evaluation.js data/evaluation-LOCAL_RUN.json data/evaluation-LIVE_RUN.json
```

Use actual report filenames printed by the runs. The local challenge can exit nonzero because its conservative matching misses paraphrases; this is recorded evidence, not a setup instruction to disable safeguards. Live evaluation uses paid configured services and isolated test data. Avoid repeating it just before presenting unless the code or configuration changed.

## Gather the next evidence

- [Participant protocol](USER-PILOT.md) and [blank observations CSV](../evaluation/pilot-results.csv): run with 3–5 consenting people unfamiliar with the app.
- [Business gateway contract](PROVIDER-GATEWAY.md): use when a real partner and endpoint exist.
- [Integration setup](../SETUP.md): email and Google credentials/consent are deferred to the user.

## Claims to avoid

Do not call synthetic results production accuracy; do not claim model-weight training, a real business deployment, measured time savings, a completed user study or a recorded demo without that evidence. The previous rubric score is an estimate, not an award or a guaranteed score after these tasks.
