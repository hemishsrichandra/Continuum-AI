// Shadow mode: retrieve and rank suggestions for a service's live conversations WITHOUT showing them to anyone.
//
//  * opt-in per service by the company owner, off by default, one switch to turn it off again
//  * runs beside the real flow and can never change it: no attempt, reuse record, counter, ticket, message or specialist case is written,
//    a failure here is recorded and swallowed, and the customer-visible reply is computed independently
//  * stores only what is needed to judge ranking later: the ticket id, the size of the query (never its text), the ids and scores of the top
//    three eligible fixes, counts, latency and (once a specialist has solved the case) how closely the top fixes resembled the real solution
//  * scoped to one company and one service; rows are pruned after SHADOW_RETENTION_DAYS (default 30)
import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';
import { tokens } from './context.js';
import { recordKnowledgeEvent } from './knowledge-lifecycle.js';
import { botId } from './chatbots.js';

const now = () => new Date().toISOString();
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const overlap = (a, b) => {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
};

export function createShadow(store, memoryPool, config = {}) {
  const sql = store.db;
  const pending = new Set();
  const retentionDays = Number(config.SHADOW_RETENTION_DAYS) > 0 ? Math.min(365, Math.floor(Number(config.SHADOW_RETENTION_DAYS))) : 30;
  const MATCH = 0.5; // word overlap at which a ranked fix is said to resemble the solution a specialist actually used (a proxy, labelled as one)
  let lastPrune = 0;

  const isEnabled = (companyId, chatbotId) => Boolean(sql.prepare('SELECT enabled FROM shadow_settings WHERE company_id=? AND chatbot_id=?').get(companyId, chatbotId)?.enabled);

  function prune() {
    if (Date.now() - lastPrune < 3600000) return;
    lastPrune = Date.now();
    sql.prepare('DELETE FROM shadow_runs WHERE created_at<?').run(new Date(Date.now() - retentionDays * 86400000).toISOString());
  }

  /** Start a background ranking for this message. Returns immediately (null when shadow mode is off); never throws and never awaits. */
  function observe({ companyId, chatbotId, ticketId, text, factsText, fields = {} }) {
    try {
      if (!companyId || !chatbotId || !isEnabled(companyId, chatbotId)) return null;
      prune();
      const started = performance.now();
      const run = (async () => {
        let top = [], eligible = 0, withheld = 0, backend = null, error = null;
        try {
          const out = await memoryPool.retrieve({ companyId, chatbotId, text, factsText, fields, allowedOrigins: ['specialist_confirmed', 'company_db_sync', 'auto_published_overdue'] });
          eligible = out.eligible.length;
          withheld = out.withheld.length;
          backend = out.backend || null;
          top = out.eligible.slice(0, 3).map((e) => ({ id: e.id, score: round(e.finalScore), origin: e.row.origin_type, version: e.row.version_number }));
        } catch { error = 'Ranking failed in shadow mode; the live flow was not affected.'; }
        try {
          sql.prepare('INSERT INTO shadow_runs(id,company_id,chatbot_id,ticket_id,query_chars,top_json,eligible,withheld,latency_ms,backend,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), companyId, chatbotId, String(ticketId), String(text || '').length, JSON.stringify(top), eligible, withheld, Math.round(performance.now() - started), backend, error, now());
        } catch { /* a logging failure must never reach the customer */ }
      })().finally(() => pending.delete(run));
      pending.add(run);
      return run;
    } catch { return null; }
  }

  /** Resolves when every started observation has finished (used by tests and by shutdown). */
  const idle = () => Promise.allSettled([...pending]);

  /** A specialist solved this ticket: record how closely the shadow ranking's top fixes resembled the real solution. */
  function compare({ companyId, ticketId, resolutionText }) {
    try {
      const run = sql.prepare('SELECT * FROM shadow_runs WHERE company_id=? AND ticket_id=? AND compared_at IS NULL AND error IS NULL ORDER BY created_at DESC LIMIT 1').get(companyId, String(ticketId));
      if (!run) return null;
      const top = JSON.parse(run.top_json).map((item) => {
        const row = sql.prepare('SELECT steps_json FROM memory_pool WHERE id=? AND company_id=?').get(item.id, companyId);
        return { ...item, sim: round(overlap(row ? JSON.parse(row.steps_json).join(' ') : '', resolutionText), 2) };
      });
      sql.prepare('UPDATE shadow_runs SET top_json=?,agreement=?,compared_at=? WHERE id=?').run(JSON.stringify(top), top.length ? Math.max(...top.map((x) => x.sim)) : 0, now(), run.id);
      return { compared: true };
    } catch { return null; }
  }

  function report(companyId, chatbotId, { days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = sql.prepare('SELECT * FROM shadow_runs WHERE company_id=? AND chatbot_id=? AND created_at>=? ORDER BY created_at').all(companyId, chatbotId, since);
    const ok = rows.filter((r) => !r.error);
    const compared = ok.filter((r) => r.compared_at);
    const tops = compared.map((r) => JSON.parse(r.top_json));
    const rate = (n, d) => (d ? round(n / d, 3) : null);
    const latencies = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
    return {
      windowDays: days, enabled: isEnabled(companyId, chatbotId),
      runs: rows.length, failed: rows.length - ok.length,
      coverage: rate(ok.filter((r) => r.eligible > 0).length, ok.length),
      abstained: rate(ok.filter((r) => r.eligible === 0 && r.withheld === 0).length, ok.length),
      askedForMoreDetails: rate(ok.filter((r) => r.eligible === 0 && r.withheld > 0).length, ok.length),
      latencyMs: { median: latencies[Math.floor(latencies.length / 2)] ?? null, p95: latencies[Math.floor(latencies.length * 0.95)] ?? null },
      comparedWithSpecialistSolution: compared.length,
      top1ResemblesSolution: rate(tops.filter((t) => t[0]?.sim >= MATCH).length, compared.length),
      top3ResemblesSolution: rate(tops.filter((t) => t.some((x) => x.sim >= MATCH)).length, compared.length),
      note: 'Shadow results are measured on this company’s live traffic. “Resembles” is word overlap with the solution a specialist actually gave (a proxy, not a verdict). Nothing here was shown to customers.',
      storedPerRun: 'ticket id, query length, ids and scores of the top three fixes, counts and timing. Never the customer’s words.',
    };
  }

  async function handle(req, endpoint, session, send, { json }) {
    if (!endpoint.includes('/api/company/shadow')) return false;
    const profile = session.profile;
    if (!session.account_id || profile.role !== 'owner') throw fault(403, 'Only the company owner can manage shadow mode.');
    const bot = botId(profile);
    if (endpoint === 'GET /api/company/shadow') { send(200, { shadow: report(profile.companyId, bot) }); return true; }
    if (endpoint === 'POST /api/company/shadow') {
      const body = await json(req);
      if (body.confirmed !== true || typeof body.enabled !== 'boolean') throw fault(400, 'Confirm turning shadow mode on or off.');
      sql.prepare('INSERT INTO shadow_settings(company_id,chatbot_id,enabled,changed_by,changed_at) VALUES(?,?,?,?,?) ON CONFLICT(company_id,chatbot_id) DO UPDATE SET enabled=excluded.enabled,changed_by=excluded.changed_by,changed_at=excluded.changed_at')
        .run(profile.companyId, bot, body.enabled ? 1 : 0, profile.id, now());
      recordKnowledgeEvent(sql, { companyId: profile.companyId, chatbotId: bot, kind: body.enabled ? 'shadow_enabled' : 'shadow_disabled', actor: profile.id });
      send(200, { shadow: report(profile.companyId, bot) });
      return true;
    }
    throw fault(404, 'Shadow route not found.');
  }
  return { observe, idle, compare, report, handle, isEnabled };
}
