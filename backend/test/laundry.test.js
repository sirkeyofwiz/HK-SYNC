// Guest laundry: a bag from the room to the laundry and back, who handled each step, shift handovers and reminders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER } from './helpers.js';

let server;
let manager;
let laundry;
let laundry2;
let supervisor;
let driver;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alerts = async (who) => (await server.call('GET', '/api/notifications', { token: who.token })).body.notifications || [];

before(async () => {
  // Reminders every 0.5 s (Express) / 1 s (Standard) so the test can watch them.
  server = await startServer({ LAUNDRY_EXPRESS_REMINDER_MINUTES: String(0.5 / 60), LAUNDRY_STANDARD_REMINDER_MINUTES: String(1 / 60), LAUNDRY_REMINDER_CHECK_MS: '150' });
  manager = await login(server, MANAGER.email, MANAGER.password);
  laundry = await createStaff(server, manager, 'laundry', 'Lulu Laundry');
  laundry2 = await createStaff(server, manager, 'laundry', 'Neema Laundry');
  supervisor = await createStaff(server, manager, 'supervisor', 'Sam Supervisor');
  driver = await createStaff(server, manager, 'driver');
});
after(() => server?.stop());

const bag = (overrides = {}) => ({ room: '214', service: 'wash_iron', speed: 'standard', collectedBy: 'Asha Juma', items: { Shirt: 2, Trousers: 1 }, ...overrides });

test('only laundry staff, supervisors and managers can open Guest laundry', async () => {
  for (const who of [laundry, supervisor]) assert.equal((await server.call('GET', '/api/laundry', { token: who.token })).status, 200);
  assert.equal((await server.call('GET', '/api/laundry', { token: manager })).status, 200);
  assert.equal((await server.call('GET', '/api/laundry', { token: driver.token })).status, 403);
});

test('a bag needs a room, a service, Standard or Express, the housekeeper and at least one item', async () => {
  const post = (body) => server.call('POST', '/api/laundry/bags', { token: supervisor.token, body });
  assert.equal((await post(bag({ room: '' }))).status, 400);
  assert.equal((await post(bag({ service: 'paint' }))).status, 400);
  assert.equal((await post(bag({ speed: 'slow' }))).status, 400);
  assert.equal((await post(bag({ collectedBy: '' }))).status, 400);
  assert.equal((await post(bag({ items: { Shirt: 0 } }))).status, 400);
  assert.equal((await post(bag({ items: { Shirt: 1.5 } }))).status, 400);
});

test('from the room to the laundry and back: every step keeps who and when', async () => {
  const created = await server.call('POST', '/api/laundry/bags', { token: supervisor.token, body: bag() });
  assert.equal(created.status, 201);
  const id = created.body.bag.id;
  assert.equal(created.body.bag.status, 'collected');
  assert.equal(created.body.bag.pieces, 3);
  assert.equal(created.body.bag.dueAt, undefined, 'the promise starts when the laundry receives it');
  assert.ok((await alerts(laundry)).some((alert) => /on its way to the laundry/.test(alert.title)), 'laundry staff are told a bag is coming');

  const received = await server.call('POST', `/api/laundry/bags/${id}/step`, { token: laundry.token, body: { to: 'received' } });
  assert.equal(received.body.bag.receivedByName, 'Lulu Laundry');
  assert.equal(Date.parse(received.body.bag.dueAt) - Date.parse(received.body.bag.receivedAt), 24 * 60 * 60 * 1000, 'Standard is due back in 24 hours');
  assert.equal((await server.call('POST', `/api/laundry/bags/${id}/step`, { token: laundry.token, body: { to: 'received' } })).status, 409, 'no going back a step');
  assert.equal((await server.call('POST', `/api/laundry/bags/${id}/step`, { token: laundry.token, body: { to: 'out' } })).status, 400, 'handing out needs the housekeeper');
  await server.call('POST', `/api/laundry/bags/${id}/step`, { token: laundry.token, body: { to: 'ready' } });
  const out = await server.call('POST', `/api/laundry/bags/${id}/step`, { token: laundry2.token, body: { to: 'out', hkName: 'Mwanaidi Ally' } });
  assert.equal(out.body.bag.handedOutByName, 'Neema Laundry');
  assert.equal(out.body.bag.deliveredBy, 'Mwanaidi Ally');
  const back = await server.call('POST', `/api/laundry/bags/${id}/step`, { token: supervisor.token, body: { to: 'returned' } });
  assert.equal(back.body.bag.status, 'returned');
  assert.deepEqual(back.body.bag.history.map((row) => [row.step, row.byName, row.hkName || '']), [
    ['collected', 'Sam Supervisor', 'Asha Juma'], ['received', 'Lulu Laundry', ''], ['ready', 'Lulu Laundry', ''], ['out', 'Neema Laundry', 'Mwanaidi Ally'], ['returned', 'Sam Supervisor', '']
  ]);
});

