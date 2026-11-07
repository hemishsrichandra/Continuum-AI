import { createHash } from 'node:crypto';
import { field, json } from './requests.js';
import { fault } from './providers.js';
import { providerKinds } from './provider-actions.js';

// A company's own gateway translates its database to JSON. This bridge imports
// read-only snapshots; local actions never pretend to write to that database.
export function createConnector(store, delivery, config) {
  const sql = store.db;
  const allowed = new Set(
    (config.PROVIDER_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const required = ['id', 'customerId', 'title', 'issue', 'status'];
  const defaults = {
    id: 'id',
    customerId: 'customerId',
    title: 'title',
    issue: 'issue',
    status: 'status',
    eta: 'eta',
    assignedTo: 'assignedTo',
  };
  function validateMapping(input) {
    const mapping = input || defaults;
    if (
      typeof mapping !== 'object' ||
      Array.isArray(mapping) ||
      required.some((k) => typeof mapping[k] !== 'string') ||
      Object.values(mapping).some((v) => typeof v !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v))
    )
      throw fault(400, 'Map the required fields to flat JSON property names.');
    return Object.fromEntries(
      Object.keys(defaults)
        .filter((k) => mapping[k])
        .map((k) => [k, mapping[k]]),
    );
  }
  async function handle(req, endpoint, session, send) {
    if (!endpoint.includes('/api/company/connector') && endpoint !== 'POST /api/connector/sync') return false;
    const profile = session.profile,
      companyId = profile.companyId;
    if (!session.account_id) throw fault(403, 'Use a company account.');
    if (endpoint !== 'POST /api/connector/sync' && profile.role !== 'owner')
      throw fault(403, 'Only the company owner can manage a connector.');
    if (endpoint === 'GET /api/company/connector') {
      const row = sql
        .prepare(
          'SELECT base_url,mapping,writes_enabled,capabilities FROM provider_connections WHERE company_id=?',
        )
        .get(companyId);
      send(200, {
        configured: Boolean(row),
        baseUrl: row?.base_url,
        mapping: row ? JSON.parse(row.mapping) : defaults,
        writesEnabled: Boolean(row?.writes_enabled),
        actions: row ? JSON.parse(row.capabilities) : [],
        allowedOrigins: [...allowed],
        customers: sql
          .prepare('SELECT account_id,external_id FROM external_customers WHERE company_id=?')
          .all(companyId),
      });
      return true;
    }
    if (endpoint === 'POST /api/company/connector') {
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm the read-only connection.');
      let url;
      try {
        url = new URL(field(body.baseUrl, 'gateway URL', 500));
      } catch {
        throw fault(400, 'Enter a valid gateway URL.');
      }
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !allowed.has(url.origin) ||
        (url.protocol !== 'https:' &&
          !(
            config.NODE_ENV !== 'production' &&
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(url.hostname)
          ))
      )
        throw fault(
          400,
          'The server owner must allow this gateway origin in PROVIDER_ALLOWED_ORIGINS. Use HTTPS in production.',
        );
      const token = field(body.apiToken, 'gateway token', 2000),
        mapping = validateMapping(body.mapping);
      if (body.writesEnabled !== undefined && typeof body.writesEnabled !== 'boolean')
        throw fault(400, 'Write permission must be true or false.');
      let capabilities = [];
      if (body.writesEnabled) {
        let response;
        try {
          response = await fetch(url.href.replace(/\/+$/, '') + '/capabilities', {
            headers: { Authorization: 'Bearer ' + token },
            redirect: 'error',
            signal: AbortSignal.timeout(12000),
          });
          if (!response.ok) throw new Error();
          const raw = await response.text();
          if (raw.length > 10000) throw new Error();
          const result = JSON.parse(raw);
          if (result.version !== 1 || result.idempotency !== true || !Array.isArray(result.actions))
            throw new Error();
          capabilities = [...new Set(result.actions.filter((a) => providerKinds.includes(a)))];
          if (!capabilities.length) throw new Error();
        } catch {
          throw fault(
            400,
            'Gateway must acknowledge supported actions and durable idempotency before writes can be enabled.',
          );
        }
      }
      sql
        .prepare(
          'INSERT INTO provider_connections(company_id,base_url,encrypted_token,mapping,writes_enabled,capabilities) VALUES(?,?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET base_url=excluded.base_url,encrypted_token=excluded.encrypted_token,mapping=excluded.mapping,writes_enabled=excluded.writes_enabled,capabilities=excluded.capabilities,revision=provider_connections.revision+1',
        )
        .run(
          companyId,
          url.href.replace(/\/+$/, ''),
          delivery.seal({ token }, 'provider:' + companyId),
          JSON.stringify(mapping),
          body.writesEnabled ? 1 : 0,
          JSON.stringify(capabilities),
        );
      send(200, {
        success: true,
        mode: body.writesEnabled ? 'confirmed action sync' : 'read-only snapshots',
      });
      return true;
    }
    if (endpoint === 'POST /api/company/connector/customer') {
      const body = await json(req),
        id = field(body.accountId, 'account ID', 100),
        externalId = field(body.externalId, 'external customer ID', 200);
      if (!sql.prepare('SELECT 1 FROM accounts WHERE id=? AND company_id=?').get(id, companyId))
        throw fault(404, 'Account not found in this company.');
      try {
        sql
          .prepare(
            'INSERT INTO external_customers VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET external_id=excluded.external_id',
          )
          .run(id, companyId, externalId);
      } catch (e) {
        if (e.code?.startsWith('SQLITE_CONSTRAINT'))
          throw fault(409, 'That external customer is already linked.');
        throw e;
      }
      send(200, { success: true });
      return true;
    }
    if (endpoint === 'DELETE /api/company/connector') {
      sql.prepare('DELETE FROM provider_connections WHERE company_id=?').run(companyId);
      send(200, { success: true });
      return true;
    }
    if (endpoint === 'POST /api/connector/sync') {
      const row = sql.prepare('SELECT * FROM provider_connections WHERE company_id=?').get(companyId),
        customer = sql
          .prepare('SELECT external_id FROM external_customers WHERE account_id=? AND company_id=?')
          .get(session.account_id, companyId);
      if (!row || !customer)
        throw fault(
          409,
          'Your company owner must configure a gateway and link your external customer ID first.',
        );
      if (!allowed.has(new URL(row.base_url).origin))
        throw fault(503, 'This gateway is no longer allowed by the server.');
      const { token } = delivery.unseal(row.encrypted_token, 'provider:' + companyId);
      let payload;
      try {
        const response = await fetch(
          row.base_url + '/customers/' + encodeURIComponent(customer.external_id) + '/requests',
          {
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(12000),
          },
        );
        if (!response.ok) throw new Error();
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 1048576) throw new Error();
          chunks.push(chunk);
        }
        payload = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw fault(503, 'The provider snapshot could not be fetched. Existing records were preserved.');
      }
      if (!Array.isArray(payload) || payload.length > 100)
        throw fault(502, 'The gateway must return an array of at most 100 service records.');
      const m = JSON.parse(row.mapping),
        now = new Date().toISOString();
      const records = payload.map((item) => {
        if (
          !item ||
          required.some((k) => typeof item[m[k]] !== 'string') ||
          item[m.customerId] !== customer.external_id
        )
          throw fault(
            502,
            'A provider record was invalid or belonged to another customer. No records were imported.',
          );
        const externalId = field(item[m.id], 'external request ID', 200),
          title = field(item[m.title], 'provider title', 100),
          issue = field(item[m.issue], 'provider issue', 1000),
          status = field(item[m.status], 'provider status', 100);
        const id =
          'EXT-' +
          createHash('sha256')
            .update(companyId + ':' + profile.provider + ':' + externalId)
            .digest('hex')
            .slice(0, 24);
        const eta = item[m.eta] || null;
        if (
          eta &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(eta) ||
            !Number.isFinite(+new Date(eta)) ||
            new Date(eta).toISOString().slice(0, 10) !== eta)
        )
          throw fault(502, 'The provider ETA is invalid.');
        const assigned =
          typeof item[m.assignedTo] === 'string' ? item[m.assignedTo].slice(0, 100) : 'Service team';
        const common = { companyId, externalId, syncedAt: now };
        return profile.provider === 'repair'
          ? {
              ...common,
              ticket_id: id,
              customer_id: profile.id,
              device: title,
              issue,
              status,
              eta_date: eta,
              assigned_to: assigned,
            }
          : {
              ...common,
              id,
              user_id: profile.id,
              problem: title,
              details: issue,
              state: status,
              target_resolution: eta,
              owner: assigned,
            };
      });
      store.update((data) => {
        for (const item of records) {
          const id = item.ticket_id || item.id,
            previous = data[profile.provider].find(
              (r) =>
                r.companyId === companyId &&
                (r.externalId === item.externalId || (r.ticket_id || r.id) === id),
            );
          if (previous && (previous.customer_id || previous.user_id) !== profile.id)
            throw fault(409, 'An external request is already linked to another customer.');
          if (previous) {
            const originalId = previous.ticket_id || previous.id;
            Object.assign(previous, item);
            previous[profile.provider === 'repair' ? 'ticket_id' : 'id'] = originalId;
          } else data[profile.provider].push({ ...item, createdAt: now });
        }
      });
      send(200, { success: true, imported: records.length, syncedAt: now, mode: 'read-only snapshots' });
      return true;
    }
    return false;
  }
  return { handle };
}
