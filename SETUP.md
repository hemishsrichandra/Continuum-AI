# Continuum connection setup

Company signup, specialist invitations, customer confirmation, and the read-only database gateway are documented in [IMPLEMENTATION.md](docs/IMPLEMENTATION.md). Start a new business with **Create a company**; customers and specialists join using the owner's links. Use Node 22 inside WSL on this computer.

The implementation is ready to connect, but actual email delivery and calendar consent require credentials from your own provider accounts. Enter secrets in the ignored local `.env` or your deployment's environment settings. Do not put keys in chat, frontend files, source control, or screenshots.

## Local authentication and database

The supplied local environment uses `APP_URL=http://localhost:3100`, development mode, personal accounts, and SQLite. You can create an account immediately. Email verification is optional only in development while delivery is being configured; service emails require a verified account address.

Existing demo records migrate automatically on first startup. Optional demo accounts can be enabled with `ENABLE_DEMO_MODE=true` outside production. They remain separate from personal accounts.

## 1. Configure email

1. Create a Resend account and verify your sending domain.
2. Create a sending API key and set `RESEND_API_KEY` in `.env`.
3. Set `EMAIL_FROM` to an address on the verified domain, for example `Continuum <hello@your-domain.com>`.
4. Generate an integration encryption key with `npm run secrets:generate` and save it as `INTEGRATION_ENCRYPTION_KEY`. Keep it stable across restarts/deployments and back it up separately.
5. Keep `ENABLE_OUTBOX_WORKER=true`, then restart the app.
6. Sign in, open **Account & connections**, and send a verification email to your own address. Follow its private link, then reload the workspace.

The same provider sends password recovery links and booking/cancellation receipts. Queued authentication links are encrypted at rest, removed after provider acceptance, and skipped if their underlying token has already been consumed. Without email setup, recovery requests explain that email delivery is unavailable.

Resend's [sending API](https://resend.com/docs/api-reference/emails/send-email) supports idempotent sends. Continuum stops automatic email resubmission before the provider's retry window expires; old uncertain deliveries require review rather than risking duplicates.

## 2. Configure Google Calendar

1. Create/select a Google Cloud project and enable the Google Calendar API.
2. Configure the OAuth consent screen. While the app is in Google's testing mode, add the account you will use as a test user.
3. Create an OAuth client with application type **Web application**.
4. Add this exact authorized redirect URI for the local app:

   `http://localhost:3100/api/integrations/google/callback`

5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Keep the integration encryption key from the email setup.
6. Restart, sign in to a personal account, and select **Account & connections → Connect Google Calendar**. Complete Google's consent flow yourself.
7. Create a request and book a visit. Check your calendar and the delivery activity panel. Cancel the visit to verify that the calendar event is removed.

Continuum requests `calendar.events.owned` and `calendar.freebusy`, uses the user's primary calendar, and adds no attendees or video-conferencing link. Consent is bound to the signed-in account and session; state values expire after ten minutes and cannot be replayed. A newly created session reservation can also sync when made while signed in with a connected calendar. Anonymous reservations have no external host calendar.

References: Google's [web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server) and [event creation guide](https://developers.google.com/workspace/calendar/api/guides/create-events). Google's own app publishing/verification requirements apply when you make the OAuth app available to external users.

## 3. Enable live AI, if wanted

Set `HINDSIGHT_BASE_URL`, `HINDSIGHT_API_KEY`, and a unique `HINDSIGHT_BANK_PREFIX`; set `OPENAI_API_KEY` (chat/drafting, e.g. Groq) and any compatible endpoint/model overrides. Neural embeddings use separate `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`. `REQUIRE_LIVE_INTEGRATIONS=true` makes connection failures explicit instead of using local AI responses. These keys are independent of email and calendar configuration.

## 4. Semantic search index (optional)

Set `VECTOR_STORE=chroma` and `CHROMA_URL` to enable the ChromaDB index; leave them empty to run on SQLite alone. Start ChromaDB with `docker compose up -d chroma` or `npm run chroma:start`. Operator commands, embedding options, consistency rules and recovery steps are in [SEMANTIC-SEARCH.md](docs/SEMANTIC-SEARCH.md).

External company databases are off until the server owner allows them: `DATA_SOURCE_ALLOWED_ORIGINS` (REST, https only), `DATA_SOURCE_SQLITE_DIRS`, and for PostgreSQL `DATA_SOURCE_POSTGRES_DRIVER=pg`, `DATA_SOURCE_POSTGRES_HOSTS` and `DATA_SOURCE_POSTGRES_PORTS`. Connections are pinned to the validated address, read-only and TLS-verified; use a read-only database account.

## Before public deployment

- Set `NODE_ENV=production` and `APP_URL` to your HTTPS site origin. Keep your reverse proxy's original Host header.
- Set `HOST=0.0.0.0` only when remote access is intended. The internal API remains on loopback. For an upstream reverse proxy, set `TRUSTED_PROXY_IPS` to its exact IP addresses (comma-separated IPv4/IPv6 literals; no CIDRs or wildcards). Leave it empty for direct connections. The proxy must append the actual source address to `X-Forwarded-For`, and direct public access must not bypass it. Untrusted forwarded headers are ignored; the public listener replaces internal identity headers before forwarding. Authentication and booking limits use this verified client address, with account limits still enforced separately. Users behind the same NAT still share an IP budget.
- Use a verified email sender and a stable, securely stored 32-byte `INTEGRATION_ENCRYPTION_KEY`.
- Add the deployed HTTPS callback URI to the Google OAuth client.
- Provide persistent storage for SQLite and schedule backups using the online backup command. Keep encryption keys outside the database backup.
- Keep demo and accessibility-audit modes off. Production enforces both restrictions.
- Monitor failed outbox jobs and provider quotas. Multiple hosts require a shared SQL database; the current SQLite deployment is for one persistent host.

A local installation without a configured encryption key creates a private `.sqlite.key` file for development integrations. Production never generates a replacement key silently. Losing that key requires reconnecting calendars and regenerating outstanding private-link emails; password hashes and account records do not depend on it.

## Optional provider writes

No business gateway is connected by default. See [PROVIDER-GATEWAY.md](docs/PROVIDER-GATEWAY.md) before enabling confirmed-action sync. The gateway must implement durable idempotency and exact action receipts. The current adapter has been verified against an isolated HTTP service, not a live business database.
