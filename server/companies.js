import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { field, json } from './requests.js';
import { fault } from './providers.js';

export const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(24).toString('base64url');
export function createCompanies(store, config) {
  const sql = store.db;
  function registration(body, email) {
    if (body.invitation) {
      const hash = tokenHash(field(body.invitation, 'invitation', 200));
      const invite = sql
        .prepare('SELECT * FROM invitations WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?')
        .get(hash, Date.now());
      if (!invite || invite.email !== email)
        throw fault(400, 'This invitation is invalid, expired, or belongs to another email address.');
      const consumed = sql
        .prepare(
          'UPDATE invitations SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?',
        )
        .run(Date.now(), hash, Date.now());
      if (!consumed.changes) throw fault(409, 'This invitation was already used.');
      return { companyId: invite.company_id, role: invite.role, provider: invite.provider };
    }
    if (body.companyCode) {
      const company = sql
        .prepare('SELECT id FROM companies WHERE join_hash=?')
        .get(tokenHash(field(body.companyCode, 'company code', 200)));
      if (!company)
        throw fault(400, 'Company code was not found. Ask your service provider for a registration link.');
      return { companyId: company.id, role: 'customer', provider: body.provider };
    }
    if (body.createCompany !== true)
      throw fault(400, 'Use your company registration link, an invitation, or choose Create a company.');
    const companyId = randomUUID(),
      name = field(body.companyName, 'company name', 100);
    sql.prepare('INSERT INTO companies VALUES(?,?,NULL,?)').run(companyId, name, Date.now());
    return { companyId, role: 'owner', provider: body.provider };
  }
  function staff(profile) {
    if (!profile || profile.demo) return null;
    const account = sql
      .prepare('SELECT * FROM accounts WHERE id=? AND company_id=?')
      .get(profile.id, profile.companyId);
    if (!account || !['owner', 'staff'].includes(account.role)) return null;
    const access = sql.prepare('SELECT provider FROM staff_access WHERE account_id=?').get(account.id);
    return {
      id: account.id,
      provider: access?.provider || account.provider,
      companyId: account.company_id,
      role: account.role,
    };
  }
  function roster(operator) {
    return sql
      .prepare(
        "SELECT id,name,provider,role FROM accounts WHERE company_id=? AND role IN ('owner','staff') ORDER BY name",
      )
      .all(operator.companyId)
      .filter(
        (a) =>
          a.role === 'owner' ||
          (sql.prepare('SELECT provider FROM staff_access WHERE account_id=?').get(a.id)?.provider ||
            a.provider) === operator.provider,
      );
  }
  async function handle(req, endpoint, session, send) {
    if (!endpoint.includes('/api/company')) return false;
    if (!session?.account_id || session.profile.role !== 'owner')
      throw fault(403, 'Only a company owner can manage the team.');
    const companyId = session.profile.companyId;
    if (endpoint === 'GET /api/company') {
      send(200, {
        company: sql.prepare('SELECT id,name FROM companies WHERE id=?').get(companyId),
        members: sql
          .prepare('SELECT id,name,email,role,provider FROM accounts WHERE company_id=? ORDER BY name')
          .all(companyId),
        invitations: sql
          .prepare(
            'SELECT email,role,provider,expires_at,consumed_at FROM invitations WHERE company_id=? ORDER BY expires_at DESC LIMIT 50',
          )
          .all(companyId),
      });
      return true;
    }
    if (endpoint === 'POST /api/company/customer-code') {
      const body = await json(req);
      if (body.confirmed !== true)
        throw fault(
          400,
          'Confirm generating a new customer signup link. Existing signup links will stop working.',
        );
      const code = secret();
      sql.prepare('UPDATE companies SET join_hash=? WHERE id=?').run(tokenHash(code), companyId);
      send(200, { code, url: config.APP_URL + '/desk#company=' + code });
      return true;
    }
    if (endpoint === 'POST /api/company/invitations') {
      const body = await json(req),
        email = field(body.email, 'email', 254).toLowerCase();
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !['staff', 'customer'].includes(body.role) ||
        !['repair', 'it'].includes(body.provider)
      )
        throw fault(400, 'Choose a valid email, role, and schema adapter.');
      const token = secret(),
        expiresAt = Date.now() + 48 * 3600000;
      sql
        .prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,NULL)')
        .run(tokenHash(token), companyId, email, body.provider, body.role, expiresAt);
      send(201, { url: config.APP_URL + '/desk#invite=' + token, expiresAt });
      return true;
    }
    if (endpoint === 'POST /api/company/revoke-staff') {
      const body = await json(req);
      if (body.confirmed !== true) throw fault(400, 'Confirm removing specialist access.');
      sql
        .transaction(() => {
          const result = sql
            .prepare("UPDATE accounts SET role='customer' WHERE id=? AND company_id=? AND role='staff'")
            .run(field(body.id, 'staff account', 100), companyId);
          if (!result.changes) throw fault(404, 'Staff account not found.');
          store.update((data) => {
            for (const h of data.handoffs) {
              if (h.companyId !== companyId || h.assignedTo !== body.id ||
                  ['Resolved', 'Closed'].includes(h.status)) continue;
              h.assignedTo = null;
              const row = data[h.provider]?.find((r) =>
                r.companyId === companyId && (r.ticket_id || r.id) === h.ticketId);
              if (row) row[h.provider === 'it' ? 'owner' : 'assigned_to'] =
                h.provider === 'it' ? 'IT service desk' : 'Device repair team';
              data.audit.push({
                id: randomUUID(), scope: h.scope, ticketId: h.ticketId,
                kind: 'assignment', createdAt: new Date().toISOString(),
                note: 'Specialist access was removed. Assignment released for owner review.',
              });
              if (h.status !== 'Awaiting confirmation') h.status = 'Queued';
              h.revision = (h.revision || 0) + 1;
            }
          });
          sql.prepare('DELETE FROM staff_access WHERE account_id=?').run(body.id);
          sql.prepare('DELETE FROM sessions WHERE account_id=?').run(body.id);
        })
        .immediate();
      send(200, { success: true });
      return true;
    }
    return false;
  }
  return { registration, staff, roster, handle };
}
