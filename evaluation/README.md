# Support learning evaluation

`cases.js` contains ten fixed synthetic issues: display, wireless connectivity, battery, printer, VPN, audio, camera, storage, email, and application crashes. Each has a reviewed solution, environment restriction, and two differently worded customer questions.

Run under WSL with Node 22:

```sh
npm run evaluate
npm run evaluate:live
```

The first command is a deterministic regression using local memory and local response policies. The second uses the configured Hindsight and model services in a separate temporary database and Hindsight namespace. It obeys rate limits with bounded retries. Neither sends email, modifies Google calendars, or writes to a real business system.

For each issue, the harness uses the real registration, ticket, handoff, assignment, specialist proposal, and customer acceptance APIs. It then tests two unseen query wordings with memory ON/OFF, an incompatible environment, missing environment details, an unrelated billing question, and feedback reporting that the reused fix failed.

Metrics report correct verified-fix reuse for 20 positive questions, inappropriate recommendations for 30 negative questions, and repeated failed fixes across ten recovery cases. Source IDs, exact reviewed steps, and recovery state are checked. No latency savings or customer-impact percentages are invented. Reports state whether the backend was local or live and are saved under ignored `data/evaluation-*.json`.

This dataset is a regression set, not an independent production accuracy benchmark. Validate additional business-specific issues and real customer outcomes before claiming general support accuracy.

## Separate 30-question challenge

`challenge.js` supplies three new phrasings for each of the ten synthetic issues, frozen before the first run. The reviewed source material is unchanged. Run:

```sh
node scripts/evaluate.js --challenge
node scripts/evaluate.js --challenge --live
```

The report includes a dataset SHA-256, timestamps, intended question count and isolated Hindsight namespace. No challenge questions were added to source symptoms or language rules. This is an author-created challenge, not an independently collected blind benchmark; after running it, treat it as a regression set for future development.

Passing now requires memory OFF to withhold recommendations as well as memory ON to cite the correct solution. Live positive checks also require Hindsight attribution. `memoryOffWithheld` is the safe OFF count; the legacy `correctMemoryOff` field counts exact source steps appearing with memory OFF and should be zero. Timing fields measure harness request latency (including retries), not customer time saved.

Local semantic misses are reported, not hidden or tuned away. Consult the generated challenge report for separate local/live results and limitations. Real participant measurements use `pilot-results.csv` and USER-PILOT.md; no participant results have been invented.