test('Express: due in 4 hours, reminders keep coming to laundry staff and supervisors until it is returned', async () => {
  const created = await server.call('POST', '/api/laundry/bags', { token: laundry.token, body: bag({ room: '305', speed: 'express', stage: 'received' }) });
  const express = created.body.bag;
  assert.equal(express.status, 'received');
  assert.equal(Date.parse(express.dueAt) - Date.parse(express.receivedAt), 4 * 60 * 60 * 1000);
  await wait(1500);
  const reminders = (who) => alerts(who).then((list) => list.filter((alert) => alert.type === 'laundry_reminder' && alert.link?.id === express.id));
  for (const who of [laundry, laundry2, supervisor]) {
    const list = await reminders(who);
    assert.ok(list.length >= 1, 'reminded');
    assert.ok(list.every((alert) => alert.urgent), 'Express reminders ring even in quiet hours');
    assert.ok(list.filter((alert) => !alert.readAt).length <= 1, 'only the newest reminder stays unread');
  }
  assert.equal((await alerts({ token: manager })).filter((alert) => alert.type === 'laundry_reminder').length, 0, 'managers are not reminded');
  await server.call('POST', `/api/laundry/bags/${express.id}/step`, { token: laundry.token, body: { to: 'returned', hkName: 'Asha Juma' } });
  const count = (await reminders(laundry)).length;
  await wait(1200);
  assert.equal((await reminders(laundry)).length, count, 'no more reminders once it is back with the guest');
  assert.equal((await reminders(laundry)).filter((alert) => !alert.readAt).length, 0);
});

test('a laundry shift handover keeps the open bags and tells the next person', async () => {
  const open = await server.call('POST', '/api/laundry/bags', { token: laundry.token, body: bag({ room: '410', stage: 'received' }) });
  const handover = await server.call('POST', '/api/laundry/handovers', { token: laundry.token, body: { shift: 'morning', toId: laundry2.user.id, notes: 'Room 410 has a stain on the shirt' } });
  assert.equal(handover.status, 201);
  assert.equal(handover.body.handover.toName, 'Neema Laundry');
  assert.ok(handover.body.handover.bags.some((row) => row.id === open.body.bag.id));
  assert.ok((await alerts(laundry2)).some((alert) => alert.title === 'Laundry handover for you'));
  assert.equal((await server.call('POST', '/api/laundry/handovers', { token: laundry.token, body: { shift: 'morning', toId: laundry.user.id } })).status, 400, 'not to yourself');
});

test('a bag can be corrected: room, items, Standard/Express (moves the due time) and the housekeeper', async () => {
  const created = (await server.call('POST', '/api/laundry/bags', { token: laundry.token, body: bag({ room: '601', stage: 'received' }) })).body.bag;
  const patch = (who, body) => server.call('PATCH', `/api/laundry/bags/${created.id}`, { token: who, body });
  assert.equal((await patch(laundry.token, { room: '' })).status, 400);
  assert.equal((await patch(laundry.token, { speed: 'slow', room: '602' })).status, 400);
  const fixed = await patch(laundry.token, { room: '602', speed: 'express', collectedBy: 'Halima Said', items: { Dress: 1 } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.bag.room, '602');
  assert.equal(fixed.body.bag.pieces, 1);
  assert.equal(fixed.body.bag.editedByName, 'Lulu Laundry');
  assert.equal(Date.parse(fixed.body.bag.dueAt) - Date.parse(fixed.body.bag.receivedAt), 4 * 60 * 60 * 1000, 'Express is due 4 hours after it was received');
  assert.equal(fixed.body.bag.history[0].hkName, 'Halima Said');
  await server.call('POST', `/api/laundry/bags/${created.id}/step`, { token: laundry.token, body: { to: 'returned', hkName: 'Asha Juma' } });
  assert.equal((await patch(laundry.token, { room: '603' })).status, 409, 'once back with the guest only a manager can fix it');
  assert.equal((await patch(manager, { room: '603' })).status, 200);
});

test('only a manager deletes a bag the laundry has received', async () => {
  const received = (await server.call('POST', '/api/laundry/bags', { token: laundry.token, body: bag({ room: '501', stage: 'received' }) })).body.bag;
  assert.equal((await server.call('DELETE', `/api/laundry/bags/${received.id}`, { token: laundry.token })).status, 403);
  assert.equal((await server.call('DELETE', `/api/laundry/bags/${received.id}`, { token: manager })).status, 200);
  const list = (await server.call('GET', '/api/laundry', { token: manager })).body.bags;
  assert.ok(!list.some((row) => row.id === received.id));
});
