// Semantic-quality comparison on the SAME held-out corpus and settings:
//   A. SQLite only            (FTS5 + offline local vectors; vector index switched off)
//   B. Chroma + local vectors (ChromaDB index, offline hashed-concept embeddings)
//   C. Chroma + neural        (ChromaDB index, a real OpenAI-compatible embedding model) - only when configured
//
//   node scripts/benchmark-semantic.js [--chroma http://127.0.0.1:8000] [--out file.json]
//   Neural row: set EMBEDDING_MODEL and OPENAI_API_KEY (and OPENAI_BASE_URL if not OpenAI) in the environment or .env. It sends only the
//   synthetic texts in evaluation/semantic-corpus.js to the provider, through the privacy boundary.
//
// Metrics: Recall@3 on paraphrases, "unsafe/incompatible recommendation rate" (a recommendation where none is allowed: wrong device,
// safety restriction hit, or unrelated question), latency (median/p95 of the retrieval call) and embedding API usage. Nothing here
// measures real customers; the corpus is small and written by us.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world } from '../test/_helpers.js';
import { FIXES, PARAPHRASES, INCOMPATIBLE, SAFETY, UNRELATED } from '../evaluation/semantic-corpus.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const CHROMA = arg('chroma', process.env.CHROMA_URL || 'http://127.0.0.1:8000');
const OUT = arg('out', null);
const neuralConfigured = Boolean(process.env.EMBEDDING_MODEL && process.env.OPENAI_API_KEY);
const chromaUp = await fetch(CHROMA + '/api/v2/heartbeat', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
const q = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const round = (n, d = 1) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

async function runSystem(name, { chroma, neural }) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-sem-'));
  const cleanup = [];
  const namespace = 'sem_' + Math.random().toString(36).slice(2, 8);
  const config = {
    ...(chroma ? { VECTOR_STORE: 'chroma', CHROMA_URL: CHROMA, VECTOR_NAMESPACE: namespace } : {}),
    ...(neural ? { EMBEDDING_MODEL: process.env.EMBEDDING_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL && { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }), ...(process.env.EMBEDDING_DIMENSIONS && { EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS }) } : {}),
  };
  const w = await world({ after: (fn) => cleanup.push(fn) }, { config, file: join(dir, 'sem.sqlite') });
  const bot = w.botOf(w.company);
  const ids = {};
  for (const f of FIXES)
    ids[f.id] = w.seed(w.company, { title: f.title, symptoms: f.symptoms, steps: [f.steps], environment: f.env, sourceKey: 'sem:' + f.id, ...(f.restriction && { safety: { restrictions: [{ text: f.restriction, keywords: [] }], reviewed: true } }) }).id;
  if (chroma) await w.h.vectorIndex.drain();
  else w.h.vectors.available = () => false; // SQLite-only row: the vector index is off
  const lat = [];
  const ask = async (text) => { const t0 = performance.now(); const out = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: bot, text }); lat.push(performance.now() - t0); return out; };
  let hits = 0, total = 0, offered = 0, forbidden = 0;
  const misses = [];
  for (const [id, list] of Object.entries(PARAPHRASES)) for (const p of list) {
    total++;
    const out = await ask(`${p}. Model X firmware 4.`);
    if (out.eligible.slice(0, 3).some((c) => c.id === ids[id])) hits++; else misses.push(id);
  }
  for (const [, text] of INCOMPATIBLE) { forbidden++; if ((await ask(text)).eligible.length) offered++; }
  for (const [, text] of SAFETY) { forbidden++; if ((await ask(text)).eligible.length) offered++; }
  for (const text of UNRELATED) { forbidden++; if ((await ask(text)).eligible.length) offered++; }
  const stats = w.h.embedding.stats();
  const result = {
    system: name,
    embedding: w.h.embedding.model + (w.h.embedding.isRemote ? ' (neural)' : ' (offline, not neural)'),
    recallAt3: round(hits / total, 3), positives: total,
    forbiddenRecommendations: `${offered}/${forbidden}`, unsafeOrIncompatibleRate: round(offered / forbidden, 3),
    medianMs: round(q(lat, 0.5)), p95Ms: round(q(lat, 0.95)),
    embeddingApiCalls: stats.apiCalls, textsEmbedded: stats.textsEmbedded, queryCacheHits: stats.queryCacheHits,
    missedTopics: [...new Set(misses)],
  };
  if (chroma) {
    const { ChromaClient } = await import('chromadb');
    const u = new URL(CHROMA);
    const client = new ChromaClient({ host: u.hostname, port: Number(u.port) || 80, ssl: false });
    for (const c of await client.listCollections()) if (String(c.name).startsWith(namespace)) await client.deleteCollection({ name: c.name });
  }
  for (const fn of cleanup) await fn();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return result;
}

const report = { generatedAt: new Date().toISOString(), corpus: { fixes: FIXES.length, positives: Object.values(PARAPHRASES).flat().length, forbidden: INCOMPATIBLE.length + SAFETY.length + UNRELATED.length }, systems: [] };
report.systems.push(await runSystem('A. SQLite only', { chroma: false, neural: false }));
if (chromaUp) report.systems.push(await runSystem('B. Chroma + local vectors', { chroma: true, neural: false }));
else report.systems.push({ system: 'B. Chroma + local vectors', skipped: `ChromaDB not reachable at ${CHROMA}` });
// Probe the embedding endpoint first: if it cannot serve embeddings the row is reported as not run, never scored on the offline fallback.
async function neuralProbe() {
  const { createEmbeddingService } = await import('../server/embedding-service.js');
  const svc = createEmbeddingService({ EMBEDDING_MODEL: process.env.EMBEDDING_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL && { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }), ...(process.env.EMBEDDING_DIMENSIONS && { EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS }) });
  try { await svc.embedDocuments(['connectivity check']); return null; } catch (e) { return e.message; }
}
const host = process.env.OPENAI_BASE_URL ? new URL(process.env.OPENAI_BASE_URL).host : 'api.openai.com';
if (!neuralConfigured) report.systems.push({ system: 'C. Chroma + neural embeddings', skipped: 'not run: set EMBEDDING_MODEL and OPENAI_API_KEY' });
else if (!chromaUp) report.systems.push({ system: 'C. Chroma + neural embeddings', skipped: `ChromaDB not reachable at ${CHROMA}` });
else {
  const problem = await neuralProbe();
  if (problem) report.systems.push({ system: 'C. Chroma + neural embeddings', skipped: `not run: the embedding endpoint (${host}, model ${process.env.EMBEDDING_MODEL}) could not serve embeddings: ${problem}` });
  else report.systems.push(await runSystem('C. Chroma + neural embeddings', { chroma: true, neural: true }));
}
console.log(`Semantic benchmark (synthetic corpus: ${report.corpus.fixes} fixes, ${report.corpus.positives} paraphrases, ${report.corpus.forbidden} must-not-recommend queries)`);
console.table(report.systems.map(({ missedTopics, ...rest }) => rest));
for (const s of report.systems) if (s.missedTopics?.length) console.log(`${s.system} missed: ${s.missedTopics.join(', ')}`);
if (OUT) await writeFile(OUT, JSON.stringify(report, null, 2));
process.exit(0);
