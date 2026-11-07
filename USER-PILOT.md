# Small usability and impact pilot

Status: prepared, not conducted. Recruit 3–5 people unfamiliar with Continuum. Use pseudonymous participant IDs and synthetic issues; do not collect passwords, personal support records or recordings without consent.

## Run each session

1. Explain: “We are testing the app, not you. You may stop at any time.” Ask permission to take notes and, separately, to record if needed.
2. Give the participant a company signup link and a synthetic issue with explicit model/version details. Start timing when the task is shown. Do not tell them which button to press.
3. Ask them to create a request, ask for help and find its current status. Record completion, errors, hesitation and any help given.
4. Act as specialist in a separate account. Ask the participant to find your progress update and confirm or reject the proposed solution according to the supplied scenario.
5. Give them a similar new request where a compatible confirmed fix exists. Ask them to find the fix and its source. In a failure scenario ask them to report that it did not work and find what happens next.
6. Ask: “What do you think happens next?”, “Whose workspace are you in?”, and “What was confusing?” Record their own words without coaching.
7. Ask for ease rating 1–5 (1 very difficult, 5 very easy). Thank them. Stop timing at the task's completion, not at the end of discussion.

Use `evaluation/pilot-results.csv` for raw observations. One row per task, including failures. Keep participant identities outside the repository.

## Measure without exaggeration

- Task completion: completed without assistance / all attempts. Report assisted and failed attempts separately.
- Time: report median time and range for completed tasks, plus failure counts. Do not silently discard failed attempts.
- Customer effort: count messages, confirmations and requests for help using one definition consistently.
- Learning comparison: use equivalent synthetic tasks with and without an already reviewed fix. Alternate order across participants to reduce practice effects. Include specialist waiting time separately from active user time.
- Any percentage reduction must name its baseline, sample size and method. A 3–5-person convenience sample is an exploratory pilot, not general proof of productivity gains.
- Before recruiting, choose a practical target: e.g. at least four of five participants complete request creation and find status without help. Do not change the target after seeing results.

## Turn observations into fixes

For each problem record the task, exact observed behavior, expected behavior, impact and reproducible steps. Prioritize blocked tasks, wrong role assumptions, unsafe advice and lost updates. Fix the highest-impact issue, then rerun that task with another participant. Do not build extra features merely because a participant suggested one.

## One real-business pilot, when a partner exists

Use PROVIDER-GATEWAY.md to agree the service contract and customer mapping. Start with a small set of non-sensitive test records and read-only access. Compare imported IDs/statuses with the source. Only enable writes after the owner confirms the mapping and idempotency behavior; demonstrate one request and one note reaching the source, retry without duplicates, and source status returning to Continuum. Record observed results and outages. A mock gateway is preparation, not an actual business connection.

Human inputs still needed: participants and consent, a presenter for the timed rehearsal/recording, and an actual business partner/endpoint. Credentials and password entry remain deferred as requested.
