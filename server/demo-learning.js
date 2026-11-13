// Isolated Interactive Learning Demo: User A -> specialist -> User A confirms ->
// the demo learns -> User B benefits.
//
// ISOLATION CONTRACT (enforced by test/demo-isolation.test.js):
//  * State lives in this module's in-memory Map, keyed by an unguessable per-demo
//    session id. There is no database, no company_id, no Hindsight, no connector,
//    no email/calendar and no network call here.
//  * Only pure scoring/privacy helpers are imported (no server/database.js,
//    providers.js, memory.js, passports.js, connector.js, integrations.js, app.js).
//  * The only starting suggestions are the hardcoded DEMO_PLAYBOOKS below. There
//    is no preloaded learned fix: the first one is written when User A explicitly
//    confirms a specialist proposal inside the same demo session.
//  * This is knowledge acquisition and retrieval, not model-weight training.
import { randomBytes, randomUUID } from 'node:crypto';
import { tokens } from './context.js';
import { customerFacts } from './applicability.js';
import {
  THRESHOLDS, localEmbedding, cosine, normBm25, bm25Raw, hybridScore, reliability, finalScore,
  compatibilityGate, rankCandidates, needsReviewFlag, passportCompleteness, diagnosticSimilarity,
  authorReliability, initialConfidence,
} from './scoring.js';
import { conditionsFromText } from './applicability.js';
import { scrubPII, containsSecret, dangerousInstructions } from './privacy.js';

export const DEMO_TTL_MS = 60 * 60 * 1000;
export const MAX_SESSIONS = 500;
const MAX_CASES = 20;
const MAX_LEARNED = 10;
const SESSION_ID = /^[A-Za-z0-9_-]{22,64}$/;

// Transparent, hardcoded starting suggestions. These are NOT learned memory.
export const DEMO_PLAYBOOKS = Object.freeze([
  Object.freeze({ id: 'demo-standard-restart', label: 'Initial standard suggestion', topics: ['display', 'flicker'], steps: 'Restart the laptop and check whether the flicker stops.' }),
  Object.freeze({ id: 'demo-standard-wifi', label: 'Initial standard suggestion', topics: ['network', 'offline'], steps: 'Turn Wi-Fi off and on once and reconnect to your network.' }),
]);
// A transparent script for judges. Typing a paraphrase works too.
export const SCRIPT = Object.freeze({
  userA: { description: 'My Demo Laptop X1 screen flickers right after startup. Restarting did not help.', device: 'Demo Laptop X1, firmware 4' },
  specialist: {
    title: 'Demo X1 screen flicker after startup',
    symptoms: 'Screen flickers right after startup',
    environment: 'Demo Laptop X1 firmware 4',
    steps: 'Fictional demo only: open Display Settings, change Refresh Mode from Adaptive to Fixed 60 Hz, then restart the laptop.',
    safety: 'None identified',
  },
  userB: { description: 'The monitor of my Demo Laptop X1 keeps blinking whenever it boots.', device: 'Demo Laptop X1 firmware 4' },
  userBIncompatible: { description: 'The monitor of my Demo Laptop Z9 keeps blinking whenever it boots.', device: 'Demo Laptop Z9 firmware 9' },
});

const sessions = new Map();
const now = () => Date.now();
const iso = (ms = now()) => new Date(ms).toISOString();
const fault = (status, message) => Object.assign(new Error(message), { status });
const text = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw fault(400, `Enter a valid ${name} (up to ${max} characters).`);
  return v.trim();
};
const optional = (v, name, max) => (v === undefined || v === '' ? '' : text(v, name, max));

function fresh(id) {
  return { id, createdAt: now(), lastSeen: now(), learned: [], cases: [], events: [], resets: 0 };
}
function event(state, kind, who, detail, extra = {}) {
  state.events.push({ id: state.events.length + 1, at: iso(), kind, who, detail, learnedCount: state.learned.length, ...extra });
}
// Only sessions that have genuinely expired are removed. An active session is never evicted to make room:
// when the demo is full, a new session is refused with a clear message instead.
function sweep() {
  const cutoff = now() - DEMO_TTL_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
}
const timer = setInterval(sweep, 5 * 60 * 1000);
timer.unref();

