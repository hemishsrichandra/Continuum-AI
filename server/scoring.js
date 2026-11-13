// Centralised, deterministic scoring for Resolution Passports.
//
// Pure module: no database, network or model access. Shared by the main
// application's retriever (server/memory-pool.js) and by the isolated learning
// demo (server/demo-learning.js). All formulas are documented in docs/ARCHITECTURE.md
// and unit-tested in test/scoring.test.js.
import { tokens, conceptTokens, compatibility } from './context.js';
import { evaluateConditions, conditionsFromText, describeCondition } from './applicability.js';

export const THRESHOLDS = Object.freeze({
  retrieval: 0.7, // S_final below this is rejected
  autoPublish: 0.75, // C_init required for overdue (unconfirmed) publication
  reliabilityFlag: 0.55, // W_reliability below this flags for review
  consecutiveFailures: 2, // consecutive failures that flag for review
  minOutcomesForReliability: 2, // reliability rule only applies after this many outcomes
  maxSuggestions: 3,
  partialHybrid: 0.65, // a generic, only partly confirmed environment stays in play from this S_hybrid up (with S_compat 0.5)
});
export const AUTHOR_DEFAULTS = Object.freeze({ verifiedImport: 0.85, newStaff: 0.75, unverifiedImport: 0.5, standardPlaybook: 0.85 });

export const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round = (n) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// Passport completeness P_passport: 0.25 for each adequately filled section (title, environment, safety review, steps).
// Blank is never evidence. "None identified" safety counts only after review.
const meaningful = (text, min = 3) => tokens(text || '').size >= min;
export function passportCompleteness(p = {}) {
  const steps = Array.isArray(p.steps) ? p.steps : p.steps ? [p.steps] : [];
  const applicability = p.applicability || {};
  const safety = p.safety || {};
  const parts = {
    title: meaningful(p.title, 2) && String(p.title).trim().length >= 6,
    // Title, environment, steps and the safety review decide completeness. Symptoms are derived server-side, so they never count.
    applicability:
      (Array.isArray(applicability.conditions) && applicability.conditions.length > 0) ||
      conditionsFromText(applicability.environmentText || '').length > 0 ||
      String(applicability.environmentText || '').trim().length >= 6 ||
      (applicability.universal === true && applicability.reviewed === true),
    safety:
      (Array.isArray(safety.restrictions) && safety.restrictions.some((r) => String(r.text || r).trim().length >= 6)) ||
      (safety.noneIdentified === true && safety.reviewed === true),
    steps: steps.join(' ').trim().length >= 20 && meaningful(steps.join(' '), 3),
  };
  const score = Object.values(parts).filter(Boolean).length * 0.25;
  return { score, parts };
}

// ---------------------------------------------------------------------------
// S_diag: deterministic diagnostic-to-applicability similarity in [0,1].
// matched / total explicit conditions; any conflict -> 0; unknown counts 0.
// With no explicit conditions there is no diagnostic evidence: 0.5 (neutral).
export function diagnosticSimilarity(conditions = [], facts = {}) {
  if (!conditions.length) return { score: 0.5, evaluation: { status: 'compatible', matched: [], missing: [], conflicts: [] } };
  const evaluation = evaluateConditions(conditions, facts);
  const score = evaluation.conflicts.length ? 0 : evaluation.matched.length / conditions.length;
  return { score: clamp01(score), evaluation };
}

// R_author: historical specialist acceptance rate where reliable (>=3 decided
// proposals), otherwise the agreed defaults.
export function authorReliability({ kind = 'staff', accepted = 0, rejected = 0 } = {}) {
  if (kind === 'verified_import') return { score: AUTHOR_DEFAULTS.verifiedImport, basis: 'verified company database import default' };
  if (kind === 'unverified_import') return { score: AUTHOR_DEFAULTS.unverifiedImport, basis: 'unverified import default' };
  if (kind === 'standard_playbook') return { score: AUTHOR_DEFAULTS.standardPlaybook, basis: 'owner-configured standard playbook' };
  const decided = accepted + rejected;
  if (decided >= 3) return { score: clamp01(accepted / decided), basis: `specialist acceptance ${accepted}/${decided}` };
  return { score: AUTHOR_DEFAULTS.newStaff, basis: 'new specialist default' };
}

/** C_init = 0.40*P_passport + 0.35*S_diag + 0.25*R_author (clamped). */
export function initialConfidence({ passport = 0, diag = 0, author = 0 }) {
  const components = { P_passport: clamp01(passport), S_diag: clamp01(diag), R_author: clamp01(author) };
  const score = clamp01(0.4 * components.P_passport + 0.35 * components.S_diag + 0.25 * components.R_author);
  return { score: round(score), components, formula: 'C_init = 0.40*P_passport + 0.35*S_diag + 0.25*R_author' };
}

