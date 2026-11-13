import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

// Reads completed reports only. Does not contact external services or change app data.
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/summarize-evaluation.js data/evaluation-LOCAL.json [data/evaluation-LIVE.json]');
const reports = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))));
if (new Set(reports.map((r) => r.datasetSha256)).size !== 1 || !reports[0].datasetSha256)
  throw new Error('Reports must have the same recorded dataset hash.');
const esc = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
const rate = (n, d) => `${n}/${d}${d ? ` (${(n / d * 100).toFixed(1)}%)` : ''}`;
const median = (a) => {
  const sorted = a.toSorted((x, y) => x - y), n = sorted.length;
  return n ? Math.round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2) : 'not measured';
};
const lines = [
  '# Synthetic challenge evaluation results', '',
  'These are recorded API-harness results, not a browser rehearsal, human usability study or production accuracy benchmark. The questions were authored before the challenge run and were not added to the reviewed resolution sources or matching rules.', '',
  `Dataset: ${reports[0].dataset}. SHA-256: \`${reports[0].datasetSha256}\`.`, '',
  '| Measure | ' + reports.map((r) => esc(r.mode)).join(' | ') + ' |',
  '|---|' + reports.map(() => '---|').join(''),
];
const row = (label, value) => lines.push(`| ${label} | ${reports.map(value).join(' | ')} |`);
row('Run / completed at', (r) => `${r.run} / ${r.completedAt}`);
row('Completed domains', (r) => rate(r.cases.length, r.plannedCases));
row('Positive questions evaluated', (r) => rate(r.counts.positiveQuestions, r.plannedPositiveQuestions));
row('Correct source-backed fix with memory ON', (r) => rate(r.counts.correctMemoryOn, r.counts.positiveQuestions));
row('Fix withheld with memory OFF', (r) => rate(r.counts.memoryOffWithheld, r.counts.positiveQuestions));
row('Negative questions with no inappropriate recommendation', (r) => rate(r.counts.negativeQuestions-r.counts.incorrectRecommendations, r.counts.negativeQuestions));
row('Recovery scenarios fully verified', (r) => rate(r.cases.filter((c) => c.failedRecovery).length, r.plannedCases));
row('Median ON request latency, milliseconds', (r) => median(r.cases.flatMap((c) => c.positive.map((p) => p.on.elapsedMs))));
row('Median OFF request latency, milliseconds', (r) => median(r.cases.flatMap((c) => c.positive.map((p) => p.off.elapsedMs))));
row('Overall harness result', (r) => r.passed ? 'PASS' : 'NOT PASS');
lines.push('', 'Each domain adds three negative controls: conflicting environment, missing environment and unrelated billing. These repeated control types do not represent 30 independently sampled real-world hazards. A recommendation is correct only if its source ID and exact reviewed steps match; live runs also require Hindsight attribution. Latencies include service time and bounded retries; they do not measure customer time savings.', '',
  'Recovery requires a saved initial recommendation. If that recommendation was missed, the recovery scenario cannot be verified. Do not interpret a zero repeated-fix counter as success for an unexercised recovery path.', '');
for (let i = 0; i < reports.length; i++) {
  const r = reports[i];
  lines.push(`## ${r.mode}`, '', `Full synthetic evidence: [${basename(files[i])}](evaluation-results/${basename(files[i])}).`, '',
    '| Domain | Correct ON | Safe OFF | Negative controls | Recovery verified |', '|---|---:|---:|---:|---|');
  for (const c of r.cases) lines.push(`| ${c.id} | ${rate(c.positive.filter((p) => p.correct).length,c.positive.length)} | ${rate(c.positive.filter((p) => p.offWithheld).length,c.positive.length)} | ${rate(c.negative.filter((n) => n.safe).length,c.negative.length)} | ${c.failedRecovery ? 'Yes' : 'No'} |`);
  if (r.error) lines.push('', '**Run interrupted:** ' + esc(r.error));
  const misses = r.cases.flatMap((c) => c.positive.filter((p) => !p.correct || !p.offWithheld).map((p) => ({ domain: c.id, ...p })));
  if (misses.length) {
    lines.push('', '### Missed or failed positive checks', '', '| Domain | Question | ON decision | OFF withheld |', '|---|---|---|---|');
    for (const p of misses) lines.push(`| ${p.domain} | ${esc(p.question)} | ${esc(p.on.decision)} | ${p.offWithheld ? 'Yes' : 'No'} |`);
  }
  lines.push('');
}
lines.push('## Limits and next evidence', '',
  '- Synthetic reviewed steps establish workflow behavior, not that the advice repairs real equipment.',
  '- The dataset is now observed. Keep it as a regression set; obtain independent customer wording for the next blind evaluation.',
  '- Same-language, ten-domain sample only. Other languages, complex multi-issue tickets and adversarial prompts need separate evaluation.',
  '- This challenge does not replace the existing publication, retirement, company-isolation and HTTP regression checks.',
  '- No real participants, customer-time savings, business deployment or screen recording are claimed. Use docs/USER-PILOT.md and docs/JUDGE-DEMO.md for those next steps.',
  '- Live runs use separate temporary databases and Hindsight namespaces. Synthetic cloud memories may remain in the recorded namespace; existing workspace records are not used.', '');
await mkdir('output/evaluation-results', { recursive: true });
for (let i = 0; i < files.length; i++) await writeFile('output/evaluation-results/' + basename(files[i]), JSON.stringify(reports[i], null, 2));
await writeFile('output/CHALLENGE-RESULTS.md', lines.join('\n'));
console.log('Wrote output/CHALLENGE-RESULTS.md and synthetic JSON evidence.');
