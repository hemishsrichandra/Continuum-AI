# Continuum connection setup

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

Set `HINDSIGHT_BASE_URL`, `HINDSIGHT_API_KEY`, and a unique `HINDSIGHT_BANK_PREFIX`; set `OPENAI_API_KEY` and any compatible endpoint/model overrides. `REQUIRE_LIVE_INTEGRATIONS=true` makes connection failures explicit instead of using local AI responses. These keys are independent of email and calendar configuration.

## Before public deployment

- Set `NODE_ENV=production` and `APP_URL` to your HTTPS site origin. Keep your reverse proxy's original Host header.
- Use a verified email sender and a stable, securely stored 32-byte `INTEGRATION_ENCRYPTION_KEY`.
- Add the deployed HTTPS callback URI to the Google OAuth client.
- Provide persistent storage for SQLite and schedule backups using the online backup command. Keep encryption keys outside the database backup.
- Keep demo and accessibility-audit modes off. Production enforces both restrictions.
- Monitor failed outbox jobs and provider quotas. Multiple hosts require a shared SQL database; the current SQLite deployment is for one persistent host.

A local installation without a configured encryption key creates a private `.sqlite.key` file for development integrations. Production never generates a replacement key silently. Losing that key requires reconnecting calendars and regenerating outstanding private-link emails; password hashes and account records do not depend on it.
