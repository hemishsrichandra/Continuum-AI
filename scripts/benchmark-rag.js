// Retrieval benchmark: the ORIGINAL architecture (full scan of the company's passports on every query) against the
// upgraded one (SQLite FTS5 top-K + vector top-K, with and without ChromaDB), on identical synthetic data and the
// same offline embedding model (local-hashed-concepts-v2; no neural model, no network).
//
//   node scripts/benchmark-rag.js [--sizes 100,1000,10000] [--queries 150] [--chroma http://127.0.0.1:8000] [--out file.json]
//
// Everything is synthetic. Ground truth: a query describes one topic on one specific device (model + firmware), and
// exactly one stored fix is compatible with it. "Negative" queries describe a device that has no stored fix, so the
// right answer is no recommendation. Nothing here measures real customers.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world } from '../test/_helpers.js';
import { ORIGINS, signatureOf } from '../server/passports.js';
import { tokens } from '../server/context.js';
import { customerFacts } from '../server/applicability.js';
import {
  THRESHOLDS, LOCAL_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, localEmbedding, blobToVector, cosine, normBm25, hybridScore, reliability,
  finalScore, compatibilityGate, rankCandidates,
} from '../server/scoring.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SIZES = arg('sizes', '100,1000,10000').split(',').map(Number);
const QUERIES = Number(arg('queries', 150));
const CHROMA_URL = arg('chroma', process.env.CHROMA_URL || 'http://127.0.0.1:8000');
const OUT = arg('out', null);

// ----------------------------------------------------------------------------------------- deterministic data
let seed = 20260101;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = (list) => list[Math.floor(rand() * list.length)];
const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const TOPICS = [
  { id: 'display', title: 'Display flicker', symptom: ['The display flickers after startup', 'The monitor keeps blinking whenever it boots', 'Screen shimmers right after power on'], steps: 'Open Display settings, pick the Standard profile and restart.' },
  { id: 'wifi', title: 'Wireless drops', symptom: ['The wifi connection keeps dropping', 'Wireless disconnects intermittently', 'The internet link cuts out every few minutes'], steps: 'Forget the network, reconnect once and update the wireless driver.' },
  { id: 'battery', title: 'Battery drain', symptom: ['The battery drains rapidly', 'Charge runs down very fast', 'The battery depletes quickly even when idle'], steps: 'Switch the power profile to Balanced and close background apps.' },
  { id: 'login', title: 'Sign-in refused', symptom: ['Sign in is refused after the update', 'Authentication fails with correct credentials', 'Login is denied every time'], steps: 'Clear the saved credentials and sign in again with a fresh session.' },
  { id: 'audio', title: 'No sound', symptom: ['There is no sound from the speakers', 'Audio is silent after waking', 'I cannot hear anything from the speakers'], steps: 'Select the correct output device and reset the audio service.' },
  { id: 'webcam', title: 'Blank webcam', symptom: ['The webcam shows a black image', 'The camera picture is blank in calls', 'Webcam video comes up black'], steps: 'Allow camera access in Privacy settings and reinstall the camera driver.' },
  { id: 'storage', title: 'Disk full', symptom: ['The disk is full', 'The drive has no free space left', 'Storage is used up and saves fail'], steps: 'Run Storage cleanup and move large files to external storage.' },
  { id: 'email', title: 'Email not syncing', symptom: ['The email inbox stopped syncing', 'My mailbox stalls and will not refresh', 'Email sync is stuck'], steps: 'Remove and re-add the account, then force a full sync.' },
  { id: 'crash', title: 'App crashes', symptom: ['The application crashes on start', 'The software closes unexpectedly when launched', 'The program shuts down right after opening'], steps: 'Reset the application settings and reinstall the latest version.' },
  { id: 'jam', title: 'Paper jam', symptom: ['Paper jam in the printer', 'Sheets keep getting stuck in the printer', 'The printer is clogged with paper'], steps: 'Open the rear tray, remove the stuck sheet and run a cleaning page.' },
];
const MODELS = Array.from({ length: 40 }, (_, i) => 'Q' + String(i + 1).padStart(2, '0'));
const FIRMWARE = Array.from({ length: 25 }, (_, i) => i + 1);
const ALL = shuffle(TOPICS.flatMap((t) => MODELS.flatMap((m) => FIRMWARE.map((f) => ({ topic: t, model: m, fw: f })))));
const keyOf = (e) => `${e.topic.id}|${e.model}|${e.fw}`;

