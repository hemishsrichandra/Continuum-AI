import { createHandler } from '../server/app.js';
import { invoke } from './invoke.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.loadEnvFile('.env');
for (const key of ['HINDSIGHT_BASE_URL', 'HINDSIGHT_API_KEY', 'OPENAI_API_KEY'])
  if (!process.env[key]) throw new Error('Missing ' + key + ' in .env');
const run = randomUUID().slice(0, 8),
  directory = await mkdtemp(join(tmpdir(), 'continuum-live-'));
const config = {
  ...process.env,
  APP_URL: 'http://localhost:3100',
  NODE_ENV: 'development',
  ENABLE_DEMO_MODE: 'false',
  REQUIRE_EMAIL_VERIFICATION: 'false',
  REQUIRE_LIVE_INTEGRATIONS: 'true',
  ENABLE_OUTBOX_WORKER: 'false',
  RESEND_API_KEY: '',
  EMAIL_FROM: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  HINDSIGHT_BANK_PREFIX: (process.env.HINDSIGHT_BANK_PREFIX || 'continuum') + '-verify-' + run,
};
const handler = createHandler({ file: join(directory, 'verification.sqlite'), config });
const report = { run, syntheticData: true, checks: [], startedAt: new Date().toISOString() };
const password = randomUUID() + randomUUID();
function client() {
  let cookie = '',
    csrf = '';
  return {
    async api(route, body) {
      const r = await invoke(handler, route, { body, headers: { cookie, 'x-csrf-token': csrf } });
      if (r.headers?.['Set-Cookie']) cookie = r.headers['Set-Cookie'].split(';')[0];
      if (r.data.csrfToken) csrf = r.data.csrfToken;
      if (r.status >= 400) throw new Error(route + ': ' + r.status + ' ' + r.data.error);
      return r.data;
    },
  };
}
function check(name, passed, details = {}) {
  report.checks.push({ name, passed, ...details });
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
}
const owner = client(),
  a = client(),
  b = client(),
  other = client();
const question =
  'The display flickers after startup on a Model X laptop with display firmware 4. How can I fix it?';
const solution =
  'Disable Adaptive Refresh in Display Settings, then install verified display driver 4.2. Restart once after driver installation and confirm the flicker stops.';
try {
  const account = await owner.api('auth/register', {
    createCompany: true,
    companyName: 'Synthetic evaluation company',
    name: 'Synthetic specialist',
    email: 'owner-' + run + '@example.test',
    password,
    provider: 'repair',
  });
  const { code } = await owner.api('company/customer-code', { confirmed: true });
  for (const [c, name] of [
    [a, 'a'],
    [b, 'b'],
  ])
    await c.api('auth/register', {
      companyCode: code,
      name: 'Synthetic ' + name,
      email: name + '-' + run + '@example.test',
      password,
      provider: 'repair',
    });
  const ticketA = (
    await a.api('request', { title: 'Model X display', issueDesc: question, confirmed: true, memory: false })
  ).ticketId;
  const ticketB = (
    await b.api('request', {
      title: 'Model X laptop',
      issueDesc: 'Display flickers after startup. Model X firmware 4.',
      confirmed: true,
      memory: false,
    })
  ).ticketId;
  const ask = (message = question, extra = {}) => b.api('chat', { ticketId: ticketB, message, ...extra });
  const baseline = await ask(undefined,{retain:false});
  check('No learned fix before specialist work', baseline.trace.learnedResolutions === 0, {
    response: baseline,
  });
  const handoff = await a.api('handoff', {
    ticketId: ticketA,
    summary: question,
    confirmed: true,
    memory: false,
  });
  await owner.api('operator/assign', {
    handoffId: handoff.id,
    assignedTo: account.profile.id,
    revision: 0,
    confirmed: true,
  });
  const resolution = await owner.api('operator/resolve', {
    handoffId: handoff.id,
    revision: 1,
    title: 'Model X display flicker after startup',
    symptoms: 'Display flickers after startup',
    environment: 'Model X firmware 4',
    solution,
    confirmed: true,
    reviewedForPrivacy: true,
  });
  check('Unconfirmed solution is not reused', (await ask(undefined,{retain:false})).trace.learnedResolutions === 0);
  const confirmation = await a.api('resolutions/confirm', {
    id: resolution.id,
    accepted: true,
    confirmed: true,
  });
  check('Confirmed resolution retained in Hindsight', confirmation.sync === 'synced');
  const questions = [
    'The monitor flashes when booting the notebook. What can I do?',
    'My screen keeps blinking as the laptop starts up. Is there a known fix?',
    'At power-on the panel flickers. How should I troubleshoot it?',
    'The laptop starts normally but its screen flashes repeatedly. Can you help?',
    'I see a blinking monitor immediately after boot. What resolved this previously?',
  ];
  for (const message of questions) {
    const r = await ask(message);
    check(
      'Held-out paraphrase: ' + message,
      r.trace.knowledge === 'Hindsight' && r.trace.learnedResolutions === 1 && r.reply.includes(solution),
      { response: r },
    );
  }
  for (const message of [
    'The display flickers after startup on Model Z firmware 9.',
    'How do I change my invoice address?',
    'Please email me about my appointment.',
  ]) {
    const r = await ask(message);
    check(
      'Exclude unrelated or incompatible: ' + message,
      r.trace.learnedResolutions === 0 && !r.reply.includes(solution),
      { response: r },
    );
  }
  const off = await ask(questions[0], { memory: false });
  check(
    'Memory OFF excludes learned fix',
    off.trace.learnedResolutions === 0 && !off.reply.includes(solution),
    { response: off },
  );
  await other.api('auth/register', {
    createCompany: true,
    companyName: 'Isolated evaluation company',
    name: 'Other owner',
    email: 'other-' + run + '@example.test',
    password,
    provider: 'repair',
  });
  const otherCode = (await other.api('company/customer-code',{confirmed:true})).code;
  const otherCustomer = client();
  await otherCustomer.api('auth/register',{companyCode:otherCode,name:'Other customer',email:'other-customer-'+run+'@example.test',password,provider:'repair'});
  const otherTicket = (
    await otherCustomer.api('request', {
      title: 'Model X display',
      issueDesc: question,
      confirmed: true,
      memory: false,
    })
  ).ticketId;
  const isolated = await otherCustomer.api('chat', { ticketId: otherTicket, message: question });
  check(
    'Other company cannot retrieve resolution',
    isolated.trace.learnedResolutions === 0 && !isolated.reply.includes(solution),
  );
  await owner.api('operator/retire', { id: resolution.id, confirmed: true });
  const retired = await ask(questions[0]);
  check(
    'Retirement excludes fix in existing conversation',
    retired.trace.learnedResolutions === 0 && !retired.reply.includes(solution),
    { response: retired },
  );
  report.passed = report.checks.every((c) => c.passed);
  report.completedAt = new Date().toISOString();
  if (!report.passed) process.exitCode = 1;
} catch (e) {
  report.error = e.message;
  report.passed = false;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  await mkdir('data', { recursive: true });
  await writeFile('data/live-verification-' + run + '.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  handler.close();
  await rm(directory, { recursive: true, force: true });
  console.log('Report: data/live-verification-' + run + '.json');
}
