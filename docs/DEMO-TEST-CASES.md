# Prepared demo test cases

Verified against the current local code on 14 November 2026. These are synthetic rehearsed examples, not a general accuracy benchmark.

## Start and prepare

1. Run `npm start`, then open `http://localhost:3100/demo` (3100 is the current local frontend port).
2. Click **Play the walkthrough**, then **Next step** through all six steps.
3. The walkthrough resets any previous demo state, teaches the fictional flicker fix, and demonstrates Customer B reusing it. Wait until it finishes before trying the cases below.
4. Do not reset or reload into a new session between the comparison cases. The comparison is read-only and uses the walkthrough's `Demo Laptop X1 firmware 4` device automatically.

Say: “This is a prepared synthetic example. The offline matcher recognizes built-in synonyms; unfamiliar wording can still be missed.”

## Full walkthrough: what to show

| Step | Action | Expected result |
| --- | --- | --- |
| 1 | Customer A reports the scripted flicker problem | Standard restart suggestion; learned memory stays 0 |
| 2 | Customer A selects “Still need help” | Case moves to the demo specialist queue |
| 3 | Specialist sends the example fix | Customer confirmation requested; learned memory stays 0 |
| 4 | Customer A confirms “It worked” | Learned memory becomes 1 |
| 5 | Customer B reports the scripted blinking-on-boot paraphrase | The learned flicker fix is suggested with attribution to A's confirmed resolution |
| 6 | Customer B confirms “It worked” | Successful reuse is recorded; the demo finishes |

The walkthrough fills these exact inputs automatically:

Customer A description:
```text
My Demo Laptop X1 screen flickers right after startup. Restarting did not help.
```
Customer A device: `Demo Laptop X1, firmware 4`

Specialist title: `Demo X1 screen flicker after startup`

Applies to: `Demo Laptop X1 firmware 4`

Solution steps:
```text
Fictional demo only: open Display Settings, change Refresh Mode from Adaptive to Fixed 60 Hz, then restart the laptop.
```
Safety restrictions: `None identified` (fictional fixture only).

Customer B description:
```text
The monitor of my Demo Laptop X1 keeps blinking whenever it boots.
```
Customer B device: `Demo Laptop X1 firmware 4`

## Copy-and-paste comparison cases

After the walkthrough, scroll to **Same problem, different words**. Paste each input into **Describe the problem in your own words**, then click **Compare searches**. The two results are separate: KEYWORD SEARCH is a literal-word baseline; OFFLINE CONCEPT MATCHING is the matcher being demonstrated.

| Case | Exact input | Keyword baseline | Offline concept matcher |
| --- | --- | --- | --- |
| 1. Same problem, different wording | The monitor of my Demo Laptop X1 keeps blinking whenever it boots. | Nothing found | Finds `Demo X1 screen flicker after startup` |
| 2. Another valid paraphrase | My Demo Laptop X1 display shimmers when I switch it on. | Nothing found | Finds the flicker fix |
| 3. Different screen symptom | The display of my Demo Laptop X1 stays black when I boot. | Nothing found | Nothing found |
| 4. Another different screen symptom | My Demo Laptop X1 screen is too dim after startup. | Finds a literal-word match | Nothing found |
| 5. Different component | My Demo Laptop X1 keyboard has a sticky key. | Nothing found | Nothing found |

Recommended short sequence: **1 → 3 → 4**. Explain: “It recognizes this known flicker paraphrase. A black or dim screen is a different failure, so the stored flicker fix is withheld. Literal word overlap alone can be misleading.”

## Optional device-compatibility check

Use the **Customer B issue form**, rather than the comparison box, after the walkthrough has finished. Paste:

Description:
```text
The monitor of my Demo Laptop Z9 keeps blinking whenever it boots.
```
Device and version:
```text
Demo Laptop Z9 firmware 9
```

Expected: the learned X1 fix is withheld. The demo offers its standard restart suggestion instead. Do not describe this as “no suggestion at all.”

## Boundaries for this rehearsal

- Show the 25% → 88% card only with its synthetic-data label visible. It is not a measurement from real customers.
- The isolated demo always uses local matching; configuring a neural model does not change this demo.
- The 14 November follow-up fixed the standard-fallback hazard gate: reported burning/smoke/swollen-battery hazards now queue a specialist without offering a learned or standard troubleshooting step. Empty and taught sessions are covered by a regression test.
- These exact cases were checked in the demo's current backend functions. Timing, rendering and any changed demo state should still be rehearsed once in the browser before presenting.