export function createSession() {
  sweep();
  if (sessions.size >= MAX_SESSIONS) throw fault(503, 'The demo is busy right now. Please try again in a few minutes.');
  const id = randomBytes(24).toString('base64url');
  const state = fresh(id);
  sessions.set(id, state);
  event(state, 'session_started', 'system', 'Empty demo session created. Learned memory: 0.');
  return id;
}
export function getSession(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw fault(400, 'Missing or invalid demo session.');
  sweep();
  const s = sessions.get(id);
  if (!s) throw fault(404, 'This demo session has expired or was reset. Start a new one.');
  s.lastSeen = now();
  return s;
}
export const sessionCount = () => sessions.size;
export function destroySession(id) {
  sessions.delete(id);
}

// ---------------------------------------------------------------------------
// Public (client-safe) projection. Never includes other sessions' data.
const learnedView = (l) => ({
  id: l.id, title: l.title, symptoms: l.symptoms, applicability: l.environment, safety: l.safety, steps: l.steps,
  origin: 'specialist_confirmed', provenance: `Learned from User ${l.originUser}’s confirmed specialist resolution`, verified: true,
  originUser: l.originUser, originCase: l.sourceCaseId, confirmationUser: l.confirmationUser, confirmationTime: l.confirmationTime, verificationStatus: l.verificationStatus,
  cInit: l.cInit, successes: l.successes, failures: l.failures, consecutiveFailures: l.consecutiveFailures,
  reliability: reliability(l.cInit.score, l.successes, l.failures), status: l.status, sourceCaseId: l.sourceCaseId, createdAt: l.createdAt,
});
export function view(state) {
  return {
    sessionId: state.id,
    expiresAt: iso(state.lastSeen + DEMO_TTL_MS),
    fictional: true,
    learnedCount: state.learned.length,
    learned: state.learned.map(learnedView),
    playbooks: DEMO_PLAYBOOKS.map(({ id, label, topics, steps }) => ({ id, label, topics, steps })),
    script: SCRIPT,
    cases: state.cases.map((c) => ({ ...c, attempts: c.attempts.map((a) => ({ ...a })) })),
    queue: state.cases.filter((c) => ['queued', 'proposal_sent'].includes(c.status)).map((c) => c.id),
    events: state.events,
    summary: summaryOf(state),
    notice: 'Fictional demonstration. Knowledge acquisition and retrieval only: no model is trained, and no real company data, memory service or connector is used.',
  };
}
function summaryOf(state) {
  const learned = state.learned[0];
  // A benefit is a real "It worked" on a learned suggestion by a user other than the one who taught it.
  const benefit = state.events.find((e) => e.kind === 'user_b_benefited' && e.beneficiary && e.beneficiary !== e.teacher);
  const teacher = learned?.originUser;
  const other = teacher === 'A' ? 'B' : 'A';
  return {
    userATaught: teacher === 'A',
    verifiedMemoryCreated: Boolean(learned),
    userBBenefited: Boolean(benefit),
    teacher: teacher || null,
    line: benefit
      ? `User ${benefit.teacher} taught Continuum → verified demo memory created → User ${benefit.beneficiary} benefited`
      : learned ? `User ${teacher} taught Continuum → verified demo memory created → waiting for User ${other}` : 'No learned memory yet. Learned memory: 0',
  };
}

