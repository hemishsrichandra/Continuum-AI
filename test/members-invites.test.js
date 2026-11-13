import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, client, password } from './_helpers.js';

async function setup(t) {
  const w = await world(t);
  async function specialist(name) {
    const c = client(() => w.h);
    const invite = (await w.owner.api('company/invitations', { email: name + '@example.test', role: 'staff', provider: 'repair' })).data.url.split('invite=')[1];
    const r = await c.api('auth/register', { invitation: invite, name, email: name + '@example.test', password });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    c.id = r.data.profile.id;
    return c;
  }
  const row = (id) => w.db().prepare('SELECT role,status FROM company_memberships WHERE company_id=? AND account_id=?').get(w.company, id);
  return { w, specialist, row };
}

test('reinstating a revoked member: only an owner, only a revoked member, and never an upgrade', async (t) => {
  const { w, specialist, row } = await setup(t);
  const sam = await specialist('sam');
  const carol = await w.customer('carol');
  assert.equal((await w.owner.api('company/revoke-membership', { id: sam.id, confirmed: true })).status, 200);
  assert.equal((await w.owner.api('company/revoke-membership', { id: carol.id, confirmed: true })).status, 200);
  assert.equal((await sam.api('operator')).status, 403, 'revoked specialists are locked out');

  assert.equal((await w.owner.api('company/reinstate-membership', { id: sam.id })).status, 400, 'needs confirmation');
  assert.equal((await sam.api('company/reinstate-membership', { id: sam.id, confirmed: true })).status, 403, 'a revoked member cannot reinstate themselves');
  assert.equal((await w.other.api('company/reinstate-membership', { id: sam.id, confirmed: true })).status, 404, 'another company’s owner cannot reach this member');
  assert.equal((await w.owner.api('company/reinstate-membership', { id: carol.id, role: 'staff', confirmed: true })).status, 400, 'a customer cannot return as a specialist');
  assert.equal((await w.owner.api('company/reinstate-membership', { id: sam.id, role: 'owner', confirmed: true })).status, 400, 'nobody can return as owner');
  assert.deepEqual(row(carol.id), { role: 'customer', status: 'revoked' }, 'rejected calls changed nothing');

  const ok = await w.owner.api('company/reinstate-membership', { id: carol.id, confirmed: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(row(carol.id), { role: 'customer', status: 'active' });
  assert.equal((await w.owner.api('company/reinstate-membership', { id: carol.id, confirmed: true })).status, 404, 'an active member is not "revoked"');

  // A former specialist may return as a customer (the default) or, explicitly, as a specialist.
  assert.equal((await w.owner.api('company/reinstate-membership', { id: sam.id, confirmed: true })).data.role, 'customer');
  assert.deepEqual(row(sam.id), { role: 'customer', status: 'active' });
  assert.equal((await sam.api('operator')).status, 403, 'back as a customer: still no specialist console');
  await w.owner.api('company/revoke-membership', { id: sam.id, confirmed: true });
  // revoking a customer-role member leaves role=customer, so this former specialist can now only return as a customer.
  assert.equal((await w.owner.api('company/reinstate-membership', { id: sam.id, role: 'staff', confirmed: true })).status, 400);

});

test('a former specialist can be brought back as a specialist', async (t) => {
  const { w, specialist, row } = await setup(t);
  const sam = await specialist('sam');
  await w.owner.api('company/revoke-membership', { id: sam.id, confirmed: true });
  assert.deepEqual(row(sam.id), { role: 'staff', status: 'revoked' });
  const r = await w.owner.api('company/reinstate-membership', { id: sam.id, role: 'staff', confirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await sam.api('operator')).status, 200, 'specialist access is back');
  assert.equal((await w.owner.api('company')).data.members.find((m) => m.id === sam.id).status, 'active');
});

test('resending an invitation closes the old link, keeps role and adapter, and is owner-only', async (t) => {
  const { w } = await setup(t);
  const first = (await w.owner.api('company/invitations', { email: 'dana@example.test', role: 'staff', provider: 'repair' })).data;
  const token = (u) => u.split('invite=')[1];
  const customer = await w.customer('erin');

  assert.equal((await w.owner.api('company/invitations/resend', { email: 'dana@example.test' })).status, 400, 'needs confirmation');
  assert.equal((await customer.api('company/invitations/resend', { email: 'dana@example.test', confirmed: true })).status, 403);
  assert.equal((await w.other.api('company/invitations/resend', { email: 'dana@example.test', confirmed: true })).status, 404, 'another company has no such invitation');
  assert.equal((await w.owner.api('company/invitations/resend', { email: 'nobody@example.test', confirmed: true })).status, 404);

  const again = await w.owner.api('company/invitations/resend', { email: 'dana@example.test', confirmed: true });
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.notEqual(token(again.data.url), token(first.url));
  assert.ok(again.data.expiresAt > Date.now() + 47 * 3600000, 'a fresh 48-hour window');

  const reg = (invite) => client(() => w.h).api('auth/register', { invitation: invite, name: 'Dana', email: 'dana@example.test', password });
  assert.equal((await reg(token(first.url))).status, 400, 'the first link no longer works');
  const used = await reg(token(again.data.url));
  assert.equal(used.status, 201, JSON.stringify(used.data));
  assert.equal(used.data.profile.role, 'staff', 'role from the original invitation is kept');
  assert.equal((await w.owner.api('company/invitations/resend', { email: 'dana@example.test', confirmed: true })).status, 404, 'a used invitation cannot be resent');
});

test('an expired invitation can be resent', async (t) => {
  const { w } = await setup(t);
  const first = (await w.owner.api('company/invitations', { email: 'finn@example.test', role: 'customer', provider: 'repair' })).data;
  w.db().prepare('UPDATE invitations SET expires_at=? WHERE company_id=? AND email=?').run(Date.now() - 1000, w.company, 'finn@example.test');
  const stale = await client(() => w.h).api('auth/register', { invitation: first.url.split('invite=')[1], name: 'Finn', email: 'finn@example.test', password });
  assert.equal(stale.status, 400, 'expired');
  const fresh = await w.owner.api('company/invitations/resend', { email: 'finn@example.test', confirmed: true });
  assert.equal(fresh.status, 201);
  const reg = await client(() => w.h).api('auth/register', { invitation: fresh.data.url.split('invite=')[1], name: 'Finn', email: 'finn@example.test', password });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
});

test('invitation email is opt-in, only possible when the server has email set up, and queued without exposing anything else', async (t) => {
  const plain = await world(t);
  const refused = await plain.owner.api('company/invitations', { email: 'zed@example.test', role: 'customer', provider: 'repair', sendEmail: true });
  assert.equal(refused.status, 400, 'asking for email on a server without it is refused, not silently ignored');
  assert.equal((await plain.owner.api('company')).data.emailConfigured, false);
  const ok = await plain.owner.api('company/invitations', { email: 'zed@example.test', role: 'customer', provider: 'repair' });
  assert.equal(ok.data.emailed, false, 'nothing is emailed unless asked');

  const w = await world(t, { config: { RESEND_API_KEY: 're_fictional_key', EMAIL_FROM: 'Continuum <no-reply@example.test>', DATA_ENCRYPTION_KEY: 'a'.repeat(64) } });
  assert.equal((await w.owner.api('company')).data.emailConfigured, true);
  const mails = () => w.db().prepare("SELECT COUNT(*) n FROM records WHERE collection='outbox'").get().n;
  const base = mails();
  const none = await w.owner.api('company/invitations', { email: 'amy@example.test', role: 'customer', provider: 'repair' });
  assert.equal(none.data.emailed, false);
  assert.equal(mails(), base, 'no email without the owner’s choice');
  const sent = await w.owner.api('company/invitations', { email: 'ben@example.test', role: 'staff', provider: 'repair', sendEmail: true });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.emailed, true);
  const mail = w.db().prepare("SELECT * FROM records WHERE collection='outbox'").all();
  assert.equal(mails(), base + 1);
  assert.ok(!JSON.stringify(mail[0]).includes('ben@example.test') && !/desk#invite=/.test(JSON.stringify(mail[0])), 'the recipient and the link are sealed at rest');
  const again = await w.owner.api('company/invitations/resend', { email: 'ben@example.test', confirmed: true, sendEmail: true });
  assert.equal(again.data.emailed, true);
  assert.equal(mails(), base + 2);
  const customer = await w.customer('carol');
  assert.equal((await customer.api('company/invitations', { email: 'x@example.test', role: 'customer', provider: 'repair', sendEmail: true })).status, 403);
});