// ----------------------------------------------------------------------------------------- the original algorithm
// A faithful port of the previous retrieve(): load every active row, run FTS without a limit, score every row.
function legacyRetrieve(sql, { companyId, chatbotId, text }) {
  const rows = sql.prepare(`SELECT * FROM memory_pool WHERE company_id=? AND chatbot_id=? AND status='active' AND origin_type IN (${ORIGINS.map(() => '?').join(',')})`).all(companyId, chatbotId, ...ORIGINS);
  const queryTokens = tokens(text);
  const raw = new Map();
  if (queryTokens.size) {
    const match = [...queryTokens].map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ');
    for (const r of sql.prepare(`SELECT f.memory_id AS id, bm25(memory_pool_fts, 0.0, 0.0, 2.0, 2.0, 0.5) AS score FROM memory_pool_fts f JOIN memory_pool m ON m.id=f.memory_id AND m.company_id=f.company_id WHERE memory_pool_fts MATCH ? AND m.company_id=? AND m.chatbot_id=? AND m.status='active'`).all(match, companyId, chatbotId)) raw.set(r.id, -r.score);
  }
  const rawBest = Math.max(0, ...[...raw.values()]);
  const q = localEmbedding(text);
  const facts = customerFacts(text, {});
  const scored = rows.map((r) => {
    const stored = r.embedding_model === LOCAL_EMBEDDING_MODEL && r.embedding_blob ? blobToVector(r.embedding_blob) : null;
    const v = stored && stored.length === EMBEDDING_DIMENSIONS ? stored : localEmbedding(r.title + ' ' + r.symptoms_text);
    const cos = cosine(q, v);
    const bm = normBm25({ raw: raw.has(r.id) ? raw.get(r.id) : null, rawBest, queryTokens, docTokens: tokens(r.title + ' ' + r.symptoms_text) });
    const hybrid = hybridScore(cos, bm);
    const gate = compatibilityGate({ applicability: JSON.parse(r.applicability_json), safety: JSON.parse(r.safety_restrictions_json), facts, text, fields: {} });
    const w = reliability(r.initial_confidence_score, r.reuse_success_count, r.reuse_failure_count);
    return { id: r.id, row: r, signature: signatureOf(JSON.parse(r.steps_json)), eligible: gate.eligible, hybrid, finalScore: gate.eligible ? finalScore(hybrid, gate.compat, w) : 0 };
  });
  return { eligible: rankCandidates(scored, THRESHOLDS.maxSuggestions) };
}

