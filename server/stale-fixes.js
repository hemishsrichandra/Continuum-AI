// Stale-fix detection: which stored fixes deserve a fresh look, and why.
//
// A fix can be right when it is written and quietly stop being right. Three signals, all computed from this company's own
// recorded outcomes and customer-stated facts (nothing is guessed, nothing is changed automatically; an owner or specialist decides):
//   success_drop   the last few outcomes are clearly worse than the fix's earlier record
//   not_reconfirmed no customer has confirmed it and no one has touched it for a long time (default 180 days)
//   version_lag    several recent customers state a newer version / firmware / OS release than the fix says it covers
import { customerFacts, compareVersions, conditionsFromText } from './applicability.js';

const DAY = 86400000;
const VERSION_KEYS = new Set(['firmware', 'version', 'android', 'ios', 'windows', 'macos', 'ubuntu']);
const num = (v) => /^\d+(?:\.\d+)*$/.test(String(v));
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

/** The newest release a fix says it covers, per version key. Open-ended fixes ("4 or later") cover everything and are skipped. */
function coveredMax(applicability) {
  const out = {};
  const conditions = Array.isArray(applicability?.conditions) && applicability.conditions.length
    ? applicability.conditions
    : conditionsFromText(applicability?.environmentText || '');
  for (const c of conditions) {
    const key = String(c.key).toLowerCase();
    if (!VERSION_KEYS.has(key) || c.op === 'not_in') continue;
    let max = null;
    if (c.op === 'range') {
      if (c.max === undefined || c.max === null) continue; // open-ended
      max = String(c.max);
    } else {
      const values = (c.values || []).map(String).filter(num);
      if (!values.length) continue;
      max = values.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    }
    if (num(max)) out[key] = max;
  }
  return out;
}

/** The device models a fix names (lower-case values of its "model" conditions). */
function coveredModels(applicability) {
  const conditions = Array.isArray(applicability?.conditions) && applicability.conditions.length ? applicability.conditions : conditionsFromText(applicability?.environmentText || '');
  return new Set(conditions.filter((c) => String(c.key).toLowerCase() === 'model' && c.op !== 'not_in').flatMap((c) => (c.values || []).map((v) => String(v).toLowerCase())));
}

export function staleFixes(store, companyId, { chatbotId = null, at = Date.now(), ageDays = 180, recentDays = 90, minSignals = 1 } = {}) {
  const sql = store.db;
  const params = [companyId, ...(chatbotId ? [chatbotId] : [])];
  const scope = chatbotId ? 'AND chatbot_id=?' : '';
  const fixes = sql.prepare(`SELECT * FROM memory_pool WHERE company_id=? ${scope} AND status IN ('active','flagged_for_review') AND origin_type<>'standard_playbook'`).all(...params);
  if (!fixes.length) return [];

  const outcomes = new Map();
  for (const r of sql.prepare(`SELECT memory_id, outcome, outcome_at FROM troubleshooting_attempts WHERE company_id=? ${scope} AND source='learned' AND outcome IN ('succeeded','failed') AND memory_id IS NOT NULL ORDER BY outcome_at`).all(...params)) {
    if (!outcomes.has(r.memory_id)) outcomes.set(r.memory_id, []);
    outcomes.get(r.memory_id).push({ ok: r.outcome === 'succeeded', at: Date.parse(r.outcome_at) || 0 });
  }

  // What each recent customer said about their device: model(s) and version-like facts. Versions are only ever compared between
  // customers on the SAME model as the fix (firmware 4 on a Model X says nothing about a fix written for a Model R).
  const customers = [];
  const since = new Date(at - recentDays * DAY).toISOString();
  for (const r of sql.prepare(`SELECT context FROM troubleshooting_attempts WHERE company_id=? ${scope} AND created_at>=?`).all(...params, since)) {
    const ctx = parse(r.context, {});
    const facts = customerFacts(Object.values(ctx).filter((v) => typeof v === 'string').join('; '));
    const versions = {};
    for (const [key, f] of Object.entries(facts)) if (VERSION_KEYS.has(key)) versions[key] = f.values.filter(num);
    if (Object.values(versions).some((v) => v.length)) customers.push({ models: new Set(facts.model?.values || []), versions });
  }

  const found = [];
  for (const fix of fixes) {
    const signals = [];
    const list = outcomes.get(fix.id) || [];
    if (list.length >= 6) {
      const recent = list.slice(-3), earlier = list.slice(0, -3);
      const rate = (xs) => xs.filter((x) => x.ok).length / xs.length;
      if (rate(recent) <= 0.34 && rate(earlier) - rate(recent) >= 0.3)
        signals.push({ kind: 'success_drop', detail: `Worked ${Math.round(rate(earlier) * 100)}% of the time before, but only ${recent.filter((x) => x.ok).length} of the last ${recent.length} times.` });
    }
    const lastSuccess = Math.max(0, ...list.filter((x) => x.ok).map((x) => x.at));
    const touched = Math.max(Date.parse(fix.updated_at) || 0, Date.parse(fix.created_at) || 0, lastSuccess);
    if (!fix.customer_confirmed && at - touched > ageDays * DAY)
      signals.push({ kind: 'not_reconfirmed', detail: `Not confirmed by a customer or reviewed for ${Math.floor((at - touched) / DAY)} days.` });
    else if (list.length && !lastSuccess && at - touched > ageDays * DAY)
      signals.push({ kind: 'not_reconfirmed', detail: `No success recorded for ${Math.floor((at - touched) / DAY)} days.` });
    const applicability = parse(fix.applicability_json, {});
    const covers = coveredMax(applicability);
    const fixModels = coveredModels(applicability);
    for (const [key, max] of Object.entries(covers)) {
      // Without a model condition the fix claims every device, so every customer counts; with one, only customers on that model.
      const same = customers.filter((c) => !fixModels.size || [...c.models].some((m) => fixModels.has(m)));
      const newer = same.flatMap((c) => c.versions[key] || []).filter((v) => compareVersions(v, max) > 0);
      if (newer.length >= 3) {
        const newest = newer.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
        signals.push({ kind: 'version_lag', detail: `${newer.length} recent customers on the same model report ${key} ${newest}, newer than the ${key} ${max} this fix says it covers.` });
      }
    }
    if (signals.length >= minSignals) found.push({ id: fix.id, title: fix.title, version: fix.version_number, status: fix.status, signals });
  }
  const weight = { success_drop: 3, version_lag: 2, not_reconfirmed: 1 };
  return found.sort((a, b) => b.signals.reduce((n, s) => n + weight[s.kind], 0) - a.signals.reduce((n, s) => n + weight[s.kind], 0)).slice(0, 25);
}
