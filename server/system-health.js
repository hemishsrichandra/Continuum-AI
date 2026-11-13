// Plain-language system status for company owners, with technical detail kept separate.
// An application service: it reads from the index, privacy and worker services and exposes nothing from other companies.
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
    return {
      summary: {
        search: { state: search, pending: mine.pending },
        waitingApproval,
        tasks: { state: stuck || erasure.failed || mine.failed ? 'attention' : 'ok', count: stuck + erasure.failed + mine.failed },
      },
      details: {
        database: infra.sqlite,
        vectorIndex: { configured: infra.vectorStore.enabled, reachable: Boolean(infra.vectorStore.ok), error: infra.vectorStore.error || null },
        embedding: { provider: infra.embedding.provider, model: infra.embedding.model, neural: infra.embedding.neural },
        knowledge: mine,
        workers: lanes.map(({ name, running, lastError, lastDurationMs }) => ({ name, running, lastError, lastDurationMs })),
        erasure: { pending: erasure.pending, failed: erasure.failed },
      },
    };
  };
}
