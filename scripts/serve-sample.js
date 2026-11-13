// Start the app on the synthetic sample company (created by `npm run seed:sample`) for demos and browser checks.
// Every external service is switched off on purpose: no model, no email, no calendar, no memory service, no vector index.
// The accessibility audit panel is on, so each page can be scanned with axe (never enabled in production).
import { existsSync } from 'node:fs';
if (process.env.NODE_ENV === 'production') { console.error('Refusing to serve sample data in production.'); process.exit(1); }
const file = process.argv[2] || 'data/sample.sqlite';
if (!existsSync(file)) { console.error(`No sample database at ${file}. Run: npm run seed:sample`); process.exit(1); }
for (const key of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'EMAIL_FROM', 'HINDSIGHT_API_KEY', 'HINDSIGHT_BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL', 'CHROMA_TOKEN', 'REQUIRE_LIVE_INTEGRATIONS']) process.env[key] = '';
Object.assign(process.env, {
  DATABASE_FILE: file, NODE_ENV: 'development', A11Y_AUDIT: 'true', ENABLE_OUTBOX_WORKER: 'false', REQUIRE_EMAIL_VERIFICATION: 'false',
  VECTOR_STORE: 'sqlite', EMBEDDING_PROVIDER: 'local', FRONTEND_PORT: process.env.FRONTEND_PORT || '3300', API_PORT: process.env.API_PORT || '3301',
  APP_URL: 'http://localhost:' + (process.env.FRONTEND_PORT || '3300'),
});
await import('../server/start.js');
