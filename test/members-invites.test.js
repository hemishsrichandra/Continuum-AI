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
