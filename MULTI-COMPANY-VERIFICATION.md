# Multi-company verification — November 7, 2026

Follow-up: the charging issue reported during manual testing is now covered by a complete browser test and regression test. The latest full run passed **78 tests, 0 failures**, plus HTTP checks. See [CHARGING-TEST.md](CHARGING-TEST.md) for the observed Customer A → specialist → Customer B sequence and the prompt/playbook corrections. The 77-test results below describe the preceding implementation run.

All database and integration checks used newly created temporary SQLite databases, fictional accounts and mocked/local providers. No user's existing database was opened for migration testing. Nothing was deployed, no real messages were sent, and no live Hindsight, model, calendar or company gateway was contacted.

## Actual results

| Check | Result |
| --- | --- |
| `npm test` under WSL Node 22.16.0 | **77 passed, 0 failed**, about 50 seconds |
| `npm run test:http` | Passed: pages and assets including new modules, SQLite, real HTTP cookie authentication, CSRF, isolation, logout, validation, proxy and idempotent replay |
| `npm run demo:multi` | Passed all five asserted workflow/isolation demonstrations |
| `node --check` for all changed/new JavaScript | Passed for **33 files** |
| UTF-8 decoding of changed/new JavaScript | Passed for all 33 files |
| `git diff --check` | Passed |
| Browser verification | Passed for the critical flows below, using the isolated fictional demo server |

The initially installed native SQLite binary is Linux-specific and cannot load under Windows Node 24. Verification therefore used the repository's existing WSL Node 22 runtime, without replacing dependencies or user data. No verification blocker remains for the isolated local implementation. Live provider compatibility and remote bank re-publication remain deliberately unverified.

## Added coverage

`test/multi-company.test.js` exercises global identity with two company memberships, idempotent joins, email-bound existing-account invitation acceptance, company-specific roles, live revocation through an existing session, authentication after losing all memberships, joining a new company, forged company/chatbot/customer references, stale workspace headers, different services using the same adapter, and independent service/company knowledge and case boundaries.

The workflow tests verify required-context clarification, standard-before-learned ordering, explicit no-playbook skips, standard success, safety escalation while a fix is pending, immediate human access, unsupported-topic routing, no false submission claims when a service uses an alternate support route, memory-off operational behavior, immutable snapshots, duplicate/conflicting feedback, restart persistence, confirmed shared reuse, success statistics, failed reuse escalation/review, equivalent failed-fix suppression, and scoped staff access. A separate memory-off confirmation test verifies that a human case closes as `confirmed_private` without publishing AI knowledge.

The mocked gateway test imports the same directory entry repeatedly, rejects unverified linking and mismatched identities, preserves an already linked identity on invalid updates, links one verified account in two companies, imports service records idempotently, and verifies that no authenticated accounts were created by directory imports.

`test/migration-v4.test.js` builds a populated version-3 SQLite database, then upgrades and reopens it. It verifies stable account IDs/password hashes, preserved sessions and external mappings, role backfill, separate repair/IT chatbot references, unchanged conversations/audit history, scoped knowledge re-publication markers, migrated failed reuse attempts with legacy standard skips, foreign-key integrity and safe rerun behavior. The existing pre-company account migration test also still passes.

Existing regression coverage remains for authentication, password recovery/verification, CSRF, rate limits, assignment and revision conflicts, privacy-reviewed publication, rejection, applicability and version conflicts, retirement, memory-off model context, contact preferences, encrypted connector secrets, trusted-origin/customer binding, provider action acknowledgements, lost-receipt retries and restart recovery. Some old assertions were updated deliberately: account columns no longer grant authorization, final feedback cannot be reversed, unverified customers cannot be linked, and applicable standard playbooks must precede learned reuse. The ten-issue retrieval evaluation configures an empty standard-playbook list to continue measuring retrieval separately from the full workflow tests.

## Browser observations

Using `npm run demo:multi -- --serve` at localhost port 3211, the in-app browser visibly verified:

1. Customer One authenticated and saw Company A and its current Device repair service.
2. The company selector switched to Company B; Company A's ticket/conversation was no longer selected or displayed.
3. A fictional new request was created in Company B with explicit confirmation.
4. Reporting its network problem displayed the standard playbook with **It worked**, **Still need help**, and **Human help** controls.
5. **Still need help** finalized the standard failure and submitted the case to Company B after finding no compatible shared fix there.
6. Owner B authenticated into the existing company-management page, which displayed support-service configuration, membership controls and the directory import/link UI.
7. The existing operator queue displayed the submitted browser case, its conversation and the immutable standard attempt with outcome **failed**. Company B's resolution library was empty.

Local evidence (ignored output): [browser queue screenshot](output/multi-company/browser-queue.png). The screenshot contains only fictional data. The browser session was used for selected critical flows; the entire test matrix was exercised through the real handler/HTTP checks rather than exhaustively repeated in the browser. Live integrations were disabled throughout.

## Demo and remaining limits

Run `npm run demo:multi` for the disposable asserted scenario or `npm run demo:multi -- --serve` for the browser demonstration. See [MULTI-COMPANY.md](MULTI-COMPANY.md) for credentials, manual steps, schema/migration details, configuration and gateway contracts.

Remaining prototype limits are conservative English/topic matching, one standard plus one learned fix per issue, adapter-wide staff authorization within each company, owner-triggered individual directory imports, one gateway per company and one SQLite host. Memory-off human confirmations do not have a later opt-in publication toggle. Remote legacy banks remain unchanged and excluded from recall; new scoped publication/invalidation retries are implemented but were not executed against a live Hindsight service. No real company database is claimed as connected.
