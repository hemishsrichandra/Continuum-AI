// Plain-language system status for company owners, with technical detail kept separate.
// An application service: it reads from the index, privacy and worker services and exposes nothing from other companies.
/**
 * Reconcile this company's outbound provider jobs (customer outcomes, handoffs and requests sent to the company's ticket system).
 * A job can fail without anyone noticing: it exhausted its retries ("failed"), it sits "pending" long after it was due because no worker is
 * running, or a worker took it ("processing") and its lease ran out. Counts only; never the job's content.
 */
export function reconcileJobs(store, companyId, { at = Date.now(), overdueMs = 15 * 60000 } = {}) {
  const row = store.db.prepare(`SELECT
      SUM(status='failed') failed,
      SUM(status='pending' AND next_attempt < ?) overdue,
      SUM(status='processing' AND lease_until < ?) abandoned,
      SUM(status='pending') pending,
      MIN(CASE WHEN status='pending' AND next_attempt < ? THEN next_attempt END) oldest
    FROM provider_jobs WHERE company_id=?`).get(at - overdueMs, at, at - overdueMs, companyId);
  const failed = row.failed || 0, overdue = row.overdue || 0, abandoned = row.abandoned || 0;
  return { failed, overdue, abandoned, pending: row.pending || 0, oldestOverdueMinutes: row.oldest ? Math.round((at - row.oldest) / 60000) : null, needsAttention: failed + overdue + abandoned };
}

export function createSystemHealth({ store, vectorIndex, privacy, delivery }) {
  return async function systemHealth(companyId) {
    const infra = await vectorIndex.health({ probe: true });
    const mine = vectorIndex.companyHealth(companyId);
    const waitingApproval = store.db
      .prepare("SELECT COUNT(*) AS n FROM memory_pool WHERE company_id=? AND status='flagged_for_review' AND locally_reviewed=0 AND origin_type='company_db_sync'")
      .get(companyId).n;
    const search = !infra.vectorStore.enabled ? 'basic' : !infra.vectorStore.ok ? 'limited' : mine.failed ? 'attention' : mine.pending ? 'updating' : 'ready';
    const erasure = privacy.erasureStatus(companyId);
    const lanes = delivery.lanes();
    const stuck = lanes.filter((l) => l.lastError).length;
    const jobs = reconcileJobs(store, companyId);
    return {
      summary: {
        search: { state: search, pending: mine.pending },
        waitingApproval,
        tasks: { state: stuck || erasure.failed || mine.failed || jobs.needsAttention ? 'attention' : 'ok', count: stuck + erasure.failed + mine.failed + jobs.needsAttention },
        syncedUpdates: { state: jobs.needsAttention ? 'attention' : 'ok', failed: jobs.failed, overdue: jobs.overdue + jobs.abandoned },
      },
      details: {
        database: infra.sqlite,
        vectorIndex: { configured: infra.vectorStore.enabled, reachable: Boolean(infra.vectorStore.ok), error: infra.vectorStore.error || null },
        embedding: { provider: infra.embedding.provider, model: infra.embedding.model, neural: infra.embedding.neural },
        knowledge: mine,
        workers: lanes.map(({ name, running, lastError, lastDurationMs }) => ({ name, running, lastError, lastDurationMs })),
        erasure: { pending: erasure.pending, failed: erasure.failed },
        providerJobs: jobs,
      },
    };
  };
}