// ---------------------------------------------------------------------------
// Retrieval over THIS session's learned fixes only.
export function suggest(state, { description, device, triedIds = [] }) {
  const query = `${description}\n${device || ''}`;
  const facts = customerFacts(query, { device: device || '' });
  const pool = state.learned.filter((l) => l.status === 'active' && !triedIds.includes(l.id));
  const docs = pool.map((l) => `${l.title} ${l.symptoms}`);
  const raw = pool.length ? bm25Raw(docs, query) : [];
  const best = Math.max(0, ...raw.filter(Boolean));
  const qv = localEmbedding(query);
  const qTokens = tokens(query);
  const scored = pool.map((l, i) => {
    const cos = cosine(qv, l.vector);
    const bm = normBm25({ raw: raw[i], rawBest: best, queryTokens: qTokens, docTokens: tokens(docs[i]) });
    const hybrid = hybridScore(cos, bm);
    const gate = compatibilityGate({ applicability: { environmentText: l.environment }, safety: l.safetyModel, facts, text: query, fields: { device: device || '' } });
    const w = reliability(l.cInit.score, l.successes, l.failures);
    const final = gate.eligible ? finalScore(hybrid, gate.compat, w) : 0;
    return {
      id: l.id, learned: l, eligible: gate.eligible, gate, hybrid, finalScore: final, signature: l.steps,
      breakdown: { cosine: cos === null ? null : Math.round(cos * 1e4) / 1e4, normBm25: bm, S_hybrid: hybrid, S_compat: gate.compat, W_reliability: w, S_final: final },
    };
  });
  const top = rankCandidates(scored, 1)[0] || null;
  const withheld = scored.filter((c) => c.gate.status === 'unknown' && finalScore(c.hybrid, 1, c.breakdown.W_reliability) >= THRESHOLDS.retrieval);
  return { top, withheld, scored };
}
function standardFor(description, triedIds) {
  const t = tokens(description);
  return DEMO_PLAYBOOKS.find((p) => !triedIds.includes(p.id) && p.topics.some((topic) => t.has(topic) || [...tokens(topic)].some((x) => t.has(x))));
}

function toQueue(state, c, reason) {
  c.status = 'queued';
  c.queuedAt = iso();
  event(state, 'queued_for_specialist', c.user === 'A' ? 'User A' : 'User B', reason, { caseId: c.id });
}
function offer(state, c) {
  const tried = c.attempts.map((a) => a.suggestionId);
  const query = { description: c.description, device: c.device, triedIds: tried };
  const { top, withheld } = suggest(state, query);
  if (top) {
    const l = top.learned;
    const attempt = {
      id: randomUUID(), source: 'learned', suggestionId: l.id, title: l.title, steps: l.steps, outcome: 'pending',
      label: l.originUser === c.user ? 'Learned from your earlier confirmed resolution' : `Learned from User ${l.originUser}’s confirmed specialist resolution`, verified: true, originUser: l.originUser,
      explanation: {
        why: `Matches “${l.symptoms}” (symptom similarity) and is compatible with ${l.environment}.`,
        constraintsMatched: top.gate.reasons, scores: top.breakdown, threshold: THRESHOLDS.retrieval,
        retrieval: 'in-memory hybrid: local concept embedding (cosine) + BM25, this demo session only',
      },
    };
    c.attempts.push(attempt);
    c.status = 'suggested';
    event(state, 'learned_suggestion_shown', 'Continuum', `Recommended the fix learned from User ${l.originUser} (S_final ${top.breakdown.S_final}).`, { caseId: c.id });
    return attempt;
  }
  if (withheld.length && !c.clarified) {
    c.status = 'needs_info';
    c.clarification = `Before suggesting a learned fix, please confirm your device and version (required: ${withheld[0].gate.reasons.join(', ')}).`;
    event(state, 'clarification_requested', 'Continuum', c.clarification, { caseId: c.id });
    return null;
  }
  const std = standardFor(`${c.description} ${c.device}`, tried);
  if (std) {
    const attempt = { id: randomUUID(), source: 'standard', suggestionId: std.id, title: std.label, steps: std.steps, outcome: 'pending', label: std.label, verified: false };
    c.attempts.push(attempt);
    c.status = 'suggested';
    event(state, 'standard_suggestion_shown', 'Continuum', 'Showed the hardcoded initial standard suggestion. Learned memory unchanged.', { caseId: c.id });
    return attempt;
  }
  toQueue(state, c, 'No applicable suggestion remains; routed to the demo specialist queue.');
  return null;
}

