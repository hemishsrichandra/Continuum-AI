// Two REAL worker processes against one SQLite file and a real ChromaDB. Skipped (and reported as skipped) when no ChromaDB is reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world, FOUR } from './_helpers.js';

const URL_ = process.env.CHROMA_URL || 'http://127.0.0.1:8000';
const reachable = await fetch(URL_ + '/api/v2/heartbeat', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
const live = { skip: reachable ? false : `ChromaDB is not reachable at ${URL_}` };
const worker = new URL('./helpers/index-worker.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const run = (env) => {
  const child = spawn(process.execPath, [worker], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out, err, result: JSON.parse((out.match(/RESULT (.*)/) || [])[1] || 'null') })));
  return { child, done };
};
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('two real worker processes share one index; killing one mid-job loses nothing', live, async (t) => {
  const namespace = 'mp_' + randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), 'continuum-mp-'));
  const file = join(dir, 'mp.sqlite');
  const w = await world(t, { file, config: { VECTOR_STORE: 'chroma', CHROMA_URL: URL_, VECTOR_NAMESPACE: namespace } });
  t.after(async () => {
    const { ChromaClient } = await import('chromadb');
    const u = new URL(URL_);
    const client = new ChromaClient({ host: u.hostname, port: Number(u.port) || 80, ssl: false });
    for (const c of await client.listCollections()) if (String(c.name).startsWith(namespace)) await client.deleteCollection({ name: c.name });
  });
  const env = { DB_FILE: file, CHROMA_URL: URL_, NAMESPACE: namespace };
  const seed = (n, tag) => { for (let i = 0; i < n; i++) w.seed(w.company, { title: `${FOUR[i % 4][0]} ${tag}${i}`, symptoms: FOUR[i % 4][1], steps: [`${FOUR[i % 4][2]} Revision ${tag}${i}.`], sourceKey: `mp:${tag}${i}` }); };
  const activeIds = () => w.db().prepare("SELECT id FROM memory_pool WHERE status='active'").all().map((r) => r.id).sort();
  const inIndex = async () => (await w.h.vectors.listIds(w.h.embedding.modelId())).sort();
  const states = () => w.db().prepare('SELECT status,COUNT(*) n FROM vector_index_state GROUP BY status').all();

  // 1. Two processes drain the same queue at the same time.
  seed(60, 'a');
  const [x, y] = [run(env), run(env)];
  const [rx, ry] = await Promise.all([x.done, y.done]);
  assert.equal(rx.code, 0, rx.err);
  assert.equal(ry.code, 0, ry.err);
  const total = (rx.result.indexed + ry.result.indexed + rx.result.unchanged + ry.result.unchanged);
  assert.ok(rx.result.indexed > 0 && ry.result.indexed > 0 || total >= 60, 'the work was shared or completed: ' + JSON.stringify([rx.result, ry.result]));
  assert.equal(rx.result.indexed + ry.result.indexed, activeIds().length, 'every passport was indexed exactly once across both processes');
  assert.deepEqual(await inIndex(), activeIds(), 'the index holds exactly the active passports: no duplicates, none missing');
  assert.deepEqual(states(), [{ status: 'indexed', n: states()[0].n }]);

  // 2. A worker is killed in the middle of a job (embedding stalls, then SIGKILL): its claim stays until the lease expires.
  seed(15, 'b');
  const stalled = run({ ...env, STALL_MS: '60000' });
  assert.ok(await waitFor(() => w.db().prepare("SELECT COUNT(*) n FROM vector_index_state WHERE status='processing'").get().n > 0), 'the worker claimed jobs');
  stalled.child.kill('SIGKILL');
  await stalled.done;
  assert.ok(w.db().prepare("SELECT COUNT(*) n FROM vector_index_state WHERE status='processing'").get().n > 0, 'the crashed worker left claimed jobs behind');
  const early = await run(env).done;
  assert.equal(early.result.indexed, 0, 'while the dead worker\'s lease is valid nobody else takes its jobs');
  // 3. After the lease expires another process takes over and finishes: nothing is lost or duplicated.
  const takeover = await run({ ...env, AT_OFFSET_MS: String(3 * 60000) }).done;
  assert.equal(takeover.code, 0, takeover.err);
  assert.equal(takeover.result.indexed, 15);
  assert.deepEqual(await inIndex(), activeIds());
  assert.deepEqual(w.db().prepare("SELECT status FROM vector_index_state GROUP BY status").all(), [{ status: 'indexed' }]);
});
