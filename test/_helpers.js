// Shared fixtures for the Resolution Passport / follow-through test suites.
import { createHandler } from '../server/app.js';
import { invoke } from '../scripts/invoke.js';
import { computeInitialConfidence } from '../server/passports.js';
import { customerFacts } from '../server/applicability.js';

export const password = 'a fictional test passphrase 2026';
export function client(getHandler) {
  let cookie = '', csrf = '';
  return {
    async api(route, body, headers = {}) {
      const r = await invoke(getHandler(), route, { body, headers: { cookie, 'x-csrf-token': csrf, ...headers } });
      if (r.headers?.['Set-Cookie']) cookie = r.headers['Set-Cookie'].split(';')[0];
      if (r.data?.csrfToken) csrf = r.data.csrfToken;
      return r;
    },
    get headers() { return { cookie, 'x-csrf-token': csrf }; },
  };
}
export async function world(t, { config = {}, file } = {}) {
  let h = createHandler({ file, config });
  t.after(() => h.close());
  const get = () => h;
  const owner = client(get), other = client(get);
  const reg = await owner.api('auth/register', { name: 'Owner', email: 'owner@example.test', password, createCompany: true, companyName: 'Company A', provider: 'repair' });
  if (reg.status !== 201) throw new Error('register failed ' + JSON.stringify(reg.data));
  const company = reg.data.profile.companyId;
  const code = (await owner.api('company/customer-code', { confirmed: true })).data.code;
  const regB = await other.api('auth/register', { name: 'Owner B', email: 'ownerb@example.test', password, createCompany: true, companyName: 'Company B', provider: 'repair' });
  const companyB = regB.data.profile.companyId;
  const codeB = (await other.api('company/customer-code', { confirmed: true })).data.code;
  async function customer(name, companyCode = code) {
    const c = client(get);
    const r = await c.api('auth/register', { name, email: name + '@example.test', password, companyCode, provider: 'repair' });
    if (r.status !== 201) throw new Error('customer register failed ' + JSON.stringify(r.data));
    c.id = r.data.profile.id;
    return c;
  }
  async function ticket(c, issue, title = 'Model X device') {
    const r = await c.api('request', { title, issueDesc: issue, confirmed: true });
    if (r.status !== 201) throw new Error('ticket failed ' + JSON.stringify(r.data));
    return r.data.ticketId;
  }
  const ask = (c, id, message, extra = {}) => c.api('chat', { ticketId: id, message, ...extra });
  const botOf = (companyId, adapter = 'repair') => companyId + ':' + adapter;
  /** Insert a passport directly (bypasses the specialist UI; used to build corpora quickly). */
  function seed(companyId, p = {}) {
    const passport = {
      title: p.title, symptoms: p.symptoms,
      applicability: { environmentText: p.environment ?? 'Model X firmware 4' },
      safety: p.safety ?? { restrictions: [], noneIdentified: true, reviewed: true },
      steps: Array.isArray(p.steps) ? p.steps : [p.steps],
    };
    const c = computeInitialConfidence(passport, { facts: customerFacts(p.environment ?? 'Model X firmware 4'), author: { kind: p.author ?? 'staff' } });
    return get().memoryPool.insert({
      companyId, chatbotId: p.chatbotId ?? botOf(companyId), origin: p.origin ?? 'specialist_confirmed',
      sourceKey: p.sourceKey ?? 'test:' + p.title, ...passport,
      initialConfidence: p.cInit ?? c.score, customerConfirmed: (p.origin ?? 'specialist_confirmed') === 'specialist_confirmed',
      successes: p.successes ?? 0, failures: p.failures ?? 0,
    });
  }
  const db = () => get().store.db;
  return { get h() { return h; }, restart() { h.close(); h = createHandler({ file, config }); }, owner, other, company, companyB, code, codeB, customer, ticket, ask, seed, botOf, db };
}
export const ISSUE = 'The display flickers after startup on Model X firmware 4.';
export const FOUR = [
  ['Display flicker: adaptive refresh', 'Display flickers after startup', 'Disable adaptive refresh in Display settings and restart the laptop.'],
  ['Display flicker: driver update', 'Display flickers after startup and flashes', 'Install the approved display driver 4.2 from the vendor support site.'],
  ['Display flicker: power profile', 'Screen flickers after startup when on battery', 'Switch the power profile to Balanced in Power settings and test again.'],
  ['Display flicker: external monitor test', 'Display flicker on startup, flashing screen', 'Connect an external monitor to check whether the flicker also appears there.'],
];
export const fixed = (c) => c.data.attempt?.fix_id;
