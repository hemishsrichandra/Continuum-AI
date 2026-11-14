# Continuum — ready-to-present demo

Prepared and rehearsed on **14 November 2026** in the main app at **http://localhost:3100**. Use this guide instead of older demo notes that describe earlier UI or retrieval behavior.

All accounts and examples below are fictional. The new company is **Continuum Solutions**. Existing accounts and companies were preserved; no GitHub push was made. The prepared records came through the normal authenticated application APIs, not fabricated dashboard counters. A separate tenant demonstrates company isolation.

## Sign in

Open [Sign in](http://localhost:3100/desk). All five demonstration accounts use:

**Password: `ContinuumDemo!2026`**

| Account | Email | What to show |
| --- | --- | --- |
| Avery, owner | `showcase-owner@example.test` | Company dashboard, services, team, imports, API keys |
| Sam, specialist | `showcase-specialist@example.test` | Case queue, assignment, progress, solutions and knowledge review |
| Alice, customer | `showcase-alice@example.test` | Three suggestions, pending specialist confirmation, active Wi-Fi case and scheduled visit |
| Bob, customer | `showcase-bob@example.test` | Customer-confirmed camera reuse, IT support and company switching |
| Jordan, other owner | `showcase-other-owner@example.test` | Separate Tenant (synthetic), isolated from the first company |

Use separate browser profiles/incognito windows for different roles. Tabs in the same browser profile share the sign-in cookie: signing in as Bob in another tab also changes Alice’s session. The app checks workspace changes on submissions.

For the short presentation, keep the **owner** and **Alice** in separate browser profiles. Have **Sam** and **Bob** available if time permits. Stay on **port 3100**; port 3500 belongs to the earlier API-only prototype company.

## Recommended 7–10 minute presentation

### 1. Generate a real API key on the spot — 1 minute

As Avery, open **Account & security → Manage integration API keys** from the company account.

1. Choose **Device repair** and click **Choose service**.
2. Integration name: `Website support chatbot — live demo`.
3. Select **Display flicker adaptive refresh**, **Display flicker driver update**, and **Display flicker power profile**.
4. Check the audience/privacy approval and click **Create integration key**.
5. Show the styled one-time key page. Select the key and copy it with Cmd+C/Ctrl+C. Do not paste it into presentation slides or frontend code.
6. Click **Done — manage API keys** to see its name, prefix, service and Active status. Revoke it afterward if you do not intend to use it.

Say: “The owner can generate a real integration credential immediately. It grants access only to the selected company, service and reviewed knowledge. The full secret is shown once.”

No external chatbot is needed for this part. During verification, a freshly generated main-app key returned three approved suggestions; after revocation the same credential returned 401. The existing revoked **Walkthrough verification** entry is a real test receipt, not an active credential.

### 2. Show imported company knowledge — 1 minute

As Avery, open **Team and data sources → Knowledge**.

- **Synthetic display knowledge — CSV import** contains three reviewed display fixes.
- **Synthetic IT support knowledge** contains one reviewed VPN fix in the IT service.
- **Synthetic knowledge awaiting review** contains a printer paper-alignment record awaiting approval.

Click **Preview first** on the display source: it should report three valid records. Show **Sync now**, source freshness and run history. Re-syncing an unchanged source preserves the same records; locally reviewed versions are not silently overwritten.

Say: “This demonstration imports a synthetic CSV through the real import flow. A live database is not connected to these fixtures. The same source interface supports configured database/API imports.”

For a live upload use [synthetic-knowledge.csv](../examples/external-chatbot/synthetic-knowledge.csv). Column mapping: Record ID → `id`, Title → `title`, Symptoms → `symptoms`, Solution steps → `steps`, Applies to → `environment`, Safety restrictions → `safety`. Leave owner-declared verification unchecked to demonstrate the approval gate.

### 3. Let a customer choose from three fixes — 1 minute

As Alice, open **My requests → Display flicker — try three suggestions**. Send:

```text
The display flickers after startup on Model X firmware 4.
```

Expected: up to three imported suggestions with sources and reviewed steps. Choose one using its try button. Only the selected fix becomes an attempt. Click **It worked** to resolve the request and record one actual reuse success, or **Still need help** to record failure only for the chosen fix.

Say: “Showing an answer is a preview. The customer chooses what they actually try, and confirms the outcome. Reviewed imports are not presented as customer-confirmed fixes.”

For a repeat rehearsal, create a new request with the same description and a new title. A resolved request should remain resolved.

### 4. Demonstrate the learning loop — 2 minutes

A real specialist proposal is already waiting in Alice’s **Printer produces blank pages** request.

1. As Sam, open **Cases → Printer produces blank pages**. Show the case details and **Awaiting confirmation** status. The proposed fix is not yet published as confirmed company knowledge.
2. As Alice, open that request and click **It worked** on the specialist solution. This is an actual publication, not a scripted animation.
3. As Bob, create a **new Device repair request**:

   - Title: `Printer blank pages — live reuse`
   - Description:

   ```text
   The printer produces blank pages on Model P firmware 3.
   ```

4. Send the same sentence in chat. Expected: the newly confirmed printer fix is offered. Choose it, open the source details and optionally confirm **It worked**.
5. As Sam, open **Knowledge → In use** and show the new fix, its origin and reuse track record.

Say: “A specialist proposes a fix, the customer confirms it, and a later compatible customer can retrieve the reviewed instructions.”

This step changes the prepared state intentionally. After the first presentation the printer fix is already confirmed; for subsequent presentations show its persisted history, or use the independent `/demo` walkthrough below for the before/after sequence. The preparation script preserves data rather than resetting outcomes.

### 5. Show memory, specialist follow-up and visits — 1 minute

As Alice, open **Wi-Fi disconnects during calls**.

- Its standard reconnect attempt failed and Sam is investigating.
- Show the **In progress** status, priority, ETA, specialist update and customer note.
- Open the visit/appointment tab: a real future service visit is reserved. Calendar export produces an `.ics` file. Cancelling is optional and changes this synthetic reservation.
- Open Activity and the conversation’s source/details disclosure.

Optional memory input:

```text
Please remember that I prefer email updates after 3 PM.
```

Then ask:

```text
What contact preference have I shared?
```

Look at **Remembered context**. A saved preference can be retired. **New conversation** archives the chat; it does not erase the service request. Do not promise an email was sent: email delivery is not configured here.

### 6. Show scope boundaries — 1 minute

As Bob, use the company/service selector:

- **Continuum Solutions → IT support**: open **VPN drops after sign-in** and send:

  ```text
  The VPN disconnects after sign-in on Windows 11.
  ```

  The IT service offers its standard network check first. If it does not help, click **Still need help** and continue troubleshooting to reach the reviewed IT knowledge. Device repair knowledge stays in its service.

- Switch to **Separate Tenant (synthetic)**: only **Tenant B private router request** is available. Company A’s personal requests and knowledge do not appear.
- Switch back to **Continuum Solutions → Device repair** before continuing the main demo.

As Jordan, the separate company owner, the first company’s sources, cases, members and credentials are absent. Sam’s specialist account has Device repair access and cannot manage owner-only credentials.

### 7. Finish with the company view — 30 seconds

As Avery, open the specialist console Overview. Show actual knowledge counts, case queue, follow-through tasks and the customer-confirmed camera fix’s successful reuse. Keep **SYNTHETIC SAMPLE DATA** labels visible. Small sample counts are not evidence of real customer impact.

## Optional feature stations

| Feature | Where and exact input/action | Expected behavior |
| --- | --- | --- |
| Team invitations | Owner → Team & access. Invite `guest-specialist@example.test`, role Specialist, Device repair; leave email sending off | Copyable invitation bound to that email. Customer signup link and staff invitation are different permissions |
| Service configuration | Owner → AI services | Device repair/IT topics, diagnostic fields, playbooks and allowed actions are configurable; save only deliberate changes |
| Review gate | Sam → Knowledge → Needs you → Printer paper alignment | Add note `Reviewed the synthetic training steps, environment and privacy.` and approve; unreviewed knowledge is excluded before approval |
| Revise/retire knowledge | Sam → Knowledge → a fix | Revision creates a new version; retirement withholds future reuse. Do this after the main demo, as it changes eligible knowledge |
| Failed-fix recovery | New display request → choose one suggestion → Still need help | Only the chosen fix records a failure; remaining eligible alternatives can be offered |
| Other outcomes | Chosen suggestion → more outcomes → Doesn’t apply / I can’t try this | Recorded distinctly; neither is counted as a failed fix |
| Human handoff | Customer → Talk to a person → review → confirm | A specialist case carries request context and prior attempts. Sam already has a queued USB example |
| Specialist progress | Sam → USB port needs a specialist → claim, record an update | Assignment, status, priority, ETA and attempted steps appear in the customer’s case history |
| No compatible learned fix | Create request: `The display flickers after startup on Model Z firmware 9.` | Model X knowledge is withheld; specialist escalation is allowed rather than an invented fix |
| Missing environment | New request: `My screen flickers after startup.` | The app asks for device/version information before recommending constrained knowledge |
| Safety | New request: `My laptop screen flickers and the battery is swollen and smoking.` | No restart or stored fix is suggested; a specialist is required |
| Sources and feedback | Expand Where this came from; Helpful / Needs work on an eligible response | Evidence is visible and feedback persists |
| Privacy | Customer → Your data and privacy → Download my data | Export is scoped to the signed-in customer. Removing conversation content requires confirmation; do this after presentation |
| Knowledge ingestion | Owner → Knowledge → document/ticket import | Drafts can be previewed, edited and sent for review; import is not automatic approval |
| Source lifecycle | Owner → Knowledge → Knowledge review | Conflicts, staleness and opt-in shadow ranking have their own states. Empty state means there are no such events, not that a check was skipped |
| Source controls | A source’s Preview/Test/Sync/Pause/Edit/Run history | Server-side connection details remain hidden; failed syncs do not replace reviewed knowledge |
| System status | Owner console Overview → technical details | Shows actual basic/local search and worker/index status. No live ChromaDB is currently available |
| Account security | Account & security | Identity, sessions, password controls and sign out. Do not change another person’s password or revoke their sessions during a demo |
| Marketing | Home, Product, How it works, Pricing, Book a call | Navigation, theme, monthly/annual display and booking UI. Pricing is a display, not a billing integration |
| Responsive UX | Narrow the browser or use a phone-sized viewport | Mobile navigation, forms, desk and key page remain usable |

The advanced timeout/publication and automatic failed-fix review policies are covered by regression tests. They require time or repeated genuine outcomes; do not change the system clock or present fabricated events to stage them.

## Independent six-step walkthrough

For a repeatable 2-minute explanation without consuming prepared account state, open [Interactive demo](http://localhost:3100/demo), click **Play the walkthrough**, then **Next step** through all six steps. It demonstrates Customer A → specialist → confirmation → Customer B reuse. This is a separate in-memory fictional demo, not your company data or a live-model training process.

After it completes, use the comparison box:

- Known paraphrase: `The monitor of my Demo Laptop X1 keeps blinking whenever it boots.`
- Different symptom: `The display of my Demo Laptop X1 stays black when I boot.`

The first can retrieve the stored flicker fix; the second should not. Reload/reset clears this independent demo state, not your company accounts.

## What is verified, and what not to claim

See [verification report](HACKATHON-VERIFICATION.md) for actual results and boundaries. In particular:

- API-key generation, review/import, company/service isolation, chosen outcomes, specialist confirmation and browser rendering were exercised.
- Hindsight retention and a configured model response were checked live with synthetic inputs.
- Email, Google Calendar OAuth and a live external company database are **not connected** for this presentation. An `.ics` download is not proof of Google sync. PostgreSQL/MySQL/SQL Server/REST adapters have automated coverage; this is not proof a real company database has been connected.
- Local retrieval can miss unfamiliar paraphrases. Use the tested inputs above; do not claim universal understanding or a success probability from a heuristic score.
- The main app is running on port 3100. No deployment or GitHub push has occurred.

## Recreate or extend the sample data

The existing preparation is complete. There is no need to run this before presenting:

```sh
node scripts/prepare-hackathon-demo.js
```

It runs only against a loopback development app, creates/reuses the five fictional accounts and adds labelled workflow data through the authenticated API. Progress is recorded in the ignored local file `data/hackathon-demo.json`. Re-running resumes unfinished stages and keeps the same ticket/source IDs; it does not restore consumed demo outcomes, reset existing users or erase companies. The normal signup/login rate limits remain enforced.
