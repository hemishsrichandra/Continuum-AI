import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';

export const providerKinds = ['request', 'requirement', 'handoff', 'outcome', 'progress'];
export function createProviderActions(store, delivery, config) {
  const sql = store.db,
    worker = randomUUID();
  let timer,
    running = false,
    stopped = false;
  const allowed = new Set(
    (config.PROVIDER_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const view = (row) =>
    row
      ? {
          id: row.id,
          actionId: row.action_id,
          ticketId: row.ticket_id,
          kind: row.kind,
          status: row.status,
          error: row.last_error,
          providerRef: row.provider_ref,
        }
      : null;
  function enqueue(profile, kind, actionId, ticketId, details) {
    const connection = sql
      .prepare('SELECT * FROM provider_connections WHERE company_id=? AND writes_enabled=1')
      .get(profile.companyId);
    const customer = sql
      .prepare('SELECT external_id FROM external_customers WHERE company_id=? AND account_id=?')
      .get(profile.companyId, profile.id);
    if (!connection || !customer || !JSON.parse(connection.capabilities).includes(kind)) return null;
    const ticket = store.data[profile.provider].find(
      (r) =>
        r.companyId === profile.companyId &&
        (r.customer_id || r.user_id) === profile.id &&
        (r.ticket_id || r.id) === ticketId,
    );
    if (!ticket) throw fault(404, 'Provider action ticket not found.');
    if (
      kind !== 'request' &&
      !ticket.externalId &&
      !sql
        .prepare(
          "SELECT 1 FROM provider_jobs WHERE company_id=? AND account_id=? AND ticket_id=? AND kind='request'",
        )
        .get(profile.companyId, profile.id, ticketId)
    )
      return null;
    const id = randomUUID(),
      now = new Date().toISOString();
    const payload = delivery.seal({ actionId, kind, localTicketId: ticketId, details }, 'provider-job:' + id);
    sql
      .prepare(
        'INSERT INTO provider_jobs(id,company_id,account_id,provider,ticket_id,action_id,kind,customer_id,payload,config_revision,next_attempt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,account_id,kind,action_id) DO NOTHING',
      )
      .run(
        id,
        profile.companyId,
        profile.id,
        profile.provider,
        ticketId,
        actionId,
        kind,
        customer.external_id,
        payload,
        connection.revision,
        Date.now(),
        now,
      );
    return view(
      sql
        .prepare('SELECT * FROM provider_jobs WHERE company_id=? AND account_id=? AND kind=? AND action_id=?')
        .get(profile.companyId, profile.id, kind, actionId),
    );
  }
  async function flush() {
    if (running || stopped) return;
    running = true;
    try {
      for (let n = 0; n < 10 && !stopped; n++) {
        const job = sql
          .transaction(() => {
            const row = sql
              .prepare(
                "SELECT * FROM provider_jobs WHERE (status='pending' AND next_attempt<=?) OR (status='processing' AND lease_until<?) ORDER BY created_at,rowid LIMIT 1",
              )
              .get(Date.now(), Date.now());
            if (!row) return null;
            sql
              .prepare(
                "UPDATE provider_jobs SET status='processing',worker=?,attempts=attempts+1,lease_until=? WHERE id=?",
              )
              .run(worker, Date.now() + 60000, row.id);
            return { ...row, worker, attempts: row.attempts + 1 };
          })
          .immediate();
        if (!job) break;
        try {
          const connection = sql
            .prepare('SELECT * FROM provider_connections WHERE company_id=?')
            .get(job.company_id);
          const linked = sql
            .prepare('SELECT external_id FROM external_customers WHERE company_id=? AND account_id=?')
            .get(job.company_id, job.account_id);
          if (
            !connection ||
            !connection.writes_enabled ||
            connection.revision !== job.config_revision ||
            !linked ||
            linked.external_id !== job.customer_id
          )
            throw Object.assign(
              new Error('Connection or customer mapping changed; this delivery needs review.'),
              { terminal: true },
            );
          if (!allowed.has(new URL(connection.base_url).origin))
            throw Object.assign(new Error('Gateway origin is no longer allowed.'), { terminal: true });
          const ticket = store.data[job.provider].find(
            (r) =>
              r.companyId === job.company_id &&
              (r.customer_id || r.user_id) === job.account_id &&
              (r.ticket_id || r.id) === job.ticket_id,
          );
          if (!ticket) throw Object.assign(new Error('Local request no longer exists.'), { terminal: true });
          if (job.kind !== 'request' && !ticket.externalId) {
            const creation = sql
              .prepare(
                "SELECT status FROM provider_jobs WHERE company_id=? AND account_id=? AND ticket_id=? AND kind='request'",
              )
              .get(job.company_id, job.account_id, job.ticket_id);
            if (creation?.status === 'pending' || creation?.status === 'processing') {
              sql
                .prepare(
                  "UPDATE provider_jobs SET status='pending',next_attempt=?,attempts=attempts-1 WHERE id=? AND worker=?",
                )
                .run(Date.now() + 30000, job.id, worker);
              continue;
            }
            throw Object.assign(new Error('The provider has not confirmed creation of this request.'), {
              terminal: true,
            });
          }
          const { token } = delivery.unseal(connection.encrypted_token, 'provider:' + job.company_id),
            payload = delivery.unseal(job.payload, 'provider-job:' + job.id);
          const response = await fetch(
            connection.base_url + '/customers/' + encodeURIComponent(job.customer_id) + '/actions',
            {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(12000),
              headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
                'Idempotency-Key': job.id,
              },
              body: JSON.stringify({
                ...payload,
                customerId: job.customer_id,
                ticketId: ticket.externalId || null,
              }),
            },
          );
          if (!response.ok)
            throw Object.assign(new Error('Provider returned HTTP ' + response.status + '.'), {
              terminal: ![408, 429, 500, 502, 503, 504].includes(response.status),
            });
          const chunks = [];
          let bytes = 0;
          for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > 65536)
              throw Object.assign(new Error('Provider receipt was too large.'), { terminal: true });
            chunks.push(chunk);
          }
          const receipt = JSON.parse(Buffer.concat(chunks).toString());
          if (
            receipt.status !== 'confirmed' ||
            receipt.customerId !== job.customer_id ||
            receipt.actionId !== job.action_id ||
            receipt.kind !== job.kind ||
            typeof receipt.id !== 'string' ||
            !receipt.id ||
            receipt.id.length > 200 ||
            typeof receipt.ticketId !== 'string' ||
            !receipt.ticketId ||
            receipt.ticketId.length > 200 ||
            (job.kind !== 'request' && receipt.ticketId !== ticket.externalId)
          )
            throw Object.assign(new Error('Provider receipt did not confirm this exact action.'), {
              terminal: true,
            });
          sql
            .transaction(() => {
              if (
                !sql
                  .prepare("SELECT 1 FROM provider_jobs WHERE id=? AND worker=? AND status='processing'")
                  .get(job.id, worker)
              )
                return;
              const current = sql
                .prepare('SELECT revision FROM provider_connections WHERE company_id=?')
                .get(job.company_id);
              const binding = sql
                .prepare('SELECT external_id FROM external_customers WHERE company_id=? AND account_id=?')
                .get(job.company_id, job.account_id);
              if (current?.revision !== job.config_revision || binding?.external_id !== job.customer_id)
                throw Object.assign(
                  new Error(
                    'Connection changed while the provider was responding. Review the old provider receipt before retrying.',
                  ),
                  { terminal: true },
                );
              if (job.kind === 'request')
                store.update((data) => {
                  if (
                    data[job.provider].some(
                      (r) =>
                        r.companyId === job.company_id &&
                        r.externalId === receipt.ticketId &&
                        (r.ticket_id || r.id) !== job.ticket_id,
                    )
                  )
                    throw Object.assign(
                      new Error('Provider request ID conflicts with another local record.'),
                      { terminal: true },
                    );
                  const row = data[job.provider].find(
                    (r) => r.companyId === job.company_id && (r.ticket_id || r.id) === job.ticket_id,
                  );
                  row.externalId = receipt.ticketId;
                });
              sql
                .prepare(
                  "UPDATE provider_jobs SET status='confirmed',provider_ref=?,last_error=NULL WHERE id=? AND worker=?",
                )
                .run(receipt.id, job.id, worker);
            })
            .immediate();
        } catch (e) {
          sql
            .prepare('UPDATE provider_jobs SET status=?,next_attempt=?,last_error=? WHERE id=? AND worker=?')
            .run(
              e.terminal || job.attempts >= 8 ? 'failed' : 'pending',
              Date.now() + Math.min(3600000, 30000 * 2 ** (job.attempts - 1)),
              e.terminal
                ? e.message
                : 'Provider could not confirm the update yet. It will be retried safely.',
              job.id,
              worker,
            );
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    enqueue,
    flush,
    list(profile) {
      return sql
        .prepare(
          'SELECT * FROM provider_jobs WHERE company_id=? AND account_id=? ORDER BY created_at DESC LIMIT 30',
        )
        .all(profile.companyId, profile.id)
        .map(view);
    },
    start() {
      stopped = false;
      if (!timer) {
        timer = setInterval(() => flush().catch(() => {}), 10000);
        timer.unref();
      }
    },
    close() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
