// Deterministic applicability / compatibility evaluation.
//
// This module is pure (no database, network or model access). It is shared by
// the main application and by the isolated learning demo. Semantic similarity is
// never used here: a candidate is compatible only when its explicit conditions
// are satisfied by facts the customer actually stated.

export const OS_FAMILIES = ['android', 'ios', 'windows', 'macos', 'ubuntu'];
const NEGATION = /\b(?:not|no|isn'?t|is not|aren'?t|without|except|excluding|never|non|don'?t have|do not have|doesn'?t have|other than|instead of)\b/i;
const VALUE = '(\\d+(?:\\.\\d+)*)';
const OP = '(>=|<=|>|<|=)?\\s*';
const patterns = [
  ['model', /\bmodels?\s+([a-z0-9][a-z0-9_-]*)/gi],
  // Product names such as "Laptop X1" or "phone Z9" (letters followed by a digit) also identify a model.
  ['model', /\b(?:laptop|notebook|phone|tablet|printer|router|watch|device)\s+([a-z]+\d[a-z0-9_-]*)/gi],
  ['firmware', new RegExp('\\bfirmware\\s*(?:version\\s*|v\\s*)?' + OP + VALUE, 'gi')],
  ['android', new RegExp('\\bandroid\\s*(?:os\\s*)?(?:version\\s*|v\\s*)?' + OP + VALUE, 'gi')],
  ['ios', new RegExp('\\b(?:ios|ipados)\\s*(?:version\\s*|v\\s*)?' + OP + VALUE, 'gi')],
  ['windows', new RegExp('\\bwindows\\s*(?:version\\s*)?' + OP + VALUE, 'gi')],
  ['macos', new RegExp('\\b(?:macos|mac os|os x)\\s*(?:version\\s*)?' + OP + VALUE, 'gi')],
  ['ubuntu', new RegExp('\\bubuntu\\s*(?:version\\s*)?' + OP + VALUE, 'gi')],
  ['version', new RegExp('\\bversion\\s*' + OP + VALUE, 'gi')],
];
const opNames = { '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt', '=': 'eq' };

function clauseBefore(text, index) {
  const before = text.slice(0, index);
  const cut = Math.max(...[',', ';', '.', '!', '?', '\n', ' but ', ' and it ', ' it is ', " it's "].map((s) => before.toLowerCase().lastIndexOf(s)));
  return before.slice(cut + 1).split(/\s+/).slice(-5).join(' ');
}
function rangeAfter(text, end) {
  const after = text.slice(end, end + 40).toLowerCase();
  let m;
  if ((m = after.match(/^\s*(?:\+|or (?:later|newer|above|higher)|and (?:later|newer|above|up|higher))/))) return { op: 'gte' };
  if ((m = after.match(/^\s*(?:or (?:earlier|older|below|lower)|and (?:earlier|older|below|lower))/))) return { op: 'lte' };
  if ((m = after.match(/^\s*(?:-|–|to|through)\s*(\d+(?:\.\d+)*)/))) return { op: 'range', max: m[1], consumed: m[0].length };
  return null;
}
function rangeBefore(clause) {
  const c = clause.toLowerCase();
  if (/(?:at least|minimum|min\.?|from)\s*$/.test(c)) return 'gte';
  if (/(?:up to|at most|maximum|max\.?|below|under|before)\s*$/.test(c)) return /(?:below|under|before)\s*$/.test(c) ? 'lt' : 'lte';
  if (/(?:above|over|after|newer than)\s*$/.test(c)) return 'gt';
  return null;
}

/** Extract explicit, structured environment mentions from free text. */
export function extractMentions(text) {
  const input = String(text || '');
  const mentions = [];
  const spans = [];
  for (const [key, pattern] of patterns) {
    for (const m of input.matchAll(pattern)) {
      if (key === 'version' && /(?:firmware|android|ios|ipados|windows|macos|ubuntu|os)\s*$/i.test(input.slice(0, m.index))) continue;
      const value = (key === 'model' ? m[1] : m[2]).toLowerCase().replace(/[.,;:]+$/, '');
      if (key === 'model' && ['number', 'name', 'unknown', 'is', 'the'].includes(value)) continue;
      const clause = clauseBefore(input, m.index);
      const negated = NEGATION.test(clause);
      let op = key === 'model' ? 'eq' : opNames[m[1]] || rangeBefore(clause) || 'eq';
      let max;
      let end = m.index + m[0].length;
      if (key !== 'model' && op === 'eq') {
        const r = rangeAfter(input, end);
        if (r) {
          op = r.op;
          max = r.max;
          end += r.consumed || 0;
        }
      }
      mentions.push({ key, value, op, ...(max && { max }), negated });
      spans.push([m.index, end]);
    }
  }
  return { mentions, spans };
}

export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
/** match | conflict | unknown for an exact (prefix-aware) version/model value. */
function valueMatch(key, expected, actual) {
  if (key === 'model') return expected === actual ? 'match' : 'conflict';
  if (actual === expected || actual.startsWith(expected + '.')) return 'match';
  if (expected.startsWith(actual + '.')) return 'unknown';
  return 'conflict';
}

