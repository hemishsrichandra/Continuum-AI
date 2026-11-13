import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHandler } from '../server/app.js';
import { invoke } from './invoke.js';
import { cases } from '../evaluation/cases.js';
import { challengeCases } from '../evaluation/challenge.js';
import { holdoutCases } from '../evaluation/holdout.js';
import { validationCases } from '../evaluation/validation.js';
import { informalCases } from '../evaluation/informal.js';
import { informal2Cases } from '../evaluation/informal2.js';

/**
 * Validate a dataset of your own: `[{ id, title, symptoms, environment, solution, queries: [..] }]`
 * (or `{ cases: [...] }`). `symptoms`/`solution` describe the reviewed fix to store; `queries` are real
 * customer wordings that should retrieve it.
 */
export function validateDataset(input) {
  const list = Array.isArray(input) ? input : input?.cases;
  if (!Array.isArray(list) || !list.length || list.length > 100) throw new Error('A dataset must contain 1 to 100 cases.');
  const text = (v, name, i, max, optional = false) => {
    if (optional && (v === undefined || v === '')) return '';
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`Case ${i + 1}: “${name}” must be a non-empty string of at most ${max} characters.`);
    return v.trim();
  };
  const ids = new Set();
  return list.map((c, i) => {
    const id = text(c?.id, 'id', i, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`Case ${i + 1}: “id” must be unique and use only letters, digits, “-” and “_”.`);
    ids.add(id);
    if (!Array.isArray(c.queries) || !c.queries.length || c.queries.length > 20) throw new Error(`Case ${i + 1}: “queries” must list 1 to 20 customer wordings.`);
    return { id, title: text(c.title, 'title', i, 100), symptoms: text(c.symptoms, 'symptoms', i, 1000), environment: text(c.environment, 'environment', i, 500, true), solution: text(c.solution, 'solution', i, 2000), queries: c.queries.map((q) => text(q, 'queries[]', i, 1000)) };
  });
}
export async function evaluate({ live = false, challenge = false, holdout = false, validation = false, informal = false, informal2 = false, dataset: custom = null, embeddings = false, embeddingEnv = process.env, redact = Boolean(custom), log = () => {} } = {}) {
  const dataset = custom ? validateDataset(custom) : informal2 ? informal2Cases : informal ? informalCases : validation ? validationCases : holdout ? holdoutCases : challenge ? challengeCases : cases;
  if (live) process.loadEnvFile('.env');
  const run = randomUUID().slice(0, 8),
    directory = await mkdtemp(join(tmpdir(), 'continuum-evaluation-'));
  const config = {
    ...(live ? process.env : {}),
    APP_URL: 'http://localhost:3100',
    NODE_ENV: 'test',
    // The harness measures what retrieval would put first, so it reads the recorded first suggestion. Product behaviour is explicit choice.
    SUGGESTION_MODE: 'auto_first',
    ENABLE_OUTBOX_WORKER: 'false',
    REQUIRE_EMAIL_VERIFICATION: 'false',
    ENABLE_DEMO_MODE: 'false',
    RESEND_API_KEY: '',
    EMAIL_FROM: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    PROVIDER_ALLOWED_ORIGINS: '',
    HINDSIGHT_BANK_PREFIX: (process.env.HINDSIGHT_BANK_PREFIX || 'continuum') + '-evaluation-' + run,
    REQUIRE_LIVE_INTEGRATIONS: live ? 'true' : 'false',
  };
  if (embeddings) {
    // Use a real embedding model for retrieval (no Hindsight needed). Fails loudly instead of silently using the local fallback.
    if (!embeddingEnv.EMBEDDING_MODEL || !embeddingEnv.EMBEDDING_API_KEY) throw new Error('Embedding evaluation requires EMBEDDING_MODEL and EMBEDDING_API_KEY (and optionally EMBEDDING_BASE_URL).');
    Object.assign(config, { EMBEDDING_MODEL: embeddingEnv.EMBEDDING_MODEL, EMBEDDING_API_KEY: embeddingEnv.EMBEDDING_API_KEY, ...(embeddingEnv.EMBEDDING_BASE_URL && { EMBEDDING_BASE_URL: embeddingEnv.EMBEDDING_BASE_URL }) });
  }
  if (live && (!config.HINDSIGHT_BASE_URL || !config.HINDSIGHT_API_KEY || !config.OPENAI_API_KEY))
    throw new Error('Live evaluation requires Hindsight and model credentials in .env.');
  const h = createHandler({ file: join(directory, 'evaluation.sqlite'), config });
  const report = {
    run,
    startedAt: new Date().toISOString(),
    dataset: custom ? 'custom (your data)' : informal2 ? 'synthetic informal v2' : informal ? 'synthetic informal v1' : validation ? 'synthetic validation v1' : holdout ? 'synthetic held-out v1' : challenge ? 'synthetic challenge v1' : 'synthetic regression v1',
    datasetSha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    plannedCases: dataset.length,
    plannedPositiveQuestions: dataset.reduce((n, c) => n + c.queries.length, 0),
    namespace: config.HINDSIGHT_BANK_PREFIX,
    mode: live ? 'live Hindsight/model' : 'local deterministic regression',
    synthetic: !custom,
    embeddingModel: embeddings ? config.EMBEDDING_MODEL : 'local-hashed-concepts (offline)',
    cases: [],
    counts: {
      positiveQuestions: 0,
      correctMemoryOn: 0,
      correctMemoryOff: 0,
      memoryOffWithheld: 0,
      negativeQuestions: 0,
      incorrectRecommendations: 0,
      failedFixRepeated: 0,
    },
    passed: false,
  };
  const password = randomUUID() + randomUUID();
  function client() {
    let cookie = '',
      csrf = '';
    return {
      async api(route, body) {
        for (let attempt = 0; ; attempt++) {
          const r = await invoke(h, route, { body, headers: { cookie, 'x-csrf-token': csrf } });
          if (r.headers?.['Set-Cookie']) cookie = r.headers['Set-Cookie'].split(';')[0];
          if (r.data.csrfToken) csrf = r.data.csrfToken;
          if (live && [429, 503].includes(r.status) && attempt < 3) {
            await delay(Math.min(60000, Math.max(5000, (r.data.retryAfter || 10) * 1000)));
            continue;
          }
          if (r.status >= 400) throw new Error(route + ': ' + r.status + ' ' + r.data.error);
          return r.data;
        }
      },
    };
  }
  const owner = client(),
    a = client(),
    b = client();
  try {
    const o = await owner.api('auth/register', {
      createCompany: true,
      companyName: 'Evaluation company',
      name: 'Evaluation specialist',
      email: 'owner-' + run + '@example.test',
      password,
      provider: 'repair',
    });
    const bots=await owner.api('company/chatbots');
    await owner.api('company/chatbots',{...bots.chatbots.find(b=>b.adapter==='repair'),playbooks:[]});
    const { code } = await owner.api('company/customer-code', { confirmed: true });
    for (const [client, name] of [
      [a, 'a'],
      [b, 'b'],
    ])
      await client.api('auth/register', {
        companyCode: code,
        name,
        email: name + '-' + run + '@example.test',
        password,
        provider: 'repair',
      });
    for (const c of dataset) {
      // Offline fixtures bypass rate windows only inside this isolated test harness.
      if (!live) h.store.db.prepare('DELETE FROM rate_limits').run();
      const issue = c.symptoms + '. ' + c.environment;
      const ta = (
        await a.api('request', { title: c.title, issueDesc: issue, confirmed: true, memory: false })
      ).ticketId;
      const tb = (
        await b.api('request', { title: c.title, issueDesc: issue, confirmed: true, memory: false })
      ).ticketId;
      const handoff = await a.api('handoff', {
        ticketId: ta,
        summary: issue,
        confirmed: true,
        memory: false,
      });
      await owner.api('operator/assign', {
        handoffId: handoff.id,
        assignedTo: o.profile.id,
        revision: 0,
        confirmed: true,
      });
      const r = await owner.api('operator/resolve', {
        handoffId: handoff.id,
        revision: 1,
        title: c.title,
        symptoms: c.symptoms,
        environment: c.environment,
        solution: c.solution,
        reviewedForPrivacy: true,
        confirmed: true,
      });
      await a.api('resolutions/confirm', { id: r.id, accepted: true, confirmed: true });
      const result = { id: c.id, positive: [], negative: [], failedRecovery: false };
      let use;
      for (let index = 0; index < c.queries.length; index++) {
        const message = c.queries[index];
        const onStart = performance.now();
        const on = await b.api('chat', { ticketId: tb, message, retain: index === 0 });
        const onMs = Math.round(performance.now() - onStart);
        const offStart = performance.now();
        const off = await b.api('chat', { ticketId: tb, message, memory: false, retain: false });
        const offMs = Math.round(performance.now() - offStart);
        use ||= on.resolutionUse;
        const correct =
          on.decision.mode === 'recommend' &&
          on.evidence.some((e) => e.resolutionId === r.id) &&
          on.reply.includes(c.solution) &&
          (!live || on.trace.knowledge === 'Hindsight');
        const offWithheld = off.trace.learnedResolutions === 0 &&
          off.decision.mode !== 'recommend' && !off.reply.includes(c.solution);
        report.counts.positiveQuestions++;
        report.counts.correctMemoryOn += Number(correct);
        report.counts.correctMemoryOff += Number(off.reply.includes(c.solution));
        report.counts.memoryOffWithheld += Number(offWithheld);
        // With your own data the report omits the raw customer wording and replies (they may be personal).
        result.positive.push({
          question: redact ? `query ${index + 1}` : message,
          correct,
          offWithheld,
          on: { reply: redact ? '(omitted)' : on.reply, decision: on.decision.mode, memory: on.trace.knowledge, elapsedMs: onMs },
          off: { reply: redact ? '(omitted)' : off.reply, decision: off.decision.mode, elapsedMs: offMs },
        });
      }
      const missing = (
        await b.api('request', {
          title: 'Service issue',
          issueDesc: c.symptoms,
          confirmed: true,
          memory: false,
        })
      ).ticketId;
      for (const [ticketId, message] of [
        [tb, c.queries[0] + ' Model WRONG firmware 99 Windows 99.'],
        [missing, c.queries[0]],
        [tb, 'How do I update my invoice address?'],
      ]) {
        const answer = await b.api('chat', { ticketId, message, retain: false });
        const safe = answer.trace.learnedResolutions === 0 && !answer.reply.includes(c.solution);
        report.counts.negativeQuestions++;
        report.counts.incorrectRecommendations += Number(!safe);
        result.negative.push({ question: redact ? '(omitted)' : message, safe, decision: answer.decision.mode, reply: redact ? '(omitted)' : answer.reply });
      }
      if (use) {
        await b.api('resolutions/outcome', { useId: use.id, worked: false, confirmed: true });
        const again = await b.api('chat', { ticketId: tb, message: c.queries[0], retain: false });
        result.failedRecovery =
          again.trace.learnedResolutions === 0 &&
          // A failed fix is never repeated; with no further eligible suggestion the
          // case reaches a specialist (new case, or an already-open one).
          (['human', 'handoff_prepared'].includes(again.workflow?.stage) || (again.decision.mode === 'waiting' && Boolean(again.decision.handoffId))) &&
          !again.reply.includes(c.solution);
        report.counts.failedFixRepeated += Number(!result.failedRecovery);
      }
      result.passed =
        result.positive.every((p) => p.correct && p.offWithheld) &&
        result.negative.every((n) => n.safe) &&
        result.failedRecovery;
      report.cases.push(result);
      log((result.passed ? 'PASS ' : 'FAIL ') + c.id);
    }
    report.passed = report.cases.length === dataset.length && report.cases.every((c) => c.passed);
  } catch (e) {
    report.error = e.message;
    log('ERROR ' + e.message);
  } finally {
    report.completedAt = new Date().toISOString();
    h.close();
    await rm(directory, { recursive: true, force: true });
  }
  return report;
}

if (/[\\/]evaluate\.js$/.test(process.argv[1] || '')) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const file = arg('--file');
  const report = await evaluate({
    live: process.argv.includes('--live'), challenge: process.argv.includes('--challenge'), holdout: process.argv.includes('--holdout'),
    validation: process.argv.includes('--validation'), informal: process.argv.includes('--informal'), informal2: process.argv.includes('--informal2'),
    embeddings: process.argv.includes('--embeddings'),
    ...(file && { dataset: JSON.parse(await readFile(file, 'utf8')) }),
    log: console.log,
  });
  await mkdir('data', { recursive: true });
  const out = 'data/evaluation-' + report.run + '.json';
  await writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report.counts));
  console.log('Report: ' + out);
  if (!report.passed) process.exitCode = 1;
}
