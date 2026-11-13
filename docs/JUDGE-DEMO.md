# Continuum: four-minute judging demonstration

## Claim to demonstrate

Continuum remembers reviewed support outcomes, applies them only to matching problems, and stops reusing a fix when failure feedback requires review. It retrieves knowledge; it does not retrain model weights.

All device names and fixes in this demonstration are synthetic fixtures, not hardware advice. Evaluation results are not customer-success measurements.

## Prepare before presenting

1. Start the existing app with `bash scripts/start-wsl.sh` under WSL. Open http://localhost:3100.
2. Use a dedicated demo company with separate customer A, customer B and owner/specialist sessions. Use separate browser profiles so cookies cannot silently switch roles. Label the windows clearly.
3. Create A's request: **Demo screen flicker**, description: **My Model X laptop on firmware 4 has a flickering screen after startup. Restarting did not help. Please email me instead of calling.**
4. Create B's request: **Demo flashing screen**, description: **My Model X laptop on firmware 4 has a flashing screen after startup.**
5. Ensure no published matching resolution already exists in this demo company. A fresh company avoids knowledge from older rehearsals affecting the baseline. Do not delete the user's existing records.
6. Stage A's confirmed specialist handoff. In the specialist console claim it, record the unsuccessful restart and a short progress update. Leave the solution unpublished until the demonstration.
7. Prepare this synthetic proposal in a local note for easy typing: title **Demo display profile fix**; symptoms **Screen flickers after startup**; environment **Model X firmware 4**; steps **Open Display Settings, select the Standard display profile, save, then check whether the flickering stops.**
8. Check that model and Hindsight services work. After publication wait for **synced**. A pending/local result is not proof of cloud memory.

## Timed script

| Time | Action shown | What to say and verify |
|---|---|---|
| 0:00–0:30 | B asks “The panel flashes when the laptop starts. Is there a known fix?” | “This company has no verified solution yet.” Verify no fix is invented. |
| 0:30–1:10 | Specialist opens A's case history, then proposes the staged synthetic solution | “The specialist receives the problem and attempted fix, so the customer does not start over.” The proposal must await customer confirmation. |
| 1:10–1:40 | A confirms success; specialist library shows published/synced | “A proposed answer is not knowledge until the customer confirms it worked.” |
| 1:40–2:25 | B asks “The image blinks as my notebook boots. What helped with this?” Open Sources & response details | Verify exact reviewed steps, Hindsight attribution and compatible environment. “Another customer benefits from the reviewed outcome.” |
| 2:25–2:55 | B opens Memory lab and compares the same question ON/OFF | ON should retrieve the fix; OFF should withhold it. The comparison must not submit an action. Explain that withholding is safer than guessing. |
| 2:55–3:35 | On B's saved recommendation, choose Still need help; complete any confirmation shown | Verify reopened request, specialist case/history and resolution review pause. Ask again; the failed steps must not be repeated. |
| 3:35–4:00 | Show the challenge evaluation results and name its limits | State the actual live score, sample size and synthetic nature. “Next we measure outcomes with real customers.” Do not substitute the old regression score for the new challenge result. |

## Rehearsal checks

- [ ] Separate roles and company names are visible; account changes are not needed mid-scene.
- [ ] Baseline has no matching published fix; pending proposals cannot be reused.
- [ ] Publication reaches synced before B's learned response.
- [ ] A source-backed answer is shown, not just plausible generated text.
- [ ] The failure path reopens/escalates and withholds failed steps.
- [ ] The full sequence finishes in four minutes; record actual duration.
- [ ] Prepare a screen recording of a successful real run, labelled with its date and test environment. No recording is included or claimed yet.

If a live dependency fails, state the failure and use a clearly labelled earlier recording or evidence report. Do not present local fallback as live Hindsight. Rehearsal boxes above require a presenter run; this document itself does not prove rehearsal.

## Optional judge questions

**Why not an ordinary FAQ?** Knowledge is connected to a completed service workflow and customer outcome; applicability, failures and retirement affect future reuse.

**Can one company see another's fixes?** The app scopes knowledge and records by company and service. Report the isolation checks already completed; do not claim an independent security audit.

**What impact have you measured?** Synthetic retrieval and guardrail behavior are measured. Real customer time savings and adoption are not yet measured.

**What is not connected?** Real email delivery, Google consent/sync and a business service await the user's setup. They are optional for demonstrating this learning loop.
