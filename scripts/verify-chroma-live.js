// Live end-to-end verification against a REAL ChromaDB server (not a test double).
//
//   node scripts/verify-chroma-live.js [--chroma http://127.0.0.1:8000] [--phase a|b|all] [--manifest file]
//
// Phase a runs the lifecycle scenarios and leaves its vectors in ChromaDB; phase b (run after you RESTART the ChromaDB server) checks
// that the persisted vectors survived and then cleans up. "all" (default) runs both back to back without a server restart.
// A genuine network outage is produced by a TCP proxy placed between the app and ChromaDB that the script can close and reopen.
import net from 'node:net';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world, ISSUE, FOUR } from '../test/_helpers.js';
import { createVectorStore } from '../server/vector-store.js';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const CHROMA = arg('chroma', process.env.CHROMA_URL || 'http://127.0.0.1:8000');
const PHASE = arg('phase', 'all');
const MANIFEST = arg('manifest', join(tmpdir(), 'continuum-verify-chroma.json'));
const NAMESPACE = 'verify_live';
const results = [];
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true, detail: detail || '' }); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message).split('\n')[0] }); }
};
const must = (cond, message) => { if (!cond) throw new Error(message); };

const reachable = await fetch(CHROMA + '/api/v2/heartbeat', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
if (!reachable) { console.error(`ChromaDB is not reachable at ${CHROMA}. Start it with "npm run chroma:start" (or docker compose up -d chroma).`); process.exit(2); }
const target = new URL(CHROMA);
const cleanupCollections = async () => {
  const { ChromaClient } = await import('chromadb');
  const client = new ChromaClient({ host: target.hostname, port: Number(target.port) || 80, ssl: false });
  for (const c of await client.listCollections()) if (String(c.name).startsWith(NAMESPACE)) await client.deleteCollection({ name: c.name });
};

if (PHASE === 'a' || PHASE === 'all') {
  // A proxy in front of ChromaDB: closing it is a real connection failure for the application.
  const sockets = new Set();
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(target.port) || 80, target.hostname);
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream); upstream.pipe(client);
    const done = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', done); upstream.on('error', done); client.on('close', done); upstream.on('close', done);
  });
  const listen = () => new Promise((r) => proxy.listen(Number(arg('proxy-port', 0)) || 0, '127.0.0.1', r));
  await listen();
  const port = proxy.address().port;
  const offline = () => new Promise((r) => { for (const s of sockets) s.destroy(); proxy.close(r); });
  const online = () => new Promise((r) => proxy.listen(port, '127.0.0.1', r));

  const dir = await mkdtemp(join(tmpdir(), 'continuum-live-'));
  const cleanup = [];
  const w = await world({ after: (fn) => cleanup.push(fn) }, { config: { VECTOR_STORE: 'chroma', CHROMA_URL: `http://127.0.0.1:${port}`, VECTOR_NAMESPACE: NAMESPACE, CHROMA_TIMEOUT_MS: '1500' }, file: join(dir, 'live.sqlite') });
  let h = w.h;
  const model = () => w.h.embedding.modelId();
  const present = async (...ids) => w.h.vectors.presentIds(model(), ids);
  const ask = (text, companyId = w.company) => w.h.memoryPool.retrieve({ companyId, chatbotId: w.botOf(companyId), text });
  const row = (id) => w.db().prepare('SELECT status FROM memory_pool WHERE id=?').get(id)?.status;
  const state = (id) => w.db().prepare('SELECT status,attempts FROM vector_index_state WHERE memory_id=?').get(id);
  const seed = (title, i, extra = {}) => w.seed(w.company, { title, symptoms: FOUR[i][1], steps: [FOUR[i][2]], sourceKey: 'live:' + title, ...extra });
  const manifest = { namespace: NAMESPACE, ids: {} };

  let p1, p2, p3, p4, b1;
  await check('1. publish -> index -> retrieve (ChromaDB serves the semantic branch)', async () => {
    p1 = seed('Display flicker: adaptive refresh', 0);
    const d = await w.h.vectorIndex.drain();
    must(d.indexed >= 1, 'nothing indexed');
    must((await present(p1.id)).has(p1.id), 'vector missing in ChromaDB');
    const out = await ask('The panel keeps blinking whenever the laptop boots. Model X firmware 4.');
    must(out.source === 'chroma' && out.eligible.some((c) => c.id === p1.id), 'not retrieved via chroma: ' + out.source);
    return `${d.indexed} indexed, retrieved via ${out.source}`;
  });
  await check('2. revise -> supersede (old vector removed, new vector present)', async () => {
    p2 = w.h.memoryPool.revise({ companyId: w.company, chatbotId: w.botOf(w.company), id: 'staff-1' }, p1.id, { title: 'Display flicker: driver', symptoms: FOUR[0][1], environment: 'Model X firmware 4', solution: 'Install the approved display driver 4.2 and restart the laptop.', confirmed: true, reviewedForPrivacy: true, version: 1 });
    await w.h.vectorIndex.drain();
    const got = await present(p1.id, p2.id);
    must(!got.has(p1.id) && got.has(p2.id), `old=${got.has(p1.id)} new=${got.has(p2.id)}`);
    const out = await ask(ISSUE);
    must(!out.eligible.some((c) => c.id === p1.id), 'superseded version recommended');
  });
  await check('3. retire -> delete (vector gone, never recommended)', async () => {
    w.db().prepare("UPDATE memory_pool SET status='retired' WHERE id=?").run(p2.id);
    must((await ask(ISSUE)).eligible.length === 0, 'retired knowledge recommended before the worker ran');
    await w.h.vectorIndex.drain();
    must(!(await present(p2.id)).has(p2.id), 'vector still present');
  });
  await check('4. customer erasure with "withdraw what was learned" removes the vector', async () => {
    const alice = await w.customer('alice');
    const ticket = await w.ticket(alice, ISSUE);
    await w.ask(alice, ticket, `Please call me on 415 555 0100. ${ISSUE}`);
    p3 = seed('Wi-Fi drops: reconnect', 1, { environment: 'Model X firmware 4' });
    w.db().prepare('UPDATE memory_pool SET source_ticket_id=? WHERE id=?').run(ticket, p3.id);
    await w.h.vectorIndex.drain();
    must((await present(p3.id)).has(p3.id), 'not indexed before erasure');
    const r = (await alice.api('privacy/erase', { confirmed: true, ticketId: ticket, retireSharedKnowledge: true })).data;
    must(r.erased.withdrawnKnowledge === 1, 'knowledge not withdrawn: ' + JSON.stringify(r.erased));
    await w.h.vectorIndex.drain();
    must(!(await present(p3.id)).has(p3.id), 'vector remains after erasure');
    must(!JSON.stringify(w.h.store.data).includes('415 555 0100'), 'phone number remains in stored data');
  });
  await check('5. real outage: SQLite-only fallback answers, changes stay pending, then recovery', async () => {
    await offline();
    p4 = seed('Printer jam: rear tray', 3);
    const failed = await w.h.vectorIndex.drain();
    must(failed.failed >= 1, 'outage not detected');
    must(['pending', 'processing'].includes(state(p4.id).status), 'job not kept pending: ' + state(p4.id).status);
    const out = await ask('The printer says jam but the display flickers. Model X firmware 4. Connect an external monitor to check.');
    must(out.source === 'sqlite', 'did not fall back: ' + out.source);
    const hp = await w.h.vectorIndex.health({ probe: true });
    must(hp.vectorStore.ok === false, 'health did not report the outage');
    await online();
    const later = Date.now() + 3 * 3600000;
    const rec = await w.h.vectorIndex.drain({ at: later });
    must(rec.indexed >= 1, 'did not recover: ' + JSON.stringify(rec));
    must((await present(p4.id)).has(p4.id), 'vector missing after recovery');
    must(state(p4.id).status === 'indexed', 'state not indexed');
    return 'fallback used while offline; indexed after recovery';
  });
  await check('6. tenant and service isolation (API, FTS and vector queries)', async () => {
    b1 = w.seed(w.companyB, { title: 'Company B secret display fix', symptoms: FOUR[0][1], steps: ['Company B private steps for display flicker on startup.'], sourceKey: 'live:b' });
    const itBot = w.seed(w.company, { title: 'IT desk display fix', symptoms: FOUR[0][1], steps: ['IT desk private steps for display flicker on startup.'], chatbotId: w.botOf(w.company, 'it'), sourceKey: 'live:it' });
    await w.h.vectorIndex.drain();
    const a = await ask(ISSUE);
    must(!a.eligible.some((c) => [b1.id, itBot.id].includes(c.id)), 'retrieval crossed tenant/service');
    const q = await w.h.embedding.embedQuery(ISSUE);
    const hitsA = await w.h.vectors.searchKnowledgeVectors({ modelId: q.model, vector: q.vector, companyId: w.company, chatbotId: w.botOf(w.company), limit: 50 });
    must(!hitsA.some((x) => [b1.id, itBot.id].includes(x.id)), 'vector search crossed tenant/service');
    const wrong = await w.h.vectors.searchKnowledgeVectors({ modelId: q.model, vector: q.vector, companyId: w.company, chatbotId: w.botOf(w.companyB), limit: 50 });
    must(wrong.length === 0, 'a chatbot of another company returned results');
    const customer = await w.customer('carol');
    const t = await w.ticket(customer, ISSUE);
    await w.ask(customer, t, ISSUE);
    const text = JSON.stringify((await w.ask(customer, t, 'Still need help')).data);
    must(!/Company B private|IT desk private/.test(text), 'API response leaked another scope');
    const direct = await w.h.memoryPool.retrieve({ companyId: w.company, chatbotId: w.botOf(w.companyB), text: ISSUE });
    must(direct.eligible.length === 0, 'crafted foreign chatbot id returned knowledge');
  });
  await check('7. reconciliation against the real index (orphan removed, missing and outdated re-queued)', async () => {
    const col = (await (async () => { const { ChromaClient } = await import('chromadb'); const c = new ChromaClient({ host: target.hostname, port: Number(target.port) || 80, ssl: false }); const list = await c.listCollections(); return c.getCollection({ name: list.find((x) => String(x.name).startsWith(NAMESPACE)).name, embeddingFunction: null }); })());
    const q = await w.h.embedding.embedQuery('orphan');
    await col.upsert({ ids: ['ghost-vector'], embeddings: [Array.from(q.vector)], metadatas: [{ company_id: w.company, chatbot_id: w.botOf(w.company), doc_hash: 'x' }] });
    await col.delete({ ids: [p4.id] });
    const rec = await w.h.vectorIndex.reconcileVectorIndex();
    must(rec.removedOrphans >= 1 && rec.queuedMissing >= 1, JSON.stringify(rec));
    await w.h.vectorIndex.drain();
    const got = await present('ghost-vector', p4.id);
    must(!got.has('ghost-vector') && got.has(p4.id), 'index not repaired');
  });
  await check('8. application restart: same SQLite file, no needless re-embedding, retrieval unchanged', async () => {
    w.restart();
    h = w.h;
    const d = await w.h.vectorIndex.drain();
    must(d.indexed === 0 && w.h.embedding.stats().textsEmbedded === 0, `re-embedded after restart: ${JSON.stringify(d)}`);
    const out = await ask('The printer says jam but the display flickers. Model X firmware 4. Connect an external monitor to check.');
    must(out.source === 'chroma' && out.eligible.some((c) => c.id === p4.id), 'not retrieved after restart');
  });
  await check('9. migrations and queue health on the real stack', async () => {
    const versions = w.db().prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
    must([5, 6, 7, 8, 9].every((v) => versions.includes(v)), 'missing migrations: ' + versions);
    const sum = w.h.vectorIndex.summary();
    must(sum.failed === 0 && sum.pending === 0, 'queue not clean: ' + JSON.stringify({ ...sum, failedJobs: undefined }));
    const hv = await w.h.vectorIndex.health({ probe: true });
    must(hv.vectorStore.ok && hv.index.stale === 0, 'health not green');
    return `migrations ${versions.join(',')}; indexed ${sum.indexed}`;
  });
  manifest.ids = { p4: p4?.id, b1: b1?.id, model: model() };
  await writeFile(MANIFEST, JSON.stringify(manifest));
  for (const fn of cleanup) await fn();
  await new Promise((r) => proxy.close(r));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

if (PHASE === 'b' || PHASE === 'all') {
  await check('10. vectors persisted in ChromaDB (new client; after a server restart when run as phase b)', async () => {
    const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
    const store = createVectorStore({ VECTOR_STORE: 'chroma', CHROMA_URL: CHROMA, VECTOR_NAMESPACE: m.namespace });
    const present = await store.presentIds(m.ids.model, [m.ids.p4, m.ids.b1]);
    must(present.has(m.ids.p4) && present.has(m.ids.b1), 'persisted vectors missing');
    const health = await store.getVectorStoreHealth({ probe: true, modelId: m.ids.model });
    must(health.ok && health.count >= 2, 'store unhealthy or empty');
    return `${health.count} vectors present`;
  });
  await cleanupCollections().catch(() => {});
}

const width = Math.max(...results.map((r) => r.name.length));
console.log(`\nLive ChromaDB verification against ${CHROMA} (phase ${PHASE})\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
