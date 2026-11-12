// Resolution Intelligence: company-scoped aggregates over real records only.
// Imported and standard content is never counted as a learned success, and
// overdue auto-published fixes are always reported separately from
// customer-confirmed ones.
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function intelligenceFor(store, companyId, { at = Date.now(), slaHours = 8, chatbotId = null } = {}) {
  const sql = store.db;
  const bots = sql.prepare('SELECT id FROM chatbots WHERE company_id=?').all(companyId).map((b) => b.id).filter((id) => !chatbotId || id === chatbotId);
  const botList = bots.length ? bots : ['-'];
  const inBots = `chatbot_id IN (${botList.map(() => '?').join(',')})`;
  const count = (where, ...args) => sql.prepare(`SELECT COUNT(*) n FROM memory_pool WHERE company_id=? AND ${inBots} AND ${where}`).get(companyId, ...botList, ...args).n;
  const knowledge = {
    customerConfirmedFixes: count("origin_type='specialist_confirmed' AND customer_confirmed=1 AND status IN ('active','flagged_for_review')"),
    autoPublishedUnconfirmed: count("origin_type='auto_published_overdue' AND customer_confirmed=0 AND status IN ('active','flagged_for_review')"),
    importedRecords: count("origin_type='company_db_sync' AND status IN ('active','flagged_for_review')"),
    standardPlaybooks: count("origin_type='standard_playbook' AND status IN ('active','flagged_for_review')"),
    flaggedForReview: count("status='flagged_for_review'"),
    superseded: count("status='superseded'"),
    retired: count("status='retired'"),
    versionsPublished: count("version_number>1"),
  };
  // Reuse outcomes are counted per customer attempt, not per passport counter,
  // and only from reusable-knowledge suggestions (learned), never from playbooks.
  const attempt = (source, outcome) => sql.prepare(`SELECT COUNT(*) n FROM troubleshooting_attempts WHERE company_id=? AND ${inBots} AND source=? AND outcome=?`).get(companyId, ...botList, source, outcome).n;
  const origin = (o) => sql.prepare(`SELECT COUNT(*) n FROM troubleshooting_attempts a JOIN memory_pool m ON m.id=a.memory_id AND m.company_id=a.company_id WHERE a.company_id=? AND a.${inBots} AND a.source='learned' AND a.outcome='succeeded' AND m.origin_type=?`).get(companyId, ...botList, o).n;
  const reuse = {
    memorySucceeded: attempt('learned', 'succeeded'),
    memoryFailed: attempt('learned', 'failed'),
    memoryPending: attempt('learned', 'pending'),
    standardSucceeded: attempt('standard', 'succeeded'),
    standardFailed: attempt('standard', 'failed'),
    memorySucceededBySource: {
      specialistConfirmed: origin('specialist_confirmed'),
      autoPublishedUnconfirmed: origin('auto_published_overdue'),
      imported: origin('company_db_sync'),
    },
  };
  const data = store.data;
  const handoffs = data.handoffs.filter((h) => h.companyId === companyId && (!chatbotId || h.chatbotId === chatbotId));
  const audit = data.audit;
  const firstResponse = [], resolution = [];
  for (const h of handoffs) {
    const created = Date.parse(h.createdAt);
    if (!Number.isFinite(created)) continue;
    const mine = audit.filter((a) => a.scope === h.scope && a.ticketId === h.ticketId && Date.parse(a.createdAt) >= created);
    const first = mine.filter((a) => ['assignment', 'progress', 'solution_proposed'].includes(a.kind)).map((a) => Date.parse(a.createdAt)).sort((a, b) => a - b)[0];
    if (first) firstResponse.push(first - created);
    const done = mine.filter((a) => a.kind === 'customer_confirmation' && /worked\.$/.test(a.note || '') && !/did not/.test(a.note || '')).map((a) => Date.parse(a.createdAt)).sort((a, b) => a - b)[0];
    if (done) resolution.push(done - created);
  }
  const taskCount = (where, ...args) => sql.prepare(`SELECT COUNT(*) n FROM follow_through_tasks WHERE company_id=? AND ${inBots.replace('chatbot_id', 'COALESCE(chatbot_id,\'-\')')} AND ${where}`).get(companyId, ...botList, ...args).n;
  const nowIso = new Date(at).toISOString();
  const queuedPastSla = handoffs.filter((h) => h.status === 'Queued' && !h.assignedTo && Date.parse(h.createdAt) + slaHours * 3600000 <= at).length;
  const followThrough = {
    slaHours,
    pendingConfirmations: taskCount("task_type='customer_confirmation_wait' AND status='pending'"),
    overdueConfirmations: taskCount("task_type='customer_confirmation_wait' AND status='pending' AND deadline_at<=?", nowIso),
    autoPublished: taskCount("status='auto_published'"),
    escalatedWithoutPublication: taskCount("task_type='customer_confirmation_wait' AND status='escalated'"),
    slaBreaches: queuedPastSla,
    pendingFixReviews: taskCount("task_type='failed_fix_review' AND status='pending'"),
    openCases: handoffs.filter((h) => !['Resolved', 'Closed'].includes(h.status)).length,
  };
  const confirmed = data.resolutions.filter((r) => r.companyId === companyId && (!chatbotId || r.chatbotId === chatbotId));
  const resolutions = {
    proposed: confirmed.length,
    confirmedByCustomer: confirmed.filter((r) => r.customerAccepted === true).length,
    rejectedByCustomer: confirmed.filter((r) => r.customerAccepted === false).length,
    awaitingCustomer: confirmed.filter((r) => r.status === 'pending_confirmation').length,
  };
  const empty = !Object.values(knowledge).some(Boolean) && !handoffs.length && !resolutions.proposed;
  return {
    companyId,
    generatedAt: nowIso,
    empty,
    knowledge,
    resolutions,
    reuse,
    followThrough,
    responseTimes: {
      meanFirstSpecialistResponseMs: mean(firstResponse),
      meanTimeToCustomerConfirmedResolutionMs: mean(resolution),
      samples: { firstResponse: firstResponse.length, confirmedResolution: resolution.length },
    },
    notes: [
      'Standard playbooks and imported records are not counted as learned successes.',
      'Overdue auto-published fixes are UNCONFIRMED BY CUSTOMER and are reported separately.',
      'Figures come from this company’s own records; synthetic tests do not represent real business impact.',
    ],
  };
}