// ----------------------------------------------------------------------------------------- measurement helpers
const quantile = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const round = (n, d = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
async function measure(name, fn, queries, truthIds) {
  const latencies = [];
  let hits = 0, returned = 0, correct = 0, wrongDevice = 0, positives = 0, negatives = 0, falsePositives = 0, widened = 0;
  for (const q of queries) {
    const t0 = performance.now();
    const out = await fn(q.text);
    latencies.push(performance.now() - t0);
    const ids = out.eligible.slice(0, 3).map((c) => c.id);
    if (out.widened) widened++;
    returned += ids.length;
    for (const c of out.eligible.slice(0, 3)) {
      const row = c.row;
      const env = JSON.parse(row.applicability_json).environmentText || '';
      if (!env.includes(`Model ${q.model} firmware ${q.fw}`)) wrongDevice++;
    }
    if (q.expected) {
      positives++;
      if (ids.includes(q.expected)) { hits++; correct++; }
    } else {
      negatives++;
      if (ids.length) falsePositives++;
    }
  }
  return {
    system: name,
    recallAt3: round(hits / Math.max(1, positives), 3),
    precisionAt3: round(correct / Math.max(1, returned), 3),
    incorrectCompatibilityRate: round(wrongDevice / Math.max(1, returned), 4),
    falseRecommendationRate: round(falsePositives / Math.max(1, negatives), 3),
    medianMs: round(quantile(latencies, 0.5)),
    p95Ms: round(quantile(latencies, 0.95)),
    widenedQueries: widened,
    queries: queries.length,
  };
}

async function runSize(size, chromaUp) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-bench-'));
  const cleanup = [];
  const t = { after: (fn) => cleanup.push(fn) };
  const namespace = 'bench_' + Math.random().toString(36).slice(2, 8);
  const config = { ...(chromaUp ? { VECTOR_STORE: 'chroma', CHROMA_URL, VECTOR_NAMESPACE: namespace } : {}) };
  const w = await world(t, { config, file: join(dir, 'bench.sqlite') });
  const bot = w.botOf(w.company);
  const pool = ALL.slice(0, size);
  const inPool = new Set(pool.map(keyOf));
  const ids = new Map();
  const seedStart = performance.now();
  w.db().transaction(() => {
    for (const e of pool) {
      const row = w.h.memoryPool.insert({
        companyId: w.company, chatbotId: bot, origin: 'specialist_confirmed', sourceKey: 'b:' + keyOf(e), customerConfirmed: true,
        title: `${e.topic.title} fix`, symptoms: e.topic.symptom[0], steps: [`${e.topic.steps} Revision ${e.fw}.`],
        applicability: { environmentText: `Model ${e.model} firmware ${e.fw}` }, safety: { restrictions: [], noneIdentified: true, reviewed: true }, initialConfidence: 0.85,
      });
      ids.set(keyOf(e), row.id);
    }
  })();
  const seedMs = performance.now() - seedStart;

  // Queries: paraphrased symptoms on a specific device; half of the negatives name a device that has no fix.
  const queries = [];
  for (const e of shuffle(pool).slice(0, QUERIES)) queries.push({ text: `${pick(e.topic.symptom.slice(1))}. Model ${e.model} firmware ${e.fw}.`, model: e.model, fw: e.fw, expected: ids.get(keyOf(e)) });
  const missing = ALL.slice(size).filter((e) => !inPool.has(keyOf(e)));
  for (const e of shuffle(missing).slice(0, Math.min(50, missing.length))) queries.push({ text: `${pick(e.topic.symptom.slice(1))}. Model ${e.model} firmware ${e.fw}.`, model: e.model, fw: e.fw, expected: null });

  const results = { size, seedMs: round(seedMs, 0), systems: [] };
  const args = (text) => ({ companyId: w.company, chatbotId: bot, text });
  results.systems.push(await measure('original (full scan)', async (text) => legacyRetrieve(w.db(), args(text)), queries));

  // The upgraded retriever, SQLite only (vector store off): FTS5 top-K plus a bounded scan for small pools.
  const embeddedBefore = w.h.embedding.stats().textsEmbedded;
  // (The vector store is switched off for this row so it measures the SQLite-only path, not an index that is still empty.)
  const available = w.h.vectors.available;
  w.h.vectors.available = () => false;
  results.systems.push(await measure('upgraded, SQLite only', (text) => w.h.memoryPool.retrieve(args(text)), queries));
  w.h.vectors.available = available;

  if (chromaUp) {
    const t0 = performance.now();
    const drained = await w.h.vectorIndex.drain({ maxBatches: Math.ceil(size / 50) + 5 });
    const indexMs = performance.now() - t0;
    const indexed = w.h.vectorIndex.summary();
    const row = await measure('upgraded + ChromaDB', (text) => w.h.memoryPool.retrieve(args(text)), queries);
    row.indexing = { documents: indexed.indexed, seconds: round(indexMs / 1000), documentsPerSecond: round(indexed.indexed / (indexMs / 1000), 1), failed: indexed.failed, drained };
    row.embeddingCalls = { apiCalls: w.h.embedding.stats().apiCalls, textsEmbeddedLocally: w.h.embedding.stats().textsEmbedded - embeddedBefore };
    results.systems.push(row);
    // Clean up the benchmark collections.
    const { ChromaClient } = await import('chromadb');
    const u = new URL(CHROMA_URL);
    const client = new ChromaClient({ host: u.hostname, port: Number(u.port) || 80, ssl: u.protocol === 'https:' });
    for (const c of await client.listCollections()) if (String(c.name).startsWith(namespace)) await client.deleteCollection({ name: c.name });
  }
  for (const fn of cleanup) await fn();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return results;
}

const chromaUp = await fetch(CHROMA_URL + '/api/v2/heartbeat', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
console.log(`Retrieval benchmark (synthetic; offline embedding ${LOCAL_EMBEDDING_MODEL}; ChromaDB ${chromaUp ? 'at ' + CHROMA_URL : 'NOT reachable, skipped'})`);
const report = { generatedAt: new Date().toISOString(), embedding: LOCAL_EMBEDDING_MODEL, chroma: chromaUp ? CHROMA_URL : null, queriesPerSize: QUERIES, sizes: [] };
for (const size of SIZES) {
  const r = await runSize(size, chromaUp);
  report.sizes.push(r);
  console.log(`\n=== ${size} resolutions (seeded in ${r.seedMs} ms) ===`);
  console.table(r.systems.map(({ indexing, embeddingCalls, drained, ...rest }) => rest));
  const c = r.systems.find((s) => s.indexing);
  if (c) console.log(`indexing: ${c.indexing.documents} docs in ${c.indexing.seconds}s (${c.indexing.documentsPerSecond}/s), failed ${c.indexing.failed}; embedding API calls ${c.embeddingCalls.apiCalls}`);
}
if (OUT) await writeFile(OUT, JSON.stringify(report, null, 2));
process.exit(0);
