import { randomUUID } from 'node:crypto';
import { fault } from './providers.js';

export const timeZone = 'Asia/Kolkata';
export function demoSlots(store, now = Date.now()) {
  const start = new Date(now + 330 * 60000);
  start.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: 14 }, (_, day) => {
    const date = new Date(+start + (day + 1) * 86400000).toISOString().slice(0, 10);
    const weekday = new Date(date).getUTCDay();
    if (weekday === 0 || weekday === 6) return [];
    return ['10:00', '11:00', '14:00', '15:30'].map((time) => ({ date, time, id: date + 'T' + time + ':00+05:30' }));
  }).flat().filter((slot) => !store.data.demoBookings.some((b) => !b.cancelledAt && b.datetime === slot.id));
}
export function reserveDemo(store, body, operation) {
  if (!demoSlots(store).some((slot) => slot.id === body.datetime)) throw fault(409, 'That time has just been reserved. Please choose another.');
  const booking = { ...body, id: randomUUID(), manageToken: randomUUID(), createdAt: new Date().toISOString(), status: 'Reserved' };
  return store.update((data) => {
    const previous = operation?.key && data.operations.find((o) => o.scope === 'demo-booking' && o.key === operation.key);
    if (previous) {
      if (previous.fingerprint !== operation.fingerprint) throw fault(409, 'Submission details changed.');
      return previous.response;
    }
    if (!demoSlots({ data }).some((slot) => slot.id === body.datetime)) throw fault(409, 'That time is no longer available.');
    data.demoBookings.push(booking);
    // Responses and reservations are saved together for safe replay after a restart.
    const response = { id: booking.id, manageToken: booking.manageToken, datetime: booking.datetime, status: booking.status, createdAt: booking.createdAt, timeZone };
    if (operation?.key) data.operations.push({ scope: 'demo-booking', ...operation, response });
    return response;
  });
}

export function manageDemo(store, body) {
  const booking = store.data.demoBookings.find((b) => b.id === body.id && b.manageToken === body.manageToken);
  if (!booking) throw fault(404, 'Reservation was not found. Use the browser where it was created.');
  if (body.cancel === true && !booking.cancelledAt) {
    if (body.confirmed !== true) throw fault(400, 'Confirm before cancelling this reservation.');
    if (new Date(booking.datetime) <= new Date()) throw fault(409, 'Past sessions cannot be cancelled.');
    store.update((data) => { data.demoBookings.find((b) => b.id === booking.id).cancelledAt = new Date().toISOString(); });
  }
  const current = store.data.demoBookings.find((b) => b.id === booking.id);
  return { id: current.id, datetime: current.datetime, createdAt: current.createdAt, status: current.cancelledAt ? 'Cancelled' : 'Reserved', timeZone };
}
