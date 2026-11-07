# Continuum

A company-scoped support agent that combines service records, customer preferences, and customer-confirmed specialist resolutions. Businesses can import records from an allowlisted database gateway. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the implemented workflow, verification, and connector contract.

## Run locally

Use Node.js **22 in WSL** (`.nvmrc`). Install dependencies in WSL so the native SQLite module matches Linux. `bash scripts/start-wsl.sh` starts the app using Node in PATH or the local runtime configured on this computer.

```sh
npm ci
npm start
```

Open `http://localhost:3100`. Select **Create a company** for an owner account. Owners use **Company & team** to generate customer signup links and email-bound specialist invitations. New accounts start with an empty workspace. Passwords must contain 15–128 characters.

Company accounts manage customer cases; they cannot create personal service requests, book personal visits or submit customer confirmations. Owners and specialists have direct **Account & security** and **Sign out** controls. Use a separate customer account for customer workflows. See [COMPANY-INTERFACE.md](COMPANY-INTERFACE.md).

If `.env` is missing, copy `.env.example` to `.env`. Never commit credentials. See [SETUP.md](SETUP.md) for email, Google Calendar, and deployment configuration.

## Authentication

- Scrypt password hashing with per-password salts (`N=131072`, `r=8`, `p=1`). Hashing concurrency and persistent attempt limits bound resource use.
- Opaque, hashed session identifiers stored in SQLite. Browser sessions use HttpOnly, SameSite=Lax cookies and CSRF tokens held in page memory, not browser storage. Production cookies are Secure and use the `__Host-` prefix.
- Sessions persist across restarts, expire after seven days, and can be revoked from **Account & connections**.
- One-use email verification and password-reset links. Reset links expire in 30 minutes, verification links in 24 hours. Changing/resetting a password revokes all sessions and outstanding reset tokens.
- Production requires an HTTPS `APP_URL`, verified email, and configured email delivery for registration. Local development can create unverified accounts while email is unconfigured; these accounts do not receive service notification emails until verified.
- Optional demo access requires `ENABLE_DEMO_MODE=true` and is always disabled in production. Demo bearer tokens work only for fictional demo sessions, never personal accounts.

## Database

SQLite stores application records as individual indexed JSON rows, plus dedicated relational tables for accounts, sessions, verification/reset tokens, OAuth states, calendar connections, and rate limits. Writes use immediate transactions, WAL, and database uniqueness constraints for appointment capacity and replay receipts. Shared handlers read current committed records rather than stale file snapshots.

The default startup imports `data/demo.json` once into `data/demo.sqlite`, leaving the original JSON untouched. `DATABASE_FILE` selects another SQLite file. An explicitly supplied legacy `DATA_FILE=path.json` imports into `path.sqlite`. Once migrated, JSON edits cannot overwrite database records.

```sh
npm run db:backup -- /absolute/new/path/continuum-backup.sqlite
```

The backup uses SQLite's online backup API, including committed WAL contents. Keep the integration encryption key separately and restore it with the database. SQLite supports multiple processes on one host; it is not a shared database for deployments across multiple hosts. Use a shared SQL service before horizontal scaling. Database files must be on a persistent local volume.

## Email and Google Calendar

Email uses the Resend API with stable idempotency keys. Google Calendar uses an account-specific authorization-code flow with PKCE, a session-bound one-use state, restricted calendar scopes, and encrypted refresh tokens.

- Verification, reset, reservation, and cancellation emails use a durable, encrypted outbox.
- Connected calendars are checked for overlapping busy intervals when showing availability and again before committing an appointment.
- Bookings and cancellations enqueue calendar updates alongside the database commit.
- Workers claim jobs with leases and retry failures with backoff. Calendar event IDs are stable, and email retries reuse the provider idempotency key.
- **Account & connections** shows connection and delivery state and offers eligible retries/disconnection.
- A delivery marked complete means the provider accepted it; email inbox delivery is not independently confirmed. No video meeting link is created.

Missing credentials are reported as setup requirements. No emails are claimed as sent, and no calendar is claimed as connected, before the respective provider acknowledges the action. External provider changes remain eventually consistent with the local booking through the outbox.

## Workspace features

Search/filter requests; check status and ETA; add notes; book/cancel visits; download calendar files; record resolved, failed, or missed outcomes; prepare a specialist handoff; save/arch­ive conversations; inspect evidence; rate responses; summarize and retire remembered context.

Memory-off pauses recall and long-term fact retention and excludes previous conversation context from the model; displayed conversations remain saved. Customer-wide contact preferences carry across tickets within that customer account. Technical outcomes remain ticket-specific. Learned replies are freshly retrieved rather than recycled from assistant history. Retiring knowledge excludes it locally immediately; remote invalidation is retried if needed. Customer-confirmed resolutions suppress earlier failed-fix signals.

The standard and IT schema adapters operate on Continuum records. The optional gateway imports a company's existing service records with configurable field mapping and server-side customer binding. Compatible gateways can opt into confirmed-action delivery with durable retries and provider acknowledgements; see [PROVIDER-GATEWAY.md](PROVIDER-GATEWAY.md). No real business gateway is connected on this installation. Live Hindsight and model connections require credentials; `REQUIRE_LIVE_INTEGRATIONS=true` prevents silent fallback.

Recommendations now have **It worked / Still need help** feedback. An unsuccessful fix reopens the request, sends its attempted steps and conversation to a specialist, and pauses further reuse until reviewed. A customer who failed a fix is not given the same resolution again after review. The existing specialist library shows follow-up outcomes and the review control; no new dashboard is required.

## Checks

```sh
npm test
npm run test:http
npm run demo
npm run evaluate
npm run evaluate:live
```

Tests cover personal authentication, CSRF, recovery/verification, cookie/session persistence, tenant isolation, shared SQLite connections, booking collisions, safe replay, memory policies, feedback, Google OAuth/availability/events, and email retry contracts. External-provider tests use mocks and never send real messages or modify real calendars. `test:http` launches an isolated temporary server and database.

For a temporary, non-production browser audit, start with `A11Y_AUDIT=true`. This loads the dev-only axe-core scanner and adds an on-page report. The scanner and its route are never enabled in production. The accessibility pass also includes manual focus, keyboard, responsive, form, and screen-reader announcement checks. An automated pass is not a full accessibility certification.

See [AUDIT.md](AUDIT.md) for verification and remaining boundaries.
