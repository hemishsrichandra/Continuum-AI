import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS, initialConfidence, passportCompleteness, authorReliability, diagnosticSimilarity,
  hybridScore, reliability, finalScore, needsReviewFlag, rankCandidates, normBm25, cosine, normCosine,
  localEmbedding, compatibilityGate, clamp01,
} from '../server/scoring.js';
import { conditionsFromText, customerFacts } from '../server/applicability.js';
import { scrubPII, containsSecret, dangerousInstructions } from '../server/privacy.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('C_init = 0.40*P_passport + 0.35*S_diag + 0.25*R_author, clamped', () => {
  assert.equal(initialConfidence({ passport: 1, diag: 1, author: 1 }).score, 1);
  assert.equal(initialConfidence({ passport: 0, diag: 0, author: 0 }).score, 0);
  close(initialConfidence({ passport: 1, diag: 0, author: 0 }).score, 0.4);
  close(initialConfidence({ passport: 0, diag: 1, author: 0 }).score, 0.35);
  close(initialConfidence({ passport: 0, diag: 0, author: 1 }).score, 0.25);
  close(initialConfidence({ passport: 1, diag: 1, author: 0.75 }).score, 0.9375);
  // Out-of-range / non-numeric components are clamped, never propagated.
  assert.equal(initialConfidence({ passport: 5, diag: -3, author: NaN }).score, 0.4);
  assert.deepEqual(initialConfidence({ passport: 0.5, diag: 0.5, author: 0.5 }).components, { P_passport: 0.5, S_diag: 0.5, R_author: 0.5 });
});

test('P_passport awards 0.25 per adequately filled section; blank is not evidence', () => {
  const full = {
    symptoms: 'Display flickers after startup',
    applicability: { environmentText: 'Model X firmware 4' },
    safety: { restrictions: [{ text: 'Do not use if battery is swollen' }] },
    steps: ['Open Display settings and select the Standard profile, then restart.'],
  };
  assert.equal(passportCompleteness(full).score, 1);
  assert.equal(passportCompleteness({ ...full, safety: { restrictions: [] } }).score, 0.75, 'blank safety is not evidence');
  assert.equal(passportCompleteness({ ...full, safety: { restrictions: [], noneIdentified: true } }).score, 0.75, 'none identified needs review');
  assert.equal(passportCompleteness({ ...full, safety: { restrictions: [], noneIdentified: true, reviewed: true } }).score, 1);
  assert.equal(passportCompleteness({}).score, 0);
  assert.equal(passportCompleteness({ ...full, steps: ['ok'] }).score, 0.75);
  assert.equal(passportCompleteness({ ...full, symptoms: 'bad' }).score, 0.75);
});

test('R_author defaults: 0.85 verified import, 0.75 new staff, history when reliable', () => {
  assert.equal(authorReliability({ kind: 'verified_import' }).score, 0.85);
  assert.equal(authorReliability({ kind: 'staff' }).score, 0.75);
  assert.equal(authorReliability({ kind: 'staff', accepted: 2, rejected: 0 }).score, 0.75, 'fewer than 3 decisions is not reliable');
  assert.equal(authorReliability({ kind: 'staff', accepted: 3, rejected: 1 }).score, 0.75);
  assert.equal(authorReliability({ kind: 'staff', accepted: 1, rejected: 3 }).score, 0.25);
  assert.ok(authorReliability({ kind: 'unverified_import' }).score < 0.85, 'unverified data does not earn the verified default');
});

test('S_diag is bounded, deterministic and zero on conflict', () => {
  const conditions = conditionsFromText('Model X firmware 4');
  assert.equal(diagnosticSimilarity(conditions, customerFacts('Model X firmware 4')).score, 1);
  assert.equal(diagnosticSimilarity(conditions, customerFacts('Model X')).score, 0.5, 'half the conditions matched');
  assert.equal(diagnosticSimilarity(conditions, customerFacts('Model Y firmware 4')).score, 0, 'conflict');
  assert.equal(diagnosticSimilarity([], {}).score, 0.5);
});

