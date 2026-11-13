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
  const data = store.dataFor(companyId);
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
  // Self-service: of the requests where the assistant suggested at least one fix, how many a customer confirmed solved
  // without any specialist hand-off. Only an explicit "It worked" counts; silence is never success.
  const tickets = sql.prepare(`SELECT ticket_id, MAX(outcome='succeeded') solved FROM troubleshooting_attempts WHERE company_id=? AND ${inBots} AND source IN ('standard','learned') GROUP BY ticket_id`).all(companyId, ...botList);
  const handedOff = new Set(handoffs.map((h) => h.ticketId));
  const solvedAlone = tickets.filter((t) => t.solved && !handedOff.has(t.ticket_id)).length;
  const selfService = {
    requestsWithSuggestions: tickets.length,
    solvedWithoutSpecialist: solvedAlone,
    solvedAfterSpecialist: tickets.filter((t) => handedOff.has(t.ticket_id)).length,
    deflectionRate: tickets.length ? Math.round((solvedAlone / tickets.length) * 1000) / 1000 : null,
  };
  // The fixes that solved the most customer problems, with their failures shown beside them.
  const topFixes = sql.prepare(`SELECT id,title,origin_type,customer_confirmed,reuse_success_count successes,reuse_failure_count failures FROM memory_pool WHERE company_id=? AND ${inBots} AND status='active' AND reuse_success_count>0 ORDER BY reuse_success_count DESC, reuse_failure_count ASC LIMIT 5`)
    .all(companyId, ...botList).map((r) => ({ id: r.id, title: r.title, origin: r.origin_type, customerConfirmed: Boolean(r.customer_confirmed), successes: r.successes, failures: r.failures }));
  const empty = !Object.entries(knowledge).some(([k, v]) => k !== 'standardPlaybooks' && v) && !handoffs.length && !resolutions.proposed;
  return {
    companyId,
    generatedAt: nowIso,
    empty,
    knowledge,
    resolutions,
    reuse,
    selfService,
    topFixes,
    followThrough,
    responseTimes: {
      meanFirstSpecialistResponseMs: mean(firstResponse),
      meanTimeToCustomerConfirmedResolutionMs: mean(resolution),
      samples: { firstResponse: firstResponse.length, confirmedResolution: resolution.length },
    },
    notes: [
      'Standard playbooks and imported records are not counted as learned successes.',
      'Overdue auto-published fixes are UNCONFIRMED BY CUSTOMER and are reported separately.',
      '“Solved without a specialist” counts requests where a customer said a suggested fix worked and no specialist was involved, out of the requests where a fix was suggested. Requests where the customer never answered are not counted as solved.',
      'Figures come from this company’s own records; synthetic tests do not represent real business impact.',
    ],
  };
}
