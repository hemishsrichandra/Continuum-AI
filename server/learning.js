import { botId, defaultBotId, knowledgeScope, privateScope } from './chatbots.js';
import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';
import { field } from './requests.js';
import { compatibility, resolutionSignature } from './context.js';
import { rankRelevance } from './relevance.js';
import { needsReview, failedResolutions } from './reuse.js';

export function createLearning(store, memory, companies, config = {}, reuse, providerActions) {
  const scope = (companyId, provider, chatbotId = defaultBotId(companyId,provider)) => knowledgeScope(companyId,chatbotId);
  function caseFor(data, staff, id, revision) {
    const h = data.handoffs.find(
      (h) =>
        h.id === id &&
        h.companyId === staff.companyId &&
        h.chatbotId === botId(staff) &&
        (h.provider || h.scope.split(':')[1]) === staff.provider,
    );
    if (!h) throw fault(404, 'Case not found in your company and service workspace.');
    if (revision !== (h.revision || 0)) throw fault(409, 'This case changed. Refresh before saving.');
    if (h.assignedTo && h.assignedTo !== staff.id && staff.role !== 'owner')
      throw fault(403, 'Only the assigned specialist or owner can update this case.');
    return h;
  }
  function rowFor(data, h, provider) {
    const row = data[provider].find(
      (r) => r.companyId === h.companyId && r.chatbotId === h.chatbotId && (r.ticket_id || r.id) === h.ticketId,
    );
    if (!row) throw fault(404, 'Request not found.');
    return row;
  }
  function setStatus(row, provider, value, now) {
    row[provider === 'repair' ? 'status' : 'state'] = value;
    row.updatedAt = now;
  }
  function event(data, h, kind, note, now) {
    data.audit.push({ id: randomUUID(), scope: h.scope, ticketId: h.ticketId, kind, note, createdAt: now });
  }
  function followup(data, h, text, now, resolutionId) {
    data.conversations.push({
      id: randomUUID(),
      scope: h.scope,
      ticketId: h.ticketId,
      system: true,
      message: '[Specialist update]',
      createdAt: now,
      response: {
        human: true,
        resolutionId,
        reply: text,
        model: 'Human specialist',
        evidence: [],
        trace: { memory: 'Human specialist', recalled: 0 },
      },
    });
  }
  function change(staff, operation, work) {
    const key = `operator:${staff.companyId}:${staff.id}`;
    return store.update((data) => {
      const previous =
        operation?.key && data.operations.find((o) => o.scope === key && o.key === operation.key);
      if (previous) {
        if (previous.fingerprint !== operation.fingerprint) throw fault(409, 'Submission details changed.');
        return previous.response;
      }
      const result = work(data);
      if (operation?.key) data.operations.push({ scope: key, ...operation, response: result });
      return result;
    });
  }
  async function publish(item) {
    const sync = await memory.remember({
      id: item.memoryId,
      scope: scope(item.companyId, item.provider, item.chatbotId),
      ticketId: 'knowledge',
      kind: 'verified_resolution',
      resolutionId: item.id,
      text: `Human-verified resolution: ${item.title}\nApplicable environment: ${item.environment}\nMatching symptoms: ${item.symptoms}\nVerified steps: ${item.solution}`,
      createdAt: item.publishedAt || item.createdAt,
    });
    store.update((data) => {
      data.resolutions.find((r) => r.id === item.id).sync = sync;
    });
    return sync;
  }
  return {
    async recall(companyId, provider, message, ticket = {}, customerId, chatbotId = defaultBotId(companyId,provider)) {
      const result = await memory.recall(scope(companyId, provider, chatbotId), 'knowledge', message);
      const active = store.data.resolutions.filter(
        (r) =>
          r.companyId === companyId &&
          r.provider === provider &&
          r.chatbotId === chatbotId &&
          !r.retiredAt &&
          r.allowMemoryPublication !== false && (!r.status || r.status === 'published'),
      );
      const linked = result.facts
        .map((f) => ({ f, r: active.find((r) => r.memoryId === f.id) }))
        .filter((x) => x.r);
      const fits = new Map(
        linked.map(({ r }) => [
          r.id,
          compatibility(r.environment, message + '\n' + (ticket.title || '') + '\n' + (ticket.issue || '')),
        ]),
      );
      const candidates = linked.filter(({ r }) => !fits.get(r.id).conflicts.length);
      const scores = await rankRelevance(
        candidates.map((x) => x.r),
        message,
        result.source,
        config,
      );
      const matches = [],
        clarification = [];
      const failed = customerId
        ? failedResolutions(store, companyId, provider, customerId, chatbotId)
        : { ids: new Set(), signatures: new Set() };
      let reviewRequired = false,
        failedBefore = false;
      for (const { f, r } of candidates) {
        if (!scores.has(r.id)) continue;
        const fit = fits.get(r.id);
        if (!fit.compatible) {
          clarification.push({ id: r.id, title: r.title, environment: r.environment, missing: fit.missing });
          continue;
        }
        if (needsReview(r)) {
          reviewRequired = true;
          continue;
        }
        if (failed.ids.has(r.id) || failed.signatures.has(resolutionSignature(r))) {
          failedBefore = true;
          continue;
        }
        matches.push({
          ...f,
          kind: 'verified_resolution',
          resolutionId: r.id,
          score: scores.get(r.id),
          environment: r.environment,
          solution: r.solution,
          title: r.title,
        });
      }
      const selected = matches.sort((a, b) => b.score - a.score).slice(0, 3);
      const conflicting = selected.length > 1 && new Set(selected.map((f) => f.text)).size > 1;
      return {
        source: result.source,
        reviewRequired,
        failedBefore,
        facts: conflicting ? [] : selected,
        clarification: conflicting
          ? [{ environment: 'Multiple reviewed fixes match. Ask your service team which applies.' }]
          : clarification.slice(0, 3),
      };
    },
    list(companyId, provider, chatbotId = defaultBotId(companyId,provider)) {
      const data = store.data;
      return data.resolutions
        .filter((r) => r.companyId === companyId && r.provider === provider && r.chatbotId === chatbotId)
        .map(({ authorId, ...r }) => {
          const m = data.memories.find((m) => m.id === r.memoryId);
          return {
            ...r,
            reviewRequired: needsReview(r),
            reuse: reuse?.stats(companyId, provider, r.id) || { pending: 0, succeeded: 0, failed: 0 },
            sync: r.retiredAt
              ? m?.syncPending
                ? 'retirement pending'
                : 'retired'
              : m?.syncedTo
                ? 'synced'
                : r.sync,
          };
        });
    },
    assign(staff, body, operation) {
      if (body.confirmed !== true) throw fault(400, 'Confirm the assignment.');
      return change(staff, operation, (data) => {
        const h = caseFor(data, staff, field(body.handoffId, 'case ID', 100), body.revision);
        if (h.status === 'Resolved') throw fault(409, 'This case is resolved.');
        const target = field(body.assignedTo, 'specialist', 100);
        if (target !== staff.id && staff.role !== 'owner')
          throw fault(403, 'Only the owner can assign another specialist.');
        if (!companies.roster(staff).some((a) => a.id === target))
          throw fault(400, 'Choose a specialist in this company and service workspace.');
        h.assignedTo = target;
        const assignedRow = rowFor(data, h, staff.provider);
        assignedRow[staff.provider === 'repair' ? 'assigned_to' : 'owner'] =
          companies.roster(staff).find((a) => a.id === target).name;
        h.status = 'In progress';
        h.revision = (h.revision || 0) + 1;
        const now = new Date().toISOString();
        setStatus(rowFor(data, h, staff.provider), staff.provider, h.status, now);
        event(data, h, 'assignment', 'A specialist was assigned.', now);
        return { success: true, revision: h.revision };
      });
    },
    progress(staff, body, operation) {
      if (body.confirmed !== true) throw fault(400, 'Confirm the progress update.');
      const note = field(body.note, 'customer-visible update', 2000);
      if (!['In progress', 'Waiting for parts', 'Awaiting customer'].includes(body.status))
        throw fault(400, 'Choose a valid status.');
      if (
        body.eta &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(body.eta) ||
          !Number.isFinite(+new Date(body.eta)) ||
          new Date(body.eta).toISOString().slice(0, 10) !== body.eta)
      )
        throw fault(400, 'Enter a valid ETA date.');
      if (body.stepOutcome && !['attempted', 'failed', 'succeeded'].includes(body.stepOutcome))
        throw fault(400, 'Choose a valid step outcome.');
      if (body.priority && !['Normal', 'High', 'Urgent'].includes(body.priority))
        throw fault(400, 'Choose a valid priority.');
      return change(staff, operation, (data) => {
        const h = caseFor(data, staff, field(body.handoffId, 'case ID', 100), body.revision);
        if (!h.assignedTo || ['Resolved', 'Awaiting confirmation'].includes(h.status))
          throw fault(409, 'Claim an active case before updating it.');
        const now = new Date().toISOString(),
          row = rowFor(data, h, staff.provider);
        h.status = body.status;
        h.revision++;
        h.updatedAt = now;
        setStatus(row, staff.provider, body.status, now);
        if (body.eta !== undefined)
          row[staff.provider === 'repair' ? 'eta_date' : 'target_resolution'] = body.eta || null;
        if (body.priority) row.priority = body.priority;
        row[staff.provider === 'repair' ? 'assigned_to' : 'owner'] =
          companies.roster(staff).find((a) => a.id === h.assignedTo)?.name || 'Service team';
        h.troubleshooting ||= [];
        if (body.step) {
          const step = field(body.step, 'troubleshooting step', 1000);
          h.troubleshooting.push({
            id: randomUUID(),
            step,
            outcome: body.stepOutcome || 'attempted',
            authorId: staff.id,
            createdAt: now,
          });
          if (body.stepOutcome === 'failed')
            data.memories.push({
              id: randomUUID(),
              scope: h.scope,
              ticketId: h.ticketId,
              kind: 'failed',
              text: 'Specialist step failed: ' + step,
              createdAt: now,
            });
        }
        followup(data, h, note, now);
        event(data, h, 'progress', note, now);
        return { success: true, revision: h.revision };
      });
    },
    async resolve(staff, body, operation) {
      if (body.confirmed !== true || body.reviewedForPrivacy !== true)
        throw fault(400, 'Confirm the solution and review reusable content for private data.');
      const title = field(body.title, 'title', 100),
        symptoms = field(body.symptoms, 'symptoms', 1000),
        environment = field(body.environment, 'product and versions', 500),
        solution = field(body.solution, 'solution steps', 2000);
      if (
        /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{10,}\b|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]/i.test(
          [title, symptoms, environment, solution].join('\n'),
        )
      )
        throw fault(400, 'Remove identifying information and credentials from shared knowledge.');
      return change(staff, operation, (data) => {
        const h = caseFor(data, staff, field(body.handoffId, 'case ID', 100), body.revision);
        if (
          !h.assignedTo ||
          h.status === 'Resolved' ||
          data.resolutions.some((r) => r.id === h.resolutionId && r.status !== 'rejected')
        )
          throw fault(409, 'Claim the case and wait for the current solution to be reviewed.');
        const now = new Date().toISOString(),
          r = {
            id: randomUUID(),
            companyId: staff.companyId,
            provider: staff.provider,
            chatbotId: botId(staff),
            title,
            symptoms,
            environment,
            solution,
            authorId: staff.id,
            handoffId: h.id,
            createdAt: now,
            status: 'pending_confirmation',
            sync: 'awaiting customer',
          };
        r.memoryId = 'resolution-' + r.id;
        h.resolutionId = r.id;
        h.status = 'Awaiting confirmation';
        h.revision++;
        setStatus(rowFor(data, h, staff.provider), staff.provider, h.status, now);
        data.resolutions.push(r);
        followup(data, h, solution, now, r.id);
        event(
          data,
          h,
          'solution_proposed',
          'A specialist proposed a solution for customer confirmation.',
          now,
        );
        return { ...r };
      });
    },
    async confirm(profile, body) {
      if (body.confirmed !== true || typeof body.accepted !== 'boolean')
        throw fault(400, 'Confirm whether the solution worked.');
      const result = store.update((data) => {
        const r = data.resolutions.find((r) => r.id === body.id && r.companyId === profile.companyId);
        const h =
          r &&
          data.handoffs.find(
            (h) =>
              h.id === r.handoffId && h.scope === privateScope(profile),
          );
        if (!r || !h) throw fault(404, 'Solution not found in your account.');
        if (r.status !== 'pending_confirmation') {
          if (r.customerAccepted === body.accepted) return { ...r };
          throw fault(409, 'This solution was already reviewed.');
        }
        const now = new Date().toISOString();
        r.customerAccepted = body.accepted;
        r.allowMemoryPublication = body.memory !== false;
        r.confirmedAt = now;
        r.status = body.accepted ? r.allowMemoryPublication ? 'published' : 'confirmed_private' : 'rejected';
        r.publishedAt = body.accepted && r.allowMemoryPublication ? now : null;
        r.sync = body.accepted && r.allowMemoryPublication ? 'pending' : 'not published';
        h.status = body.accepted ? 'Resolved' : 'In progress';
        h.revision++;
        setStatus(
          rowFor(data, h, profile.provider),
          profile.provider,
          body.accepted ? 'Resolved' : 'Reopened',
          now,
        );
        const note = body.note
          ? field(body.note, 'outcome note', 1000)
          : body.accepted
            ? 'Customer confirmed the specialist solution worked.'
            : 'Customer reported the specialist solution did not work.';
        if (body.memory !== false) data.memories.push({
          id: randomUUID(),
          scope: h.scope,
          ticketId: h.ticketId,
          kind: body.accepted ? 'resolved' : 'failed',
          resolutionId: r.id,
          text: note,
          createdAt: now,
        });
        event(data, h, 'customer_confirmation', note, now);
        providerActions?.enqueue(profile, 'outcome', r.id, h.ticketId, {
          outcome: body.accepted ? 'resolved' : 'failed',
          note,
        });
        return { ...r };
      });
      const sync = result.status === 'published' && result.allowMemoryPublication !== false && !result.retiredAt ? await publish(result) : result.sync;
      return { success: true, status: result.status, sync };
    },
    async retire(staff, body) {
      const item = store.data.resolutions.find(
        (r) => r.id === body.id && r.companyId === staff.companyId && r.provider === staff.provider && r.chatbotId === botId(staff),
      );
      if (!item) throw fault(404, 'Resolution not found.');
      if (body.confirmed !== true) throw fault(400, 'Confirm retiring this resolution.');
      store.update((data) => {
        data.resolutions.find((r) => r.id === item.id).retiredAt ||= new Date().toISOString();
      });
      if (store.data.memories.some((m) => m.id === item.memoryId))
        await memory.invalidate(scope(staff.companyId, staff.provider, botId(staff)), 'knowledge', item.memoryId);
      return { success: true };
    },
  };
}