// ---------------------------------------------------------------------------
// Local, offline embedding: a hashed feature vector of concept-normalised
// tokens, token bigrams and character 4-grams. This is a lexical-concept
// representation, NOT a neural semantic model; it is labelled as such.
export const LOCAL_EMBEDDING_MODEL = 'local-hashed-concepts-v2';
export const EMBEDDING_DIMENSIONS = 512;
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function localEmbedding(text) {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  const words = [...tokens(text)];
  const add = (feature, weight) => {
    v[fnv(feature) % EMBEDDING_DIMENSIONS] += weight;
  };
  // Shared normalised concepts (display, flicker, startup …) carry most of the meaning across
  // paraphrases, so they outweigh incidental words and character n-grams.
  for (const c of conceptTokens(text)) add('k:' + c, 1.6);
  for (const w of words) {
    add('w:' + w, 1);
    const padded = `#${w}#`;
    for (let i = 0; i + 4 <= padded.length; i++) add('c:' + padded.slice(i, i + 4), 0.12);
  }
  const sorted = [...words].sort();
  for (let i = 0; i + 1 < sorted.length; i++) add('b:' + sorted[i] + ' ' + sorted[i + 1], 0.2);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}
export const vectorToBlob = (v) => Buffer.from(new Float32Array(v).buffer);
export const blobToVector = (b) => (b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null);

/** Signed cosine similarity, or null when either vector is missing/empty. */
export function cosine(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return null;
  return dot / Math.sqrt(na * nb);
}
/** Normalised cosine: max(0, cos). Negative similarity carries no support. Missing -> 0. */
export const normCosine = (c) => (c === null || c === undefined ? 0 : clamp01(c));

/**
 * NormBM25 in [0,1]. SQLite FTS5 bm25() is negative (more negative = better) and its
 * IDF degenerates on very small corpora, so the bounded normalisation is:
 *   NormBM25 = coverage * (rawBest > 0 ? raw / rawBest : 1)
 * where raw = -bm25 for this candidate, rawBest = best raw among the FTS matches of
 * the same query, and coverage = |Q ∩ D| / min(|Q|, |D|) over concept-normalised
 * tokens of the query and the passport title+symptoms. Non-matching candidates
 * (no FTS hit) score 0.
 */
export function normBm25({ raw, rawBest, queryTokens, docTokens }) {
  if (raw === null || raw === undefined) return 0;
  const q = queryTokens instanceof Set ? queryTokens : new Set(queryTokens);
  const d = docTokens instanceof Set ? docTokens : new Set(docTokens);
  if (!q.size || !d.size) return 0;
  const overlap = [...d].filter((w) => q.has(w)).length;
  const coverage = overlap / Math.min(q.size, d.size);
  const relative = rawBest > 0 ? clamp01(raw / rawBest) : 1;
  return round(clamp01(coverage * relative));
}

/** Minimal in-memory BM25 (k1=1.2,b=0.75) for the isolated demo, returning raw positive scores. */
export function bm25Raw(docs, query) {
  const q = [...tokens(query)];
  const docTokens = docs.map((d) => [...tokens(d)]);
  const N = docs.length || 1;
  const avg = docTokens.reduce((n, t) => n + t.length, 0) / N || 1;
  return docTokens.map((t) => {
    let s = 0;
    for (const term of q) {
      const tf = t.filter((x) => x === term).length;
      if (!tf) continue;
      const n = docTokens.filter((x) => x.includes(term)).length;
      const idf = Math.max(1e-6, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
      s += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (t.length / avg))));
    }
    return s > 0 ? s : null;
  });
}

/** S_hybrid = 0.65*CosineSim + 0.35*NormBM25. */
export const hybridScore = (cos, bm25) => round(clamp01(0.65 * normCosine(cos) + 0.35 * clamp01(bm25)));
/** W_reliability = (2*C_init + s) / (2 + s + f). */
export function reliability(cInit, successes = 0, failures = 0) {
  const s = Math.max(0, successes | 0), f = Math.max(0, failures | 0);
  return round(clamp01((2 * clamp01(cInit) + s) / (2 + s + f)));
}
/** S_final = 0.55*S_hybrid + 0.25*S_compat + 0.20*W_reliability. */
export const finalScore = (hybrid, compat, w) => round(clamp01(0.55 * clamp01(hybrid) + 0.25 * clamp01(compat) + 0.2 * clamp01(w)));

/** Should an active passport be flagged for review after an outcome? */
export function needsReviewFlag({ consecutiveFailures = 0, cInit = 0, successes = 0, failures = 0 }) {
  const w = reliability(cInit, successes, failures);
  // The reliability rule needs at least two recorded outcomes: with no history W is just
  // a function of C_init, so a single ordinary failure must never flag (or lock out) a fix.
  const enough = successes + failures >= THRESHOLDS.minOutcomesForReliability;
  return { flag: consecutiveFailures >= THRESHOLDS.consecutiveFailures || (enough && w < THRESHOLDS.reliabilityFlag), reliability: w };
}

