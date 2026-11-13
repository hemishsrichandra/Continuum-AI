// Pilot replay: "how often would Continuum have suggested the fix the specialist actually used?"
//
//   node scripts/pilot-replay.js --file solved-tickets.csv [--out evaluation/pilot-replay] [--warmup 20] [--embeddings]
//
// Read-only and offline: it reads an EXPORT of past solved tickets (CSV or JSON, the same formats the import screen
// accepts), never connects to a helpdesk, and works in a throw-away database that is deleted afterwards.
//
// Method (time-ordered replay, no peeking at the future):
//   for each ticket i after a warm-up, the knowledge base holds the fixes of tickets 0..i-1 only (drafted from their
//   resolution text exactly as the import screen does, and treated as approved); ticket i's problem is the query; the
//   top suggestions are compared with ticket i's ACTUAL resolution.
//
// The automatic "match" is a proxy (word overlap between the suggested steps and the real resolution). The number that
// matters is the human one: the CSV has an empty `human_match` column for a specialist to fill in (yes / partly / no).
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHandler } from '../server/app.js';
import { invoke } from './invoke.js';
import { parseTickets, draftTicket, fileText } from '../server/knowledge-import.js';
import { computeInitialConfidence } from '../server/passports.js';
import { customerFacts, evaluateConditions } from '../server/applicability.js';
import { safetyConflicts } from '../server/scoring.js';
import { scrubPII } from '../server/privacy.js';
import { tokens } from '../server/context.js';

const overlap = (a, b) => {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
};
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const bin = (score) => Math.min(4, Math.floor(score * 5)); // five equal-width ranking-score bins

/**
 * Time-separated replay. Two modes, never mixed:
 *   rolling (default)   tickets are replayed oldest first; each ticket is scored against the fixes of the tickets BEFORE it, and its own fix
 *                       becomes known only afterwards.
 *   strict holdout      `evaluateAfter` (an ISO date): knowledge is built ONLY from tickets older than that date and the later tickets are
 *                       scored against it; none of them is ever added. Use this for the number you would quote.
 * A ticket without a date makes the order the file order and the report says so: ordering then proves nothing about leakage.
 * `label` states what the data is ('synthetic' | 'real'); synthetic results are labelled and never evidence of production quality.
 */
