// Create a SAMPLE company with invented history, so the console's "repeat problems answered without a specialist" figure has numbers to show.
//
//   node scripts/seed-sample-company.js [database file]      (default: data/sample.sqlite; then start the server with DATABASE_FILE=that file)
//
// Everything is synthetic and says so: the company is marked in `sample_companies`, so the console labels every figure for it
// "SYNTHETIC SAMPLE DATA". The history is produced through the same public API a real company uses (requests, chat, "It worked" / "Still need help",
// specialist hand-offs, customer confirmations), in this order, so the before/after split is real rather than typed in:
//   before:  four customers report problems and no reusable fix exists yet. One is solved by a standard first step, three need a specialist.
//   learning: the specialist's three fixes are confirmed by those customers.
//   after:   eight later customers report the same kinds of problem in their own words.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHandler } from '../server/app.js';
import { client } from '../test/_helpers.js';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to create sample data in production.'); process.exit(1); }
const file = process.argv[2] || 'data/sample.sqlite';
mkdirSync(dirname(file), { recursive: true });
for (const f of [file, file + '-wal', file + '-shm', file + '.key']) if (existsSync(f)) rmSync(f);

const PASSWORD = 'a fictional sample passphrase 2026';
const h = createHandler({ file, config: { APP_URL: 'http://localhost:3000' } });
const get = () => h;
const owner = client(get);
const must = (r, what) => { if (r.status >= 300) throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`); return r; };

const reg = must(await owner.api('auth/register', { name: 'Sample Owner', email: 'sample-owner@example.test', password: PASSWORD, createCompany: true, companyName: 'Sample Support Co (synthetic)', provider: 'repair' }), 'owner registration');
const company = reg.data.profile.companyId;
h.store.db.prepare('INSERT OR REPLACE INTO sample_companies(company_id) VALUES(?)').run(company);
const code = must(await owner.api('company/customer-code', { confirmed: true }), 'customer code').data.code;

let n = 0;
async function customer() {
  h.store.db.prepare('DELETE FROM rate_limits').run(); // a local, throwaway database: registering a dozen sample people must not trip the per-address signup limit
  const c = client(get);
  const name = 'sample' + ++n;
  must(await c.api('auth/register', { name: 'Sample Customer ' + n, email: name + '@example.test', password: PASSWORD, companyCode: code, provider: 'repair' }), 'customer registration');
  return c;
}
async function report(c, title, issue) {
  const t = must(await c.api('request', { title, issueDesc: issue, confirmed: true }), 'request').data.ticketId;
  const first = must(await c.api('chat', { ticketId: t, message: issue }), 'chat').data;
  return { ticketId: t, first };
}
const worked = (c, a) => c.api('troubleshooting/outcome', { attemptId: a.id, worked: true, confirmed: true });
const failed = (c, a) => c.api('troubleshooting/outcome', { attemptId: a.id, worked: false, confirmed: true });

const PROBLEMS = [
  { key: 'flicker', title: 'Laptop display', env: 'Model X firmware 4', symptoms: 'Display flickers after startup', fixTitle: 'Display flicker after startup', solution: 'Disable adaptive refresh in Display settings, then restart the laptop.',
    first: 'The display flickers after startup on Model X firmware 4.', later: ['My Model X firmware 4 screen keeps blinking when it boots.', 'Monitor on Model X firmware 4 flashes right after I switch it on.', 'Model X firmware 4: picture shimmers at startup.'] },
  { key: 'wifi', title: 'Laptop Wi-Fi', env: 'Model R firmware 2', symptoms: 'Wi-Fi disconnects every few minutes', fixTitle: 'Wi-Fi keeps dropping', solution: 'Remove the saved network profile in Network settings and reconnect with the company profile.',
    first: 'Wi-Fi disconnects every few minutes on Model R firmware 2.', later: ['My Model R firmware 2 keeps losing the wireless connection.', 'Internet drops all the time on Model R firmware 2.'] },
  { key: 'battery', title: 'Battery drain', env: 'Model B firmware 3', symptoms: 'Battery drains quickly after an update', fixTitle: 'Battery drains quickly', solution: 'Open Power settings, switch the power profile to Balanced and restart the device.',
    first: 'The battery drains quickly on Model B firmware 3.', later: ['Model B firmware 3 loses its charge really fast.', 'Battery on my Model B firmware 3 runs down within a couple of hours.'] },
];

// ---- before: no reusable fix exists
const baseline = [];
for (const p of PROBLEMS) { const c = await customer(); baseline.push({ p, c, ...(await report(c, p.title, p.first)) }); }
{ const c = await customer(); const r = await report(c, 'Internet down', 'The internet is offline on my Model R firmware 2 laptop.'); if (r.first.attempt?.source === 'standard') await worked(c, r.first.attempt); }

// ---- learning: a specialist solves each baseline request and the customer confirms
for (const b of baseline) {
  if (b.first.attempt) await failed(b.c, b.first.attempt);
  let handoff = (await b.c.api('handoff', { ticketId: b.ticketId, summary: b.p.first, confirmed: true }));
  if (handoff.status >= 300) handoff = { data: { id: (await owner.api('operator')).data.cases.find((x) => x.ticketId === b.ticketId)?.id } };
  must(await owner.api('operator/assign', { handoffId: handoff.data.id, assignedTo: reg.data.profile.id, revision: 0, confirmed: true }), 'assign');
  const solved = must(await owner.api('operator/resolve', { handoffId: handoff.data.id, revision: 1, title: b.p.fixTitle, symptoms: b.p.symptoms, environment: b.p.env, solution: b.p.solution, confirmed: true, reviewedForPrivacy: true }), 'resolve');
  must(await b.c.api('resolutions/confirm', { id: solved.data.id, accepted: true, confirmed: true }), 'confirm');
}

// ---- after: repeat problems in the customers' own words. The product always offers its standard first step; a customer who says
// "Still need help" is then shown the fix that earlier customers confirmed.
const pending = (ticketId) => h.store.db.prepare("SELECT id, source FROM troubleshooting_attempts WHERE ticket_id=? AND outcome='pending' ORDER BY created_at DESC LIMIT 1").get(ticketId);
async function repeat(c, title, wording, { learnedWorks }) {
  const r = await report(c, title, wording);
  let attempt = pending(r.ticketId);
  // Some topics have a standard first step (connectivity, charging); the others go straight to company knowledge.
  if (attempt?.source === 'standard') {
    await failed(c, attempt);
    must(await c.api('chat', { ticketId: r.ticketId, message: 'Continue troubleshooting' }), 'continue');
    attempt = pending(r.ticketId);
  }
  if (process.env.SEED_DEBUG) console.log(JSON.stringify(wording).slice(0, 70), '->', attempt?.source ?? 'no attempt', '| stage:', r.first.workflow?.stage, '|', String(r.first.reply).slice(0, 90));
  if (attempt?.source !== 'learned') return false;
  await (learnedWorks ? worked(c, attempt) : failed(c, attempt));
  return true;
}
let shown = 0, total = 0;
for (const p of PROBLEMS) for (const wording of p.later) { total++; if (await repeat(await customer(), p.title, wording, { learnedWorks: true })) shown++; }
// one repeat customer for whom the learned fix did not help, and one problem nobody has solved before
total++; if (await repeat(await customer(), 'Display again', 'Display flickers after startup on Model X firmware 4, even after the usual fix.', { learnedWorks: false })) shown++;
total++; await repeat(await customer(), 'Printer jam', 'The label printer jams on every third page.', { learnedWorks: true });
console.log(`${shown} of ${total} later customers were shown a fix an earlier customer had confirmed.`);

const m = (await owner.api(`companies/${encodeURIComponent(company)}/intelligence?chatbotId=${encodeURIComponent(company + ':repair')}`)).data.repeatProblems;
h.close();
console.log(`Sample company created in ${file}`);
console.log(`Repeat problems answered without a specialist: before ${m.baseline.solvedWithoutSpecialist}/${m.baseline.requests}, after ${m.after.solvedWithoutSpecialist}/${m.after.requests} (synthetic)`);
console.log('Start the server on it with:  DATABASE_FILE=' + file + ' npm start');
console.log('Sign in as sample-owner@example.test (a fictional account; passphrase is in this script).');
