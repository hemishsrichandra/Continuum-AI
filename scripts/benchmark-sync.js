// Measures a real batched sync of a synthetic SQLite knowledge base at 1,000 and 10,000 records, plus retrieval latency afterwards.
// Usage: npm run benchmark:sync. Results go to evaluation/sync-benchmark.json. Synthetic data only; the numbers describe this machine
// and this workload, not production.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createHandler } from '../server/app.js';
import { invoke } from './invoke.js';

const password = 'a fictional benchmark passphrase 2026';
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mb = (n) => Math.round(n / 1048576);
const out = [];

for (const n of [1000, 10000]) {
  const dir = await mkdtemp(join(tmpdir(), 'continuum-sync-bench-'));
  const file = join(dir, 'kb.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE kb(id TEXT, title TEXT, symptoms TEXT, steps TEXT, env TEXT)');
  const ins = db.prepare('INSERT INTO kb VALUES(?,?,?,?,?)');
  const topics = ['display flicker', 'battery drain', 'wifi drops', 'printer jam', 'audio crackle', 'keyboard lag', 'camera blur', 'storage full'];
  db.transaction(() => { for (let i = 0; i < n; i++) { const t = topics[i % topics.length]; ins.run(String(i).padStart(6, '0'), `${t} case ${i}`, `Customers report ${t} on unit ${i} after update ${i % 97}`, `Open settings page ${i % 53}, change option ${i % 31} and restart the device; confirm the ${t} is gone (${i}).`, 'Model X firmware 4'); } })();
  db.close();

  const h = createHandler({ file: join(dir, 'app.sqlite'), config: { ENABLE_OUTBOX_WORKER: 'false', DATA_SOURCE_SQLITE_DIRS: dir, DATA_SOURCE_BATCH_SIZE: '500' } });
  const client = () => { let cookie = '', csrf = ''; return async (route, body) => { const r = await invoke(h, route, { body, headers: { cookie, 'x-csrf-token': csrf } }); if (r.headers?.['Set-Cookie']) cookie = r.headers['Set-Cookie'].split(';')[0]; if (r.data?.csrfToken) csrf = r.data.csrfToken; if (r.status >= 400) throw new Error(route + ': ' + JSON.stringify(r.data)); return r.data; }; };
  const owner = client();
  const reg = await owner('auth/register', { name: 'Bench Owner', email: 'bench@example.test', password, createCompany: true, companyName: 'Bench Co', provider: 'repair' });
  const company = reg.profile.companyId, bot = company + ':repair';
  const created = await owner('company/data-sources', { confirmed: true, sourceType: 'sqlite', chatbotId: bot, name: 'Bench', fieldMapping: { fields: { externalId: 'id', title: 'title', symptoms: 'symptoms', steps: 'steps', applicability: 'env' }, diagnostics: {} }, connection: { path: file, table: 'kb' }, declaredVerified: true });

  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const sync = await owner(`company/data-sources/${created.source.id}/sync`, { confirmed: true });
  const syncMs = performance.now() - t0;
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);

  // Retrieval latency and a simple recall check: ask about 40 records by their own wording and see whether that record is in the top three.
  const lat = []; let hit = 0, asked = 0;
  for (let k = 0; k < 40; k++) {
    const i = Math.floor((k + 0.5) * (n / 40));
    const t = topics[i % topics.length];
    const q0 = performance.now();
    const r = await h.memoryPool.retrieve({ companyId: company, chatbotId: bot, text: `Customers report ${t} on unit ${i} after update ${i % 97} on Model X firmware 4` });
    lat.push(performance.now() - q0);
    asked++;
    if (r.eligible.some((c) => new RegExp(`\\bcase ${i}\\b`).test(c.row.title))) hit++;
  }
  out.push({
    records: n, batchSize: 500, syncSeconds: Math.round(syncMs / 10) / 100, recordsPerSecond: Math.round(n / (syncMs / 1000)), batches: sync.result.batches,
    inserted: sync.result.inserted, rssBeforeMB: mb(rssBefore), rssPeakMB: mb(peak), retrievalMedianMs: Math.round(median(lat) * 10) / 10,
    retrievalP95Ms: Math.round([...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.95)] * 10) / 10, recallAt3OnOwnWording: `${hit}/${asked}`,
  });
  console.log(JSON.stringify(out.at(-1)));
  h.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
await writeFile(new URL('../evaluation/sync-benchmark.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, note: 'Synthetic SQLite source, local vectors only, single machine. Not a production guarantee. Recall is measured on the records\' own wording, an easy case.', results: out }, null, 2));
process.exit(0);
