# Security housekeeping

What was checked, what was found, and what only you can do.

## Git history scan (done 13 November 2026)

- `.env` and `.env.local` are in `.gitignore`. **No file named `.env` was ever committed** (`git log --all` over every path shows only `.env.example`).
- Every secret currently set in `.env` (the Groq key, the Hindsight key, the Google client secret) was searched for **by value** across all commits on all branches (`git log --all -S<value>`): **no match**. The Resend and embedding keys and `INTEGRATION_ENCRYPTION_KEY` are empty in `.env`, so there was nothing to search for.
- Pattern scan over all history for Groq (`gsk_`), Resend (`re_`), Google (`GOCSPX-`, `AIza`), OpenAI-style (`sk-`), GitHub (`ghp_`) and PEM private-key shapes: the only hits are **fake tokens inside test fixtures** (`test/knowledge-import.test.js`, `test/receipt-privacy.test.js`) that exist to prove secrets are rejected.
- Limits: `gitleaks` is not installed on this machine, so this was done with `git log -S` and pattern searches. Run `gitleaks detect --source . --log-opts="--all"` once for a second opinion. A key that was exposed **outside git** (a pasted `.env`, a screenshot, a chat) is not covered by any scan of the repository.

Conclusion: the repository history does not need rewriting. Keys exposed anywhere else should still be treated as burned.

## Rotate these yourself

Only the provider's own dashboard can revoke a key, so this is not something the code can do for you.

1. **Groq** (`OPENAI_API_KEY`): create a new key, update `.env`, delete the old one.
2. **Hindsight** (`HINDSIGHT_API_KEY`): same.
3. **Resend** (`RESEND_API_KEY`): same, then check the sending domain.
4. **Google OAuth client secret** (`GOOGLE_CLIENT_SECRET`): reset it in the Google Cloud console, update `.env`.
5. **`INTEGRATION_ENCRYPTION_KEY`**: do **not** simply replace it. Every saved connection (Google Calendar tokens, a company's ticket-system token, database-source secrets, queued jobs) is encrypted under it and would become unreadable. Use the rotation script:

```bash
# 1. stop the server
# 2. dry run (changes nothing; prints how many secrets it would re-encrypt)
OLD_INTEGRATION_ENCRYPTION_KEY=<old base64> NEW_INTEGRATION_ENCRYPTION_KEY=<new base64> node scripts/rotate-integration-key.js data/app.sqlite
# 3. apply (copies the database to data/app.sqlite.before-rotation first, then re-encrypts in one transaction)
OLD_INTEGRATION_ENCRYPTION_KEY=<old base64> NEW_INTEGRATION_ENCRYPTION_KEY=<new base64> node scripts/rotate-integration-key.js data/app.sqlite --apply
# 4. set INTEGRATION_ENCRYPTION_KEY to the new key and start the server
```

Generate a key with `npm run secrets:generate`. The script refuses to change anything if even one value cannot be read with the old key. If you have been running with the local development key file (`<database>.key`), leave `OLD_INTEGRATION_ENCRYPTION_KEY` unset and it uses that file.

## Chroma token

`CHROMA_TOKEN` is already supported (sent as a bearer token to the vector service). Set it, and start Chroma with the matching token, before the vector service is reachable from anywhere other than `127.0.0.1`.

## Before any real deployment

Keep `NODE_ENV=production` (it refuses demo identities and the accessibility-audit panel), serve over HTTPS, and do not run `npm run serve:sample` or `npm run seed:sample` against production: both refuse to run when `NODE_ENV=production`.