// ---------------------------------------------------------------------------
// Compatibility gate. Returns S_compat with hard ineligibility.
// - required conditions all explicitly match -> 1.0
// - optional (required:false) conditions scale 0.7 + 0.3*fraction matched
// - any conflict / safety restriction hit -> ineligible
// - unknown required facts -> withheld (clarify), never compatible by default
// Structured catalogue fields an import can carry. They are matched against what the customer stated (a diagnostic field, or the model /
// product / category appearing in their own words). Which values exist is entirely the tenant's data: nothing here names a category.
const STRUCTURED_KEYS = new Set(['model', 'product_family', 'problem_category']);
const slugOf = (v) => String(v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const STRUCTURED_LABELS = { model: 'model', product_family: 'product family', problem_category: 'problem category' };
/** Facts the customer implied without a keyword ("my Acme X100 stopped charging" names the model) and slug-normalised family/category values. */
function withStructuredFacts(conditions, facts, text) {
  let out = facts;
  const haystack = ' ' + String(text || '').toLowerCase().replace(/[^\p{L}\p{N}.+]+/gu, ' ').replace(/\s+/g, ' ') + ' ';
  for (const c of conditions) {
    const key = String(c.key).toLowerCase();
    if (!STRUCTURED_KEYS.has(key) || c.op !== 'in') continue;
    if (key !== 'model' && facts[key]?.values.length) {
      out = out === facts ? { ...facts } : out;
      out[key] = { ...facts[key], values: facts[key].values.map(slugOf) };
    }
    if (out[key]?.values.length) continue;
    const hit = (c.values || []).find((v) => {
      const needle = (key === 'model' ? String(v) : String(v).replace(/-/g, ' ')).toLowerCase().trim();
      return needle.length >= 2 && haystack.includes(' ' + needle + ' ');
    });
    if (hit) { out = out === facts ? { ...facts } : out; out[key] = { values: [String(hit).toLowerCase()], negated: facts[key]?.negated || [] }; }
  }
  return out;
}
export function compatibilityGate({ applicability = {}, safety = {}, facts: statedFacts = {}, text = '', fields = {} }) {
  const conditions = Array.isArray(applicability.conditions) ? applicability.conditions : [];
  const facts = withStructuredFacts(conditions, statedFacts, text);
  const required = conditions.filter((c) => c.required !== false);
  const softStructured = conditions.filter((c) => c.required === false && STRUCTURED_KEYS.has(String(c.key).toLowerCase()));
  const optional = conditions.filter((c) => c.required === false && !STRUCTURED_KEYS.has(String(c.key).toLowerCase()));
  const evaluation = evaluateConditions(required, facts);
  const missingConditions = [...(evaluation.missingConditions || [])];
  let unparsedMissing = [];
  // Free-text environment restrictions (legacy and specialist-entered) are checked
  // with the same negation/version-aware parser plus explicit-keyword rules.
  if (applicability.environmentText) {
    const legacy = compatibility(applicability.environmentText, text, fields);
    evaluation.missing.push(...legacy.missing);
    evaluation.conflicts.push(...legacy.conflicts);
    missingConditions.push(...legacy.missingConditions);
    unparsedMissing = legacy.unparsedMissing || [];
    evaluation.status = evaluation.conflicts.length ? 'conflict' : evaluation.missing.length ? 'unknown' : 'compatible';
  }
  const safetyHits = safetyConflicts(safety, facts, text);
  if (safetyHits.length) return { eligible: false, status: 'safety_conflict', compat: 0, reasons: safetyHits, evaluation };
  if (evaluation.status === 'conflict') return { eligible: false, status: 'conflict', compat: 0, reasons: evaluation.conflicts, evaluation };
  // The one permitted partial case: every missing fact belongs to a generic "verified on" device name (no version, firmware or
  // other mandatory requirement), and nothing else in the environment text is unaccounted for. Mandatory facts still ask first.
  if (evaluation.status === 'unknown' && missingConditions.length && missingConditions.every((c) => c.generic) && !unparsedMissing.length) {
    const verifiedOn = applicability.environmentText || missingConditions.map(describeCondition).join('; ');
    return { eligible: true, partial: true, status: 'partial', compat: 0.5, reasons: ['environment not fully confirmed: ' + verifiedOn], advisory: `Note: This solution was verified on ${verifiedOn}. Steps may vary slightly for your setup.`, verifiedOn, evaluation };
  }
  if (evaluation.status === 'unknown') return { eligible: false, status: 'unknown', compat: 0, reasons: evaluation.missing, evaluation };
  let compat = 1;
  if (optional.length) {
    const o = evaluateConditions(optional.map((c) => ({ ...c, required: true })), facts);
    compat = 0.7 + (0.3 * o.matched.length) / optional.length;
  }
  // A soft structured field (the problem category) only counts when the customer's side is known: matching it helps, a different stated
  // value lowers the score a little, and an unknown value changes nothing. It can never make a fix ineligible.
  const structuredReport = [];
  const softReasons = [];
  if (softStructured.length) {
    let known = 0, matchedSoft = 0;
    for (const c of softStructured) {
      const e = evaluateConditions([{ ...c, required: true }], facts);
      const label = STRUCTURED_LABELS[String(c.key).toLowerCase()] || c.key;
      const status = e.status === 'compatible' ? 'matched' : e.status === 'conflict' ? 'different' : 'not stated';
      structuredReport.push({ field: label, status, values: c.values || [] });
      if (status !== 'not stated') known++;
      if (status === 'matched') { matchedSoft++; softReasons.push(`${label}: ${(c.values || []).join(' or ')}`); }
    }
    if (known) compat *= 0.7 + (0.3 * matchedSoft) / known;
  }
  for (const c of required) {
    const key = String(c.key).toLowerCase();
    if (STRUCTURED_KEYS.has(key)) structuredReport.push({ field: STRUCTURED_LABELS[key], status: 'matched', values: c.values || [] });
  }
  const reasons = [...evaluation.matched, ...softReasons, ...(applicability.environmentText ? ['environment: ' + applicability.environmentText] : [])];
  return { eligible: true, status: 'compatible', compat: round(compat), reasons, evaluation, ...(structuredReport.length && { structured: structuredReport }) };
}

/**
 * Safety restrictions: conditions that must NOT hold, or hazard keywords the customer reported. The restriction's
 * own text is always consulted as well, so an empty `keywords` array (or a malformed restriction) cannot bypass it.
 * A restriction that cannot be evaluated by machine blocks the fix until a specialist rewrites it.
 */
export function safetyConflicts(safety = {}, facts = {}, text = '') {
  const hits = [];
  const words = String(text).toLowerCase();
  const customer = tokens(words);
  const restrictions = Array.isArray(safety.restrictions) ? safety.restrictions : [];
  for (const r of restrictions) {
    const item = typeof r === 'string' ? { text: r } : r && typeof r === 'object' ? r : { text: '' };
    const label = item.text || 'safety restriction';
    // Keywords supplied by the author, plus hazard words found in the restriction text itself.
    const keywords = [...new Set([...(Array.isArray(item.keywords) ? item.keywords : []), ...hazardWords(item.text)])];
    for (const k of keywords) {
      if (k && new RegExp('\\b' + String(k).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(words)) {
        hits.push(`Safety restriction: ${label}`);
        break;
      }
    }
    // Trigger clause ("... if the cable is frayed"): blocked when every content term of the clause was described.
    const terms = Array.isArray(item.terms) ? item.terms : [];
    if (terms.length && terms.every((t) => customer.has(t))) hits.push(`Safety restriction: ${label}`);
    if (Array.isArray(item.conditions) && item.conditions.length) {
      const e = evaluateConditions(item.conditions.map((c) => ({ ...c, required: true })), facts);
      if (e.status === 'compatible') hits.push(`Safety restriction: ${label || item.conditions.map(describeCondition).join(', ')}`);
    }
    if (item.unevaluable === true && safety.reviewed !== true) hits.push(`Safety restriction needs specialist review: ${label}`);
  }
  // Universal hazard words always route to a specialist, regardless of passport.
  if (/\b(?:smoke|smoking|burning|sparks?|swollen|swelling|bulging|electric shock|fire|melting|leaking battery)\b/.test(words))
    hits.push('Safety: reported hazard requires a specialist');
  return [...new Set(hits)];
}
const hazardWords = (text) => String(text || '').toLowerCase().match(/\b(?:swollen|swelling|hot|overheat\w*|smoke|smoking|burning|burnt|damaged|cracked|wet|water|liquid|damp|moist\w*|spill\w*|sparks?|leak\w*|bent|frayed|corrosion|corroded|exposed|melted|melting|sticky)\b/g) || [];

/** Rank already-scored candidates deterministically and return at most N eligible. */
export function rankCandidates(candidates, limit = THRESHOLDS.maxSuggestions) {
  const seen = new Set();
  return candidates
    .filter((c) => c.eligible && c.finalScore >= THRESHOLDS.retrieval)
    .sort((a, b) => b.finalScore - a.finalScore || b.hybrid - a.hybrid || String(a.id).localeCompare(String(b.id)))
    .filter((c) => {
      const key = c.signature || c.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
