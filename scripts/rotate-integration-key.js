// Re-encrypt every stored integration secret under a NEW INTEGRATION_ENCRYPTION_KEY.
//
// Changing the key without this script makes every saved connection (Google Calendar, the company's ticket system, database sources and
// queued provider jobs) unreadable. Order of work:
//   1. Stop the server.            2. Run this script in dry-run mode (default) and read the counts.
//   3. Run it again with --apply (it copies the database to <file>.before-rotation first, then re-encrypts in ONE transaction).
//   4. Put the new key in INTEGRATION_ENCRYPTION_KEY and start the server.
//
//   OLD_INTEGRATION_ENCRYPTION_KEY=<base64> NEW_INTEGRATION_ENCRYPTION_KEY=<base64> node scripts/rotate-integration-key.js data/app.sqlite [--apply]
//   (with no OLD key set, the local <file>.key development key is used as the old key)
// Generate a key with: npm run secrets:generate. Keys are never printed.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const parseKey = (value, name) => {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new Error(`${name} must be a base64-encoded 32-byte key.`);
  return key;
};
function unseal(value, context, key) {
  const [iv, tag, data] = value.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(context));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString());
}
function seal(value, context, key) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(context));
  const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

/** Every place a sealed value lives, with the context string it was sealed under. */
const TARGETS = [
  { name: 'Google Calendar connections', select: 'SELECT account_id k, encrypted_token v FROM connections', context: (r) => r.k, update: 'UPDATE connections SET encrypted_token=? WHERE account_id=?' },
  { name: 'Ticket-system connections', select: 'SELECT company_id k, encrypted_token v FROM provider_connections', context: (r) => 'provider:' + r.k, update: 'UPDATE provider_connections SET encrypted_token=? WHERE company_id=?' },
  { name: 'Database and file sources', select: 'SELECT id k, encrypted_connection_uri v FROM company_data_sources WHERE encrypted_connection_uri IS NOT NULL', context: (r) => 'datasource:' + r.k, update: 'UPDATE company_data_sources SET encrypted_connection_uri=? WHERE id=?' },
  { name: 'Provider jobs', select: 'SELECT id k, payload v FROM provider_jobs', context: (r) => 'provider-job:' + r.k, update: 'UPDATE provider_jobs SET payload=? WHERE id=?' },
];

/**
 * Pure function over an open database. Throws before changing anything if any value cannot be read with the old key.
 * @returns {{counts: Record<string, number>, applied: boolean}}
 */
export function rotate(db, oldKey, newKey, { apply = false } = {}) {
  const counts = {};
  const work = [];
  for (const t of TARGETS) {
    let rows = [];
    try { rows = db.prepare(t.select).all(); } catch { /* table absent in an older database */ }
    counts[t.name] = rows.length;
    for (const r of rows) {
      let plain;
      try { plain = unseal(r.v, t.context(r), oldKey); } catch { throw new Error(`Cannot read a value in “${t.name}” with the old key. Nothing was changed.`); }
      work.push(() => db.prepare(t.update).run(seal(plain, t.context(r), newKey), r.k));
    }
  }
  const outbox = db.prepare("SELECT record_key, payload FROM records WHERE collection='outbox'").all().map((r) => ({ key: r.record_key, job: JSON.parse(r.payload) })).filter((x) => typeof x.job.payload === 'string' && x.job.payload.includes('.'));
  counts['Queued email and calendar jobs'] = outbox.length;
  for (const { key, job } of outbox) {
    let plain;
    try { plain = unseal(job.payload, job.id, oldKey); } catch { throw new Error('Cannot read a queued job with the old key. Nothing was changed.'); }
    work.push(() => db.prepare("UPDATE records SET payload=? WHERE collection='outbox' AND record_key=?").run(JSON.stringify({ ...job, payload: seal(plain, job.id, newKey) }), key));
  }
  if (apply) db.transaction(() => work.forEach((w) => w()))();
  return { counts, applied: apply };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  try {
    if (!file || !existsSync(file)) throw new Error('Usage: node scripts/rotate-integration-key.js <database file> [--apply]');
    const oldKey = process.env.OLD_INTEGRATION_ENCRYPTION_KEY ? parseKey(process.env.OLD_INTEGRATION_ENCRYPTION_KEY, 'OLD_INTEGRATION_ENCRYPTION_KEY') : existsSync(file + '.key') ? readFileSync(file + '.key') : null;
    if (!oldKey) throw new Error('Set OLD_INTEGRATION_ENCRYPTION_KEY (no local .key file was found).');
    const newKey = parseKey(process.env.NEW_INTEGRATION_ENCRYPTION_KEY, 'NEW_INTEGRATION_ENCRYPTION_KEY');
    if (apply) copyFileSync(file, file + '.before-rotation');
    const db = new Database(file);
    const result = rotate(db, oldKey, newKey, { apply });
    db.close();
    console.log((apply ? 'Re-encrypted' : 'Dry run: would re-encrypt') + ':');
    for (const [name, n] of Object.entries(result.counts)) console.log(`  ${name}: ${n}`);
    console.log(apply ? 'Done. Set INTEGRATION_ENCRYPTION_KEY to the new key and start the server. A copy was kept at ' + file + '.before-rotation.' : 'Nothing was changed. Run again with --apply when ready.');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