/** Turn an environment description into explicit conditions. */
export function conditionsFromText(text) {
  const { mentions } = extractMentions(text);
  const byKey = new Map();
  const conditions = [];
  for (const m of mentions) {
    if (m.negated) {
      conditions.push({ key: m.key, op: 'not_in', values: [m.value], required: true });
      continue;
    }
    if (m.op === 'eq') {
      if (!byKey.has(m.key)) {
        const c = { key: m.key, op: 'in', values: [], required: true };
        byKey.set(m.key, c);
        conditions.push(c);
      }
      if (!byKey.get(m.key).values.includes(m.value)) byKey.get(m.key).values.push(m.value);
    } else {
      const c = { key: m.key, op: 'range', required: true };
      if (m.op === 'range') Object.assign(c, { min: m.value, max: m.max });
      else if (m.op === 'gte') c.min = m.value;
      else if (m.op === 'gt') Object.assign(c, { min: m.value, minExclusive: true });
      else if (m.op === 'lte') c.max = m.value;
      else if (m.op === 'lt') Object.assign(c, { max: m.value, maxExclusive: true });
      conditions.push(c);
    }
  }
  return conditions;
}

/**
 * Customer facts: positive and negated values per key, combining parsed free
 * text with structured diagnostic fields (field key -> value).
 */
export function customerFacts(text = '', fields = {}) {
  const facts = {};
  const add = (key, value, negated) => {
    facts[key] ||= { values: [], negated: [] };
    const list = negated ? facts[key].negated : facts[key].values;
    if (!list.includes(value)) list.push(value);
  };
  const structuredText = Object.entries(fields || {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => {
      add(k.toLowerCase(), v.trim().toLowerCase(), false);
      return v;
    })
    .join('\n');
  for (const m of extractMentions(String(text) + '\n' + structuredText).mentions) add(m.key, m.value, m.negated);
  return facts;
}

/**
 * Evaluate explicit conditions against customer facts.
 * Returns { status: 'compatible'|'unknown'|'conflict', matched, missing, conflicts }.
 * Any conflict makes a candidate ineligible regardless of its relevance score.
 */
export function evaluateConditions(conditions = [], facts = {}) {
  const matched = [], missing = [], conflicts = [];
  const statedOs = OS_FAMILIES.filter((k) => facts[k]?.values.length);
  for (const c of conditions) {
    const key = String(c.key).toLowerCase();
    const f = facts[key] || { values: [], negated: [] };
    const label = describeCondition(c);
    const values = (c.values || []).map((v) => String(v).toLowerCase());
    if (!f.values.length) {
      // A different operating-system family is an explicit environment conflict.
      if (OS_FAMILIES.includes(key) && c.op !== 'not_in' && statedOs.length && !statedOs.includes(key)) {
        conflicts.push(label);
        continue;
      }
      if (c.op === 'in' && values.length && values.every((v) => f.negated.includes(v))) {
        conflicts.push(label);
        continue;
      }
      if (c.required === false) continue;
      missing.push(label);
      continue;
    }
    if (c.op === 'not_in' || c.op === 'neq') {
      if (f.values.some((a) => values.some((e) => valueMatch(key, e, a) === 'match'))) conflicts.push(label);
      else matched.push(label);
      continue;
    }
    if (c.op === 'range') {
      if (f.values.some((v) => !/^\d+(?:\.\d+)*$/.test(v))) {
        missing.push(label);
        continue;
      }
      const ok = f.values.every((v) => {
        if (c.min !== undefined) {
          const d = compareVersions(v, c.min);
          if (d < 0 || (d === 0 && c.minExclusive)) return false;
        }
        if (c.max !== undefined) {
          const d = compareVersions(v, c.max);
          // "up to 12" includes 12.x releases.
          if (c.maxExclusive ? d >= 0 : d > 0 && !String(v).startsWith(String(c.max) + '.')) return false;
        }
        return true;
      });
      (ok ? matched : conflicts).push(label);
      continue;
    }
    // in / eq
    const results = f.values.map((a) => (values.length ? values.map((e) => valueMatch(key, e, a)) : ['match']));
    if (results.some((r) => !r.includes('match') && !r.includes('unknown'))) conflicts.push(label);
    else if (results.every((r) => r.includes('match'))) matched.push(label);
    else missing.push(label);
  }
  const status = conflicts.length ? 'conflict' : missing.length ? 'unknown' : 'compatible';
  return { status, matched, missing, conflicts };
}

export function describeCondition(c) {
  if (c.op === 'range') {
    const lo = c.min !== undefined ? (c.minExclusive ? '>' : '≥') + c.min : '';
    const hi = c.max !== undefined ? (c.maxExclusive ? '<' : '≤') + c.max : '';
    return `${c.key} ${[lo, hi].filter(Boolean).join(' and ')}`;
  }
  return `${c.key}${c.op === 'not_in' || c.op === 'neq' ? ' not ' : ': '}${(c.values || []).join(' or ')}`;
}

export function stripMentions(text) {
  const input = String(text || '');
  const { spans } = extractMentions(input);
  let out = '';
  let last = 0;
  for (const [s, e] of spans.sort((a, b) => a[0] - b[0])) {
    if (s < last) continue;
    out += input.slice(last, s) + ' ';
    last = e;
  }
  return out + input.slice(last);
}
