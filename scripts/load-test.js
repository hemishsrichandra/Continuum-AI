// Load test: turn "unknown" into a number.
//
//   node scripts/load-test.js [--items 10000] [--chats 50] [--rounds 3] [--out evaluation/load-results.json]
//
// What it does (all synthetic, in a throwaway database, no network, no model, no email):
//   1. stores N invented reusable fixes for one company (default 10,000), across many device models so most are NOT compatible with any given customer
//   2. registers `chats` customers, each with a request
//   3. sends all `chats` first messages at the same moment (Promise.all), repeated for `rounds` rounds, and records per-request latency
//   4. times retrieval on its own
// It drives the request handler in-process (the same code path as a real HTTP request, without the socket), so it measures the application,
// SQLite and retrieval, not the network or a browser. Node runs JavaScript on one thread: "50 concurrent chats" means 50 requests in flight
// that interleave on that thread. Offline local embeddings are used unless EMBEDDING_* is set; with a remote embedding model the query embedding
// adds that provider's latency.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server/app.js';
import { invoke } from './invoke.js';
import { client } from '../test/_helpers.js';
import { computeInitialConfidence } from '../server/passports.js';
import { customerFacts } from '../server/applicability.js';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const ITEMS = Number(arg('items', 10000)), CHATS = Number(arg('chats', 50)), ROUNDS = Number(arg('rounds', 3)), OUT = arg('out', null);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null; };

const TOPICS = [
  ['display', 'The screen flickers after startup', 'Disable adaptive refresh in Display settings and restart.'],
  ['wifi', 'Wi-Fi disconnects every few minutes', 'Remove the saved network profile and reconnect.'],
  ['battery', 'The battery drains quickly overnight', 'Switch the power profile to Balanced and restart.'],
  ['audio', 'There is no sound from the speakers', 'Select the internal speakers as the output device.'],
  ['camera', 'The camera preview is black', 'Reselect the internal camera in the meeting application.'],
  ['storage', 'The disk is full and files cannot be saved', 'Remove temporary update files in Storage settings.'],
  ['email', 'Email will not synchronize new messages', 'Resume synchronization for the mailbox and sign in again.'],
  ['printer', 'The printer jams on every third page', 'Clear the paper path and reload the tray.'],
  ['vpn', 'The VPN login fails every time', 'Reset the VPN profile and sign in with the company account.'],
  ['crash', 'The application closes right after launch', 'Clear the application cache and start it again.'],
];
const MODELS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

const dir = await mkdtemp(join(tmpdir(), 'continuum-load-'));
const h = createHandler({ file: join(dir, 'load.sqlite'), config: { APP_URL: 'http://localhost:3100', NODE_ENV: 'test', ENABLE_OUTBOX_WORKER: 'false', REQUIRE_EMAIL_VERIFICATION: 'false', ENABLE_DEMO_MODE: 'false', ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^EMBEDDING_|^VECTOR_|^CHROMA_/.test(k))) } });
const get = () => h;
const owner = client(get);
const must = (r, what) => { if (r.status >= 300) throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.data).slice(0, 160)}`); return r; };
const company = must(await owner.api('auth/register', { name: 'Load Owner', email: 'load-owner@example.test', password: 'a fictional load passphrase 2026', createCompany: true, companyName: 'Load test company', provider: 'repair' }), 'owner').data.profile.companyId;
const code = must(await owner.api('company/customer-code', { confirmed: true }), 'code').data.code;
const bot = company + ':repair';

// 1. knowledge
const t0 = performance.now();
const insert = h.store.db.transaction(() => {
  for (let i = 0; i < ITEMS; i++) {
    const [key, symptoms, step] = TOPICS[i % TOPICS.length];
    const model = 'Model ' + MODELS[Math.floor(i / TOPICS.length) % MODELS.length] + (1 + Math.floor(i / (TOPICS.length * MODELS.length)));
    const environment = `${model} firmware ${1 + (i % 7)}`;
    const passport = { title: `${symptoms} (${model})`, symptoms: `${symptoms}. ${key} problem on ${model}`, applicability: { environmentText: environment }, safety: { restrictions: [], noneIdentified: true, reviewed: true }, steps: [step] };
    const c = computeInitialConfidence(passport, { facts: customerFacts(environment), author: { kind: 'staff' } });
    h.memoryPool.insert({ companyId: company, chatbotId: bot, origin: 'specialist_confirmed', sourceKey: 'load:' + i, ...passport, initialConfidence: c.score, customerConfirmed: true });
  }
});
insert();
const seedMs = performance.now() - t0;

// 2. customers and requests (setup, not measured)
const people = [];
for (let i = 0; i < CHATS; i++) {
  h.store.db.prepare('DELETE FROM rate_limits').run(); // throwaway database: signing up many people must not trip the per-address limit
  const c = client(get);
  must(await c.api('auth/register', { name: 'Load ' + i, email: `load${i}@example.test`, password: 'a fictional load passphrase 2026', companyCode: code, provider: 'repair' }), 'customer');
  people.push(c);
}
const message = (i) => { const [, symptoms] = TOPICS[i % TOPICS.length]; return `${symptoms}. Model ${MODELS[i % MODELS.length]}1 firmware ${1 + (i % 7)}.`; };

// 3. concurrent chats
const latencies = [], statuses = {};
const roundMs = [];
for (let round = 0; round < ROUNDS; round++) {
  const tickets = await Promise.all(people.map((c, i) => c.api('request', { title: 'Load request', issueDesc: message(i + round), confirmed: true }).then((r) => must(r, 'request').data.ticketId)));
  const start = performance.now();
  await Promise.all(people.map(async (c, i) => {
    const s = performance.now();
    const r = await c.api('chat', { ticketId: tickets[i], message: message(i + round) });
    latencies.push(performance.now() - s);
    statuses[r.status] = (statuses[r.status] || 0) + 1;
  }));
  roundMs.push(performance.now() - start);
}

// 4. retrieval alone
const retrieval = [];
for (let i = 0; i < 100; i++) { const s = performance.now(); await h.memoryPool.retrieve({ companyId: company, chatbotId: bot, text: message(i) }); retrieval.push(performance.now() - s); }

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  setup: { knowledgeItems: ITEMS, concurrentChats: CHATS, rounds: ROUNDS, embedding: h.embedding.model, vectorIndex: h.vectors.enabled ? 'chroma' : 'off (SQLite only)', seedSeconds: Math.round(seedMs / 100) / 10 },
  chat: { requests: latencies.length, statuses, medianMs: q(latencies, 0.5), p95Ms: q(latencies, 0.95), maxMs: q(latencies, 1), wholeRoundMs: roundMs.map((n) => Math.round(n)) },
  retrievalAlone: { queries: retrieval.length, medianMs: q(retrieval, 0.5), p95Ms: q(retrieval, 0.95) },
  limits: ['In-process: no network, no browser. One Node thread: requests interleave, they do not run in parallel.', 'Synthetic fixes and one company; a real company has messier text.', 'Offline embeddings unless EMBEDDING_* is set; a remote embedding model adds its own latency to each query.'],
};
console.log(JSON.stringify(report, null, 2));
if (OUT) await writeFile(OUT, JSON.stringify(report, null, 2));
h.close();
await rm(dir, { recursive: true, force: true }).catch(() => {});
process.exit(0);
