// Customer actions that change a service request: request, requirement, book, cancel, handoff and outcome.
import { botId } from '../chatbots.js';
import { fault } from '../providers.js';
import { field, flags, json, submission, summary, appointment } from '../requests.js';
import { timeZone } from '../scheduling.js';

export function createActionRoutes(services) {
  const { store, delivery, memory, providerActions, followThrough, reuse, troubleshooting, once, retain } = services;
  return async function actionRoutes(context) {
    const { req, url, endpoint, session, profile, selectedBot, write, db } = context;
    const actionRoutes = {
      '/api/request': 'request',
      '/api/requirement': 'requirement',
      '/api/book': 'book',
      '/api/book/cancel': 'cancel',
      '/api/handoff': 'handoff',
      '/api/outcome': 'outcome',
    };
    const kind = actionRoutes[url.pathname];
    if (req.method === 'POST' && kind) {
      if (!selectedBot.allowedActions.includes(kind)) throw fault(403,'This service does not permit that action.');
      const body = await json(req);
      flags(body);
      if (body.confirmed !== true)
        throw fault(400, 'Review the details and explicitly confirm before submitting.');
      const ticketId = kind === 'request' ? undefined : db.ticket(body.ticketId).id;
      const operation = submission(req, body, endpoint);
      return write(
        201,
        await once(db.scope, operation, async () => {
          let data;
          if (kind === 'request')
            data = {
              title: field(body.title, 'title', 100),
              issueDesc: field(body.issueDesc, 'description'),
            };
          if (kind === 'requirement') data = { note: field(body.note, 'note') };
          if (kind === 'book') data = { datetime: appointment(body.datetime) };
          if (kind === 'cancel') data = { id: field(body.id, 'appointment ID', 100) };
          if (kind === 'handoff')
            data = {
              summary: field(body.summary, 'handoff summary', 1400),
              context: {
                ticket: db.ticket(ticketId),
                history: db
                  .history()
                  .filter((item) => item.ticketId === ticketId)
                  .slice(0, 10)
                  .map(({ kind, createdAt }) => ({ kind, createdAt })),
                memories:
                  body.memory === false
                    ? []
                    : memory
                        .list(db.scope, ticketId)
                        .filter((item) => !item.invalidatedAt)
                        .slice(0, 8),
                conversation: store.dataFor(profile.companyId).conversations
                  .filter((c) => c.scope === db.scope && c.ticketId === ticketId && !c.archivedAt)
                  .slice(-50)
                  .map((c) => ({ question: c.message, answer: c.response.reply, createdAt: c.createdAt })),
              },
            };
          if (kind === 'outcome') {
            if(troubleshooting.attempts(profile,{id:ticketId}).some(a=>a.outcome==='pending'))
              throw fault(409,'Use It worked or Still need help on the pending fix so its outcome is recorded correctly.');
            if (db.ticket(ticketId).handoffs.some((h) => h.status === 'Awaiting confirmation'))
              throw fault(409, 'Confirm or reject the pending specialist solution before recording another outcome.');
            const outcome = field(body.outcome, 'outcome', 20);
            if (!['failed', 'resolved', 'missed'].includes(outcome))
              throw fault(400, 'Select a valid outcome.');
            data = { outcome, note: field(body.note, 'outcome details') };
          }
          if (body.proposalId) {
            const proposalId = field(body.proposalId, 'proposal ID', 100);
            const exchange = store.dataFor(profile.companyId).conversations.find(
              (c) => c.scope === db.scope && c.id === proposalId,
            );
            if (
              !exchange ||
              exchange.ticketId !== db.ticket(body.ticketId).id ||
              exchange.response.action?.kind !== kind
            )
              throw fault(404, 'This proposed action was not found for this request.');
            if (exchange.response.action.completedAt)
              throw fault(409, 'This proposed action has already been confirmed.');
            if (
              exchange.response.action.failedUseId &&
              exchange.response.action.failedUseId !== body.failedUseId
            )
              throw fault(400, 'Confirm the failed recommendation shown in this proposal.');
            operation.proposalId = proposalId;
          }
          if (kind === 'handoff' && body.failedUseId) {
            const attempt=store.db.prepare('SELECT id FROM troubleshooting_attempts WHERE use_id=? AND company_id=? AND chatbot_id=? AND customer_id=?').get(body.failedUseId,profile.companyId,botId(profile),profile.id);
            const feedback = {
              useId: body.failedUseId,
              ticketId,
              worked: false,
              confirmed: true,
              note: data.summary,
              memory: body.memory,
            };
            const reviewed = attempt ? await troubleshooting.feedback(profile,{...feedback,attemptId:attempt.id}) : await reuse.feedback(profile,feedback);
            const saved = {
              success: true,
              id: reviewed.handoffId,
              ticketId,
              createdAt: new Date().toISOString(),
            };
            return store.update((data) => {
              if (operation.proposalId) {
                const c = data.conversations.find(
                  (c) => c.id === operation.proposalId && c.scope === db.scope,
                );
                c.response.action.completedAt = saved.createdAt;
                c.response.action.resultId = saved.id;
              }
              if (operation.key) data.operations.push({ scope: db.scope, ...operation, response: saved });
              return saved;
            });
          }
          if (
            kind === 'book' &&
            !(await delivery.available(session.account_id, [{ id: data.datetime }])).length
          )
            throw fault(409, 'Your calendar is busy at that time. Choose another slot.');
          const result = store.db
            .transaction(() => {
              const saved = db.commit(kind, data, ticketId, operation);
              if (kind === 'book' || kind === 'cancel') {
                const booking = store.dataFor(profile.companyId).bookings.find(
                  (b) => b.id === (kind === 'cancel' ? saved.bookingId : saved.id),
                );
                delivery.queueBooking(session.account, booking, kind === 'cancel');
              }
              const providerDelivery = providerActions.enqueue(
                profile,
                kind,
                saved.id,
                saved.ticketId,
                data,
              );
              return { ...saved, providerDelivery };
            })
            .immediate();
          if (kind === 'request')
            followThrough.log({ companyId: profile.companyId, chatbotId: botId(profile), ticketId: result.ticketId, customerId: profile.id, kind: 'request_opened', detail: { title: data.title }, actor: 'customer' });
          const text = {
            request: 'A service request was opened: ' + data.title + '.',
            requirement: 'A confirmed requirement was added: ' + data.note,
            book:
              kind === 'book'
                ? 'A visit was booked for ' +
                  new Intl.DateTimeFormat('en-IN', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone,
                  }).format(new Date(data.datetime)) +
                  ' IST.'
                : '',
            cancel:
              kind === 'cancel'
                ? 'The visit on ' +
                  new Intl.DateTimeFormat('en-IN', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone,
                  }).format(new Date(result.datetime)) +
                  ' IST was cancelled.'
                : '',
            handoff: 'A human handoff was queued under ' + result.id + '.',
            outcome: data.note,
          }[kind];
          const retained =
            body.memory === false
              ? null
              : await retain({
                  id: 'action-' + result.id,
                  scope: db.scope,
                  ticketId: result.ticketId,
                  kind:
                    kind === 'outcome'
                      ? data.outcome
                      : kind === 'requirement' && /call|prefer|email|notify/i.test(data.note)
                        ? 'preference'
                        : 'action',
                  text,
                  createdAt: result.createdAt,
                });
          const response = {
            success: true,
            ...result,
            retained,
            ...(kind === 'book' && { confirmedAt: result.createdAt }),
          };
          if (operation.key)
            store.update((data) => {
              data.operations.find((o) => o.scope === db.scope && o.key === operation.key).response =
                response;
            });
          return response;
        }),
      );
    }
  };
}