// ---------------------------------------------------------------------------
// Actions (each is a real state transition).
export function createIssue(state, { user, description, device }) {
  if (!['A', 'B'].includes(user)) throw fault(400, 'Choose User A or User B.');
  if (state.cases.length >= MAX_CASES) throw fault(409, 'This demo session is full. Reset to start again.');
  const clean = (t) => scrubPII(t).text;
  const c = {
    id: 'case-' + (state.cases.length + 1), user, description: clean(text(description, 'issue description', 500)), device: clean(optional(device, 'device and version', 200)),
    status: 'new', attempts: [], proposal: null, createdAt: iso(), clarified: false,
  };
  state.cases.push(c);
  event(state, 'issue_created', `User ${user}`, `${c.description}${c.device ? ' [' + c.device + ']' : ''}`, { caseId: c.id });
  const attempt = offer(state, c);
  return { case: c, attempt };
}
export function updateDevice(state, { caseId, device }) {
  const c = findCase(state, caseId);
  if (c.status !== 'needs_info') throw fault(409, 'This case is not waiting for device details.');
  c.device = scrubPII(text(device, 'device and version', 200)).text;
  c.clarified = true;
  c.status = 'new';
  event(state, 'device_provided', `User ${c.user}`, c.device, { caseId: c.id });
  return { case: c, attempt: offer(state, c) };
}
const findCase = (state, id) => {
  const c = state.cases.find((x) => x.id === id);
  if (!c) throw fault(404, 'Case not found in this demo session.');
  return c;
};
export function feedback(state, { caseId, worked, confirmed }) {
  if (confirmed !== true || typeof worked !== 'boolean') throw fault(400, 'Choose “It worked” or “Still need help”.');
  const c = findCase(state, caseId);
  const a = c.attempts.find((x) => x.outcome === 'pending');
  if (!a || c.status !== 'suggested') throw fault(409, 'There is no suggestion awaiting your answer.');
  const who = `User ${c.user}`;
  a.outcome = worked ? 'succeeded' : 'failed';
  a.at = iso();
  const l = a.source === 'learned' ? state.learned.find((x) => x.id === a.suggestionId) : null;
  if (worked) {
    c.status = 'resolved';
    if (l) {
      l.successes += 1;
      l.consecutiveFailures = 0;
      event(state, 'user_b_benefited', who, `“It worked”: the fix learned from User ${l.originUser} resolved User ${c.user}’s issue.`, { caseId: c.id, learnedId: l.id, teacher: l.originUser, beneficiary: c.user });
    } else event(state, 'standard_worked', who, '“It worked” on the initial standard suggestion.', { caseId: c.id });
    return { case: c, attempt: a };
  }
  if (l) {
    l.failures += 1;
    l.consecutiveFailures += 1;
    const flag = needsReviewFlag({ consecutiveFailures: l.consecutiveFailures, cInit: l.cInit.score, successes: l.successes, failures: l.failures });
    if (flag.flag) l.status = 'flagged_for_review';
  }
  event(state, 'still_need_help', who, `“Still need help” after the ${a.source === 'learned' ? 'learned' : 'initial standard'} suggestion.`, { caseId: c.id });
  // A failed learned fix is never repeated; the standard fallback is tried once if applicable.
  if (a.source === 'learned') {
    c.status = 'new';
    offer(state, c);
    if (c.status === 'new') toQueue(state, c, 'Learned fix did not help; routed to the demo specialist queue.');
  } else toQueue(state, c, 'The standard suggestion failed; the case moved to the demo-only specialist queue (not a real company queue).');
  return { case: c, attempt: a };
}