test('S_hybrid = 0.65*cos + 0.35*bm25 with bounded normalisation and missing vectors', () => {
  close(hybridScore(1, 1), 1);
  close(hybridScore(0.8, 0.5), 0.695);
  close(hybridScore(-0.5, 1), 0.35, 1e-4);
  assert.equal(normCosine(null), 0);
  assert.equal(normCosine(-0.4), 0, 'negative cosine carries no support');
  assert.equal(hybridScore(null, 0.6), 0.21, 'missing vector uses lexical part only');
  assert.equal(cosine(null, new Float32Array(2)), null);
  assert.equal(cosine(new Float32Array(3), new Float32Array(3)), null, 'zero vectors have no cosine');
  close(cosine(localEmbedding('display flickers'), localEmbedding('display flickers')), 1, 1e-6);
});

test('NormBM25 is deterministic, bounded to [0,1], and zero without a lexical hit', () => {
  const q = new Set(['display', 'flicker', 'startup']);
  const d = new Set(['display', 'flicker', 'startup']);
  assert.equal(normBm25({ raw: 2, rawBest: 2, queryTokens: q, docTokens: d }), 1);
  assert.equal(normBm25({ raw: 1, rawBest: 2, queryTokens: q, docTokens: d }), 0.5);
  assert.equal(normBm25({ raw: null, rawBest: 2, queryTokens: q, docTokens: d }), 0);
  assert.equal(normBm25({ raw: 9, rawBest: 2, queryTokens: q, docTokens: d }), 1, 'clamped');
  assert.equal(normBm25({ raw: 1, rawBest: 1, queryTokens: new Set(['x']), docTokens: d }), 0, 'no shared tokens');
});

test('W_reliability = (2*C_init + successes) / (2 + successes + failures)', () => {
  close(reliability(0.8, 0, 0), 0.8);
  close(reliability(0.8, 1, 1), 0.65);
  close(reliability(0.8, 0, 2), 0.4);
  close(reliability(1, 8, 0), 1);
  assert.equal(reliability(NaN, -1, -1), 0);
});

test('S_final = 0.55*S_hybrid + 0.25*S_compat + 0.20*W_reliability', () => {
  close(finalScore(1, 1, 1), 1);
  close(finalScore(0.7, 1, 0.8), 0.55 * 0.7 + 0.25 + 0.2 * 0.8, 1e-4);
  close(finalScore(0, 1, 1), 0.45);
});

test('retrieval threshold: >= 0.70 passes, just below is rejected; ties are deterministic; max three', () => {
  const mk = (id, finalScore, extra = {}) => ({ id, eligible: true, finalScore, hybrid: finalScore, signature: id, ...extra });
  assert.deepEqual(rankCandidates([mk('a', 0.7)]).map((c) => c.id), ['a']);
  assert.deepEqual(rankCandidates([mk('a', 0.6999)]), []);
  const ranked = rankCandidates([mk('d', 0.8), mk('c', 0.8), mk('b', 0.9), mk('a', 0.75), mk('e', 0.71)]).map((c) => c.id);
  assert.deepEqual(ranked, ['b', 'c', 'd'], 'at most three, sorted by score then id');
  assert.deepEqual(rankCandidates([mk('x', 0.9, { eligible: false })]), [], 'ineligible regardless of score');
  assert.deepEqual(rankCandidates([mk('a', 0.9, { signature: 's' }), mk('b', 0.85, { signature: 's' })]).map((c) => c.id), ['a'], 'duplicate content collapses');
  assert.equal(THRESHOLDS.retrieval, 0.7);
});