export async function pilotReplay({ tickets, warmup = 20, threshold = 0.5, config = {}, log = () => {}, evaluateAfter = null, label = 'unlabelled' }) {
  if (tickets.length < warmup + 5) throw new Error(`Need at least ${warmup + 5} solved tickets for a replay (found ${tickets.length}).`);
  const ordered = tickets.map((t, i) => ({ ...t, i, at: Date.parse(t.date) })).sort((a, b) => (Number.isFinite(a.at) && Number.isFinite(b.at) ? a.at - b.at : a.i - b.i));
  const dated = ordered.filter((t) => Number.isFinite(t.at)).length;
  const cutoff = evaluateAfter ? Date.parse(evaluateAfter) : null;
  if (evaluateAfter && !Number.isFinite(cutoff)) throw new Error('evaluateAfter must be a date such as 2026-06-01.');
  if (cutoff !== null && dated < ordered.length) throw new Error('A strict time-separated holdout needs every ticket to have a date; some are missing one.');
  const trainCount = cutoff === null ? warmup : ordered.filter((t) => t.at < cutoff).length;
  if (cutoff !== null && (trainCount < 5 || ordered.length - trainCount < 5)) throw new Error(`The cutoff leaves ${trainCount} tickets to learn from and ${ordered.length - trainCount} to evaluate; each side needs at least 5.`);
  const directory = await mkdtemp(join(tmpdir(), 'continuum-pilot-'));
  const h = createHandler({ file: join(directory, 'pilot.sqlite'), config: { NODE_ENV: 'test', ENABLE_OUTBOX_WORKER: 'false', REQUIRE_EMAIL_VERIFICATION: 'false', ENABLE_DEMO_MODE: 'false', ...config } });
  try {
    const reg = await invoke(h, 'auth/register', { body: { name: 'Pilot owner', email: 'pilot@example.test', password: 'a pilot replay passphrase 2026', createCompany: true, companyName: 'Pilot', provider: 'repair' } });
    if (reg.status !== 201) throw new Error('could not create the replay workspace');
    const companyId = reg.data.profile.companyId, chatbotId = companyId + ':repair';
    const rows = [];
    const add = (t) => {
      const d = draftTicket(t);
      if (!d.steps.length || d.issues.some((x) => /credential/.test(x))) return;
      const applicability = d.appliesTo ? { environmentText: d.appliesTo } : { universal: false };
      const passport = { title: d.title, symptoms: d.symptoms, applicability, safety: { restrictions: [] }, steps: d.steps };
      const c = computeInitialConfidence(passport, { facts: customerFacts(d.appliesTo), author: { kind: 'unverified_import' } });
      try {
        h.memoryPool.insert({ companyId, chatbotId, origin: 'company_db_sync', status: 'active', locallyReviewed: true, sourceKey: 'pilot:' + t.i, externalRecordId: t.ref, ...passport, initialConfidence: c.score, customerConfirmed: false, evidence: { type: 'past_ticket_import', declaredVerified: false } });
      } catch { /* a record the privacy boundary refuses is simply not in the replay knowledge */ }
    };
    ordered.slice(0, trainCount).forEach(add);
    const stats = { incompatible: 0, unsafe: 0, bins: Array.from({ length: 5 }, () => ({ n: 0, hit: 0, score: 0 })) };
    for (let k = trainCount; k < ordered.length; k++) {
      const t = ordered[k];
      const query = scrubPII([t.subject, t.problem].filter(Boolean).join('. ')).text;
      const out = await h.memoryPool.retrieve({ companyId, chatbotId, text: query, factsText: [query, t.environment].join('\n'), allowedOrigins: ['company_db_sync'] });
      const facts = customerFacts([query, t.environment].join(' '));
      const top = out.eligible.slice(0, 3).map((e) => {
        const applicability = JSON.parse(e.row.applicability_json), safety = JSON.parse(e.row.safety_restrictions_json);
        // Judged against the ticket's FULL facts (including what the customer would only have said later), so a gate that let something through is caught here.
        const bad = applicability.conditions?.length ? evaluateConditions(applicability.conditions.filter((c) => c.required !== false), facts).status === 'conflict' : false;
        const unsafe = safetyConflicts(safety, facts, query).length > 0;
        if (bad) stats.incompatible++;
        if (unsafe) stats.unsafe++;
        return { title: e.row.title, steps: JSON.parse(e.row.steps_json).join(' '), score: Math.round(e.finalScore * 1000) / 1000, sim: Math.round(overlap(JSON.parse(e.row.steps_json).join(' '), t.resolution) * 100) / 100, incompatible: bad, unsafe };
      });
      rows.push({ ref: t.ref, problem: query, actual: scrubPII(t.resolution).text, top, withheld: out.withheld.length, knowledge: cutoff === null ? k : trainCount });
      if (top[0]) { const b = stats.bins[bin(top[0].score)]; b.n++; b.score += top[0].score; if (top[0].sim >= threshold) b.hit++; }
      if (cutoff === null) add(t); // rolling replay: a fix becomes known only after its ticket was evaluated. A strict holdout never learns from evaluated tickets.
      if (k % 50 === 0) log(`replayed ${k + 1 - trainCount} of ${ordered.length - trainCount}`);
    }
    const n = rows.length;
    const top1 = rows.filter((r) => r.top[0]?.sim >= threshold).length;
    const top3 = rows.filter((r) => r.top.some((x) => x.sim >= threshold)).length;
    const suggested = rows.filter((r) => r.top.length).length;
    const wrong = rows.filter((r) => r.top.length && r.top[0].sim < threshold).length;
    // How often the problem had been solved before at all (the best any retrieval could do on this data).
    const solvedBefore = rows.filter((r) => ordered.slice(0, r.knowledge).some((p) => overlap(p.resolution, r.actual) >= threshold)).length;
    const scored = stats.bins.reduce((a, b) => a + b.n, 0);
    const ece = scored ? stats.bins.reduce((sum, b) => sum + (b.n / scored) * (b.n ? Math.abs(b.hit / b.n - b.score / b.n) : 0), 0) : null;
    const summary = {
      dataLabel: label === 'synthetic' ? 'SYNTHETIC DATA: shows the mechanism works; it is not evidence of quality on real tickets.' : label === 'real' ? 'Real tickets (as exported). Only human_match judgements make these numbers a quality claim.' : 'Unlabelled data: treat as unverified.',
      method: cutoff === null ? 'rolling time-ordered replay' : `strict holdout: learned only from tickets before ${new Date(cutoff).toISOString().slice(0, 10)} (${trainCount}), scored ${ordered.length - trainCount} later tickets, none of which was ever learned from`,
      ordering: dated === ordered.length ? 'by ticket date' : `FILE ORDER: ${ordered.length - dated} of ${ordered.length} tickets have no date, so the order is not proven time-separated`,
      tickets: tickets.length, replayed: n, warmup: trainCount, threshold,
      escalationRate: +(rows.filter((r) => !r.top.length).length / n).toFixed(3),
      abstentionRate: +(rows.filter((r) => !r.top.length && !r.withheld).length / n).toFixed(3),
      incompatibleSuggestions: stats.incompatible,
      unsafeSuggestions: stats.unsafe,
      calibration: { note: 'The ranking score is not a probability. This shows how often the top suggestion matched, by score band; ece is the average gap between score and hit rate (lower is better, null with no suggestions).', ece: ece === null ? null : +ece.toFixed(3), bands: stats.bins.map((b, i) => ({ range: `${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}`, suggestions: b.n, hitRate: b.n ? +(b.hit / b.n).toFixed(3) : null, meanScore: b.n ? +(b.score / b.n).toFixed(3) : null })) },
      suggestedAny: suggested, suggestedRate: +(suggested / n).toFixed(3),
      top1Match: top1, top1Rate: +(top1 / n).toFixed(3),
      top3Match: top3, top3Rate: +(top3 / n).toFixed(3),
      topSuggestionDidNotMatch: wrong,
      askedForMoreDetails: rows.filter((r) => !r.top.length && r.withheld).length,
      ceiling: { similarFixExistedEarlier: solvedBefore, rate: +(solvedBefore / n).toFixed(3) },
      embedding: h.memoryPool.embeddingModel?.() || (config.EMBEDDING_MODEL ? config.EMBEDDING_MODEL : 'local-hashed-concepts (offline)'),
      caveat: 'Automatic match = word overlap between the suggested steps and the real resolution (a proxy). Fill in human_match in the CSV for the real figure.',
    };
    const csv = ['ticket,problem,actual_resolution,suggestion_1,suggestion_1_steps,auto_similarity,auto_match,suggestion_2,suggestion_3,human_match']
      .concat(rows.map((r) => [r.ref, r.problem, r.actual, r.top[0]?.title, r.top[0]?.steps, r.top[0]?.sim ?? '', r.top[0] ? (r.top[0].sim >= threshold ? 'yes' : 'no') : 'no suggestion', r.top[1]?.title, r.top[2]?.title, ''].map(csvCell).join(',')))
      .join('\n');
    return { summary, rows, csv };
  } finally {
    h.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const arg = (name, d = null) => { const i = process.argv.indexOf('--' + name); return i < 0 ? d : process.argv[i + 1] ?? true; };
  const file = arg('file');
  if (!file) { console.error('Usage: node scripts/pilot-replay.js --file solved-tickets.csv [--out evaluation/pilot-replay] [--warmup 20] [--evaluate-after 2026-06-01] [--label synthetic|real] [--embeddings]'); process.exit(2); }
  const config = {};
  if (process.argv.includes('--embeddings')) {
    try { process.loadEnvFile('.env'); } catch { /* use the environment */ }
    if (!process.env.EMBEDDING_MODEL || !process.env.OPENAI_API_KEY) { console.error('--embeddings needs EMBEDDING_MODEL and OPENAI_API_KEY (and OPENAI_BASE_URL for a non-OpenAI endpoint).'); process.exit(2); }
    Object.assign(config, { EMBEDDING_MODEL: process.env.EMBEDDING_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL && { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }) });
  }
  const raw = await readFile(file, 'utf8');
  const { ext, text } = fileText({ name: file, text: raw });
  const { tickets, skipped } = parseTickets(text, ext);
  console.log(`${tickets.length} solved tickets with a usable resolution; ${skipped.length} skipped.`);
  const { summary, csv } = await pilotReplay({ tickets, warmup: Number(arg('warmup', 20)), config, log: console.log, evaluateAfter: arg('evaluate-after'), label: arg('label', 'unlabelled') });
  const out = arg('out', 'evaluation/pilot-replay');
  await mkdir(dirname(out + '.json'), { recursive: true });
  await writeFile(out + '.json', JSON.stringify(summary, null, 2));
  await writeFile(out + '.csv', csv);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${out}.json and ${out}.csv (fill in human_match).`);
}