export function propose(state, input) {
  const c = findCase(state, input.caseId);
  if (c.status !== 'queued') throw fault(409, 'Only cases in the specialist queue can receive a proposal.');
  if (input.confirmed !== true || input.reviewedForPrivacy !== true) throw fault(400, 'Confirm the passport and review it for private information.');
  const draft = {
    title: text(input.title, 'title', 100), symptoms: text(input.symptoms, 'symptoms', 300), environment: text(input.environment, 'applicable environment', 200),
    steps: text(input.steps, 'solution steps', 600), safety: optional(input.safety, 'safety restrictions', 300),
  };
  if (containsSecret(Object.values(draft).join('\n'))) throw fault(400, 'Remove credentials and secrets.');
  const hazards = dangerousInstructions(draft.steps);
  if (hazards.length) throw fault(400, 'These steps include a risky instruction (' + hazards.join(', ') + ') and cannot be sent in the demo.');
  const clean = (t) => scrubPII(t, { names: [] });
  const scrubbed = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, clean(v).text]));
  const redactions = Object.values(draft).reduce((n, v) => n + clean(v).count, 0);
  const noneSafety = /^none(?: identified)?\.?$/i.test(scrubbed.safety) || !scrubbed.safety;
  const completeness = passportCompleteness({
    symptoms: scrubbed.symptoms, applicability: { environmentText: scrubbed.environment },
    safety: noneSafety ? { restrictions: [], noneIdentified: Boolean(scrubbed.safety), reviewed: input.safetyReviewed === true } : { restrictions: [{ text: scrubbed.safety }] },
    steps: [scrubbed.steps],
  });
  const conditions = conditionsFromText(scrubbed.environment);
  const diag = diagnosticSimilarity(conditions, customerFacts(`${c.description}\n${c.device}`, { device: c.device }));
  const author = authorReliability({ kind: 'staff' });
  const cInit = { ...initialConfidence({ passport: completeness.score, diag: diag.score, author: author.score }), parts: completeness.parts };
  if (input.preview === true) return { preview: true, passport: scrubbed, redactions, cInit };
  if (c.proposal && c.proposal.status === 'awaiting_customer') throw fault(409, 'A proposal is already awaiting the customer.');
  c.proposal = { ...scrubbed, redactions, cInit, status: 'awaiting_customer', sentAt: iso() };
  c.status = 'proposal_sent';
  event(state, 'specialist_proposed', 'Demo specialist', `Sent a Resolution Passport to User ${c.user} (C_init ${cInit.score}). Nothing is learned yet.`, { caseId: c.id });
  return { case: c, cInit };
}

export function confirm(state, { caseId, accepted, confirmed }) {
  if (confirmed !== true || typeof accepted !== 'boolean') throw fault(400, 'Choose “It worked” or “Still need help”.');
  const c = findCase(state, caseId);
  if (c.status !== 'proposal_sent' || c.proposal?.status !== 'awaiting_customer') throw fault(409, 'There is no specialist proposal awaiting confirmation.');
  if (!accepted) {
    c.proposal.status = 'rejected';
    c.status = 'queued';
    event(state, 'proposal_rejected', `User ${c.user}`, '“Still need help”: the proposal did not work, so nothing was learned.', { caseId: c.id });
    return { case: c, learned: null };
  }
  if (state.learned.length >= MAX_LEARNED) throw fault(409, 'The demo memory is full. Reset to start again.');
  const p = c.proposal;
  p.status = 'confirmed';
  c.status = 'resolved';
  const noneSafety = !p.safety || /^none(?: identified)?\.?$/i.test(p.safety);
  const l = {
    id: 'demo-memory-' + (state.learned.length + 1), title: p.title, symptoms: p.symptoms, environment: p.environment, steps: p.steps,
    safety: noneSafety ? 'None identified (reviewed)' : p.safety,
    safetyModel: noneSafety ? { restrictions: [] } : { restrictions: [{ text: p.safety, keywords: [...new Set(p.safety.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])].slice(0, 8) }] },
    cInit: p.cInit, successes: 0, failures: 0, consecutiveFailures: 0, status: 'active', sourceCaseId: c.id, createdAt: iso(),
    // Who actually taught this fix: the user whose own case received the specialist solution and confirmed it.
    originUser: c.user, confirmationUser: c.user, confirmationTime: iso(), verificationStatus: 'customer_confirmed',
    vector: localEmbedding(`${p.title}\n${p.symptoms}`),
  };
  state.learned.push(l);
  event(state, 'user_a_confirmed', `User ${c.user}`, '“It worked”: confirmed the specialist solution.', { caseId: c.id });
  event(state, 'memory_learned', 'Continuum', `Verified demo memory created from User ${c.user}’s confirmed resolution. Learned memory: ${state.learned.length}.`, { caseId: c.id, learnedId: l.id });
  return { case: c, learned: learnedView(l) };
}

