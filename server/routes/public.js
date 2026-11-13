// Public routes: health, demo profiles, and the "book a session" slots and reservations. No company session is needed.
// Every route module returns true when it answered the request; otherwise the next module is tried (see createHandler in ../app.js).
import { fault, profiles } from '../providers.js';
import { field, flags, json, submission, appointment } from '../requests.js';
import { demoSlots, reserveDemo, manageDemo, timeZone } from '../scheduling.js';

export function createPublicRoutes(services) {
  const { store, delivery, auth, limit, once } = services;
  return async function publicRoutes(context) {
    const { req, endpoint, session, write } = context;
    if (endpoint === 'GET /api/health')
      return write(200, {
        status: 'ok',
        version: '3.0.0',
        storage: 'sqlite',
        mode: auth.demoEnabled ? 'demo' : 'standard',
      });
    if (endpoint === 'GET /api/profiles')
      return write(200, { profiles: auth.demoEnabled ? profiles : [], demo: auth.demoEnabled });
    if (endpoint === 'GET /api/demo-slots')
      return write(200, {
        slots: await delivery.available(session?.account_id, demoSlots(store)),
        timeZone,
        emailConfigured: delivery.emailConfigured,
      });
    if (endpoint === 'POST /api/demo-bookings/manage') {
      limit('manage:' + req.socket.remoteAddress, 40);
      const body = await json(req);
      flags(body, ['cancel', 'confirmed']);
      return write(
        200,
        store.db
          .transaction(() => {
            const result = manageDemo(store, {
              ...body,
              id: field(body.id, 'reservation ID', 100),
              manageToken: field(body.manageToken, 'reservation token', 100),
            });
            if (body.cancel) {
              const booking = store.data.demoBookings.find((b) => b.id === result.id);
              const owner = booking.accountId
                ? store.db.prepare('SELECT * FROM accounts WHERE id=?').get(booking.accountId)
                : null;
              delivery.queueBooking(owner, booking, true, 'session');
            }
            const emailJob = store.data.outbox.find(
              (j) =>
                j.id === `session-${result.id}-${result.status === 'Cancelled' ? 'cancel' : 'book'}-email`,
            );
            return { ...result, emailDelivery: emailJob?.status || 'not_configured' };
          })
          .immediate(),
      );
    }
    if (endpoint === 'POST /api/demo-bookings') {
      limit('booking:' + req.socket.remoteAddress, 12);
      const body = await json(req);
      flags(body);
      if (body.confirmed !== true) throw fault(400, 'Confirm the reservation before submitting.');
      const email = field(body.email, 'email', 200).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fault(400, 'Enter a valid email address.');
      const plan = field(body.plan, 'plan', 40);
      if (!['Starter', 'Growth', 'Enterprise', 'Just exploring'].includes(plan))
        throw fault(400, 'Choose a valid plan.');
      const data = {
        accountId: session?.account_id || null,
        name: field(body.name, 'name', 100),
        email,
        plan,
        datetime: appointment(body.datetime),
        notes: body.notes ? field(body.notes, 'notes', 500) : '',
      };
      const operation = submission(req, body, endpoint);
      return write(
        201,
        await once('demo-booking', operation, async () => {
          if (!(await delivery.available(session?.account_id, [{ id: data.datetime }])).length)
            throw fault(409, 'Your calendar is busy at that time.');
          return store.db
            .transaction(() => {
              const result = reserveDemo(store, data, operation);
              const saved = store.data.demoBookings.find((b) => b.id === result.id);
              delivery.queueBooking(session?.account || null, saved, false, 'session');
              const response = {
                ...result,
                emailDelivery: delivery.emailConfigured ? 'queued' : 'not_configured',
              };
              if (operation.key)
                store.update((data) => {
                  data.operations.find(
                    (o) => o.scope === 'demo-booking' && o.key === operation.key,
                  ).response = response;
                });
              return response;
            })
            .immediate();
        }),
      );
    }
  };
}