test('review flag: 2 consecutive failures, or W < 0.55 once at least two outcomes exist (one failure never flags)', () => {
  assert.equal(needsReviewFlag({ consecutiveFailures: 2, cInit: 1, successes: 50, failures: 2 }).flag, true);
  assert.equal(needsReviewFlag({ consecutiveFailures: 1, cInit: 0.8375, successes: 0, failures: 1 }).flag, false, 'one ordinary failure');
  assert.equal(needsReviewFlag({ consecutiveFailures: 1, cInit: 0.75, successes: 0, failures: 1 }).flag, false, 'W=0.50 after one failure still does not flag');
  assert.equal(needsReviewFlag({ consecutiveFailures: 1, cInit: 0.7, successes: 0, failures: 1 }).flag, false, 'minimum-sample rule');
  assert.equal(needsReviewFlag({ consecutiveFailures: 1, cInit: 0.5, successes: 1, failures: 1 }).flag, true, 'W=0.50 with two outcomes');
  assert.equal(needsReviewFlag({ consecutiveFailures: 1, cInit: 0.6, successes: 1, failures: 1 }).flag, false, 'W exactly 0.55 is not < 0.55');
  assert.equal(needsReviewFlag({ consecutiveFailures: 1, cInit: 0.5999, successes: 1, failures: 1 }).flag, true);
  assert.equal(needsReviewFlag({ consecutiveFailures: 0, cInit: 0.4, successes: 0, failures: 0 }).flag, false, 'no outcomes, no flag');
});

test('compatibility gate: conflicts and safety restrictions make a candidate ineligible; unknown withholds', () => {
  const applicability = { environmentText: 'Model X firmware 4' };
  const safety = { restrictions: [{ text: 'Do not use with a swollen battery', keywords: ['swollen'] }] };
  const ok = compatibilityGate({ applicability, safety, facts: customerFacts('Model X firmware 4'), text: 'Model X firmware 4 flicker' });
  assert.equal(ok.eligible, true);
  assert.equal(ok.compat, 1);
  const conflict = compatibilityGate({ applicability, safety, facts: customerFacts('Model Y firmware 4'), text: 'Model Y firmware 4' });
  assert.equal(conflict.eligible, false);
  assert.equal(conflict.status, 'conflict');
  const unknown = compatibilityGate({ applicability, safety, facts: customerFacts('my laptop'), text: 'my laptop' });
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.status, 'unknown');
  const unsafe = compatibilityGate({ applicability, safety, facts: customerFacts('Model X firmware 4'), text: 'Model X firmware 4 and the battery is swollen' });
  assert.equal(unsafe.eligible, false);
  assert.equal(unsafe.status, 'safety_conflict');
  const hazard = compatibilityGate({ applicability: { universal: true }, safety: {}, facts: {}, text: 'laptop is smoking' });
  assert.equal(hazard.eligible, false, 'universal hazard words always route to a specialist');
});

test('negation, Android/iOS versions and ranges gate eligibility even for strong semantic matches', () => {
  const gate = (env, text) => compatibilityGate({ applicability: { environmentText: env }, safety: {}, facts: customerFacts(text), text });
  assert.equal(gate('Model X', 'This is not a Model X').eligible, false);
  assert.equal(gate('Android 13', 'phone on Android 12').eligible, false);
  assert.equal(gate('Android 13', 'iPhone on iOS 17').eligible, false);
  assert.equal(gate('Android 12 or later', 'Android 14 phone').eligible, true);
  assert.equal(gate('Android 10-12', 'Android 13 phone').eligible, false);
  assert.equal(gate('Android 13', 'phone').status, 'unknown');
});

test('clamp01', () => {
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(undefined), 0);
});

test('privacy: PII is redacted, secrets detected, dangerous instructions flagged', () => {
  const r = scrubPII('Email jane@corp.example or call +1 415 555 0100. S/N ABC12345. Firmware 4.2 on Android 13.1. IMEI 356938035643809.', { names: ['Jane Doe'] });
  assert.doesNotMatch(r.text, /jane@corp|415 555|ABC12345|356938035643809/);
  assert.match(r.text, /Firmware 4\.2 on Android 13\.1/, 'version numbers are preserved');
  assert.ok(r.count >= 4);
  assert.equal(scrubPII('Ask Jane Doe about it', { names: ['Jane Doe'] }).text, 'Ask [redacted name] about it');
  assert.equal(containsSecret('api_key = abc'), true);
  assert.equal(containsSecret('select the training profile'), false);
  assert.ok(dangerousInstructions('Open the battery and bypass the thermal fuse').length >= 2);
  assert.deepEqual(dangerousInstructions('Select the Standard display profile.'), []);
});