export function reset(state) {
  const keep = state.id;
  Object.assign(state, fresh(keep), { resets: state.resets + 1 });
  event(state, 'reset', 'system', 'All demo cases, feedback and learned memory were cleared. Learned memory: 0.');
  return state;
}

/** Drive the whole scripted scenario through the same public actions (used by the smoke script and tests). */
export function runGuided(state, { compatibleB = true } = {}) {
  const a = createIssue(state, { user: 'A', ...SCRIPT.userA });
  feedback(state, { caseId: a.case.id, worked: false, confirmed: true });
  propose(state, { caseId: a.case.id, ...SCRIPT.specialist, reviewedForPrivacy: true, safetyReviewed: true, confirmed: true });
  confirm(state, { caseId: a.case.id, accepted: true, confirmed: true });
  const b = createIssue(state, { user: 'B', ...(compatibleB ? SCRIPT.userB : SCRIPT.userBIncompatible) });
  if (b.attempt?.source === 'learned') feedback(state, { caseId: b.case.id, worked: true, confirmed: true });
  return { a: a.case, b: b.case, state };
}

// ---------------------------------------------------------------------------
// HTTP layer. Self-contained: tiny JSON reader, header-based session id.
async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fault(415, 'Send a JSON request.');
  const chunks = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 8192) throw fault(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw fault(400, 'The request body must be a JSON object.');
  }
}
let creationWindow = { start: 0, count: 0 };
export const isDemoPath = (pathname) => pathname === '/api/demo' || pathname.startsWith('/api/demo/');

/** Returns true when the request belonged to the demo namespace. */
export async function handleDemo(req, url, write) {
  if (!isDemoPath(url.pathname)) return false;
  const route = `${req.method} ${url.pathname}`;
  if (route === 'POST /api/demo/session') {
    if (now() - creationWindow.start > 60000) creationWindow = { start: now(), count: 0 };
    if (++creationWindow.count > 120) throw fault(429, 'Too many demo sessions. Try again in a minute.');
    const id = createSession();
    write(201, view(getSession(id)));
    return true;
  }
  const state = getSession(req.headers['x-demo-session']);
  if (route === 'GET /api/demo/state') return write(200, view(state)), true;
  if (route === 'POST /api/demo/reset') return write(200, view(reset(state))), true;
  if (route === 'DELETE /api/demo/session') return destroySession(state.id), write(200, { success: true }), true;
  const actions = {
    'POST /api/demo/customer/issue': createIssue,
    'POST /api/demo/customer/device': updateDevice,
    'POST /api/demo/customer/feedback': feedback,
    'POST /api/demo/customer/confirm': confirm,
    'POST /api/demo/specialist/propose': propose,
  };
  const action = actions[route];
  if (!action) throw fault(404, 'Demo route not found.');
  const result = action(state, await readJson(req));
  write(200, { ...(result?.preview ? result : { success: true }), state: view(state) });
  return true;
}
