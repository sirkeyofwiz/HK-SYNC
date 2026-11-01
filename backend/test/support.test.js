// Support plan on profiles: managers record what they did to help someone, and how it turned out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let supervisor;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
});
after(() => server?.stop());

const call = (method, route, body, token = manager) => server.call(method, `/api/support-actions${route}`, { token, body });
const action = (fields = {}) => ({ kind: 'hk', ref: 'Sarah Mussa', name: 'Sarah Mussa', date: hotelDate(0), action: 'Coaching talk', problem: 'Hair in bathrooms', ...fields });

test('only managers can see or record support actions', async () => {
  assert.equal((await call('GET', '?kind=hk&ref=Sarah%20Mussa', undefined, supervisor.token)).status, 403);
  assert.equal((await call('POST', '', action(), supervisor.token)).status, 403);
});

test('an action needs what it was for, a known action, a past date and a sensible follow-up', async () => {
  assert.equal((await call('POST', '', action({ problem: '' }))).status, 400);
  assert.equal((await call('POST', '', action({ action: 'Shouting' }))).status, 400);
  assert.equal((await call('POST', '', action({ date: hotelDate(2) }))).status, 400);
  assert.equal((await call('POST', '', action({ date: hotelDate(-3), followUp: hotelDate(-5) }))).status, 400);
});

test('actions are kept per person, newest first, and their outcome can be updated', async () => {
  const first = (await call('POST', '', action({ date: hotelDate(-10), followUp: hotelDate(-2) }))).body.action;
  await call('POST', '', action({ action: 'Training', problem: 'Wardrobe 4/10' }));
  await call('POST', '', action({ kind: 'sup', ref: supervisor.user.id, name: 'Sup', problem: 'Room average 26/50' }));
  const sarah = (await call('GET', '?kind=hk&ref=sarah%20mussa')).body.actions;
  assert.deepEqual(sarah.map((row) => row.action), ['Training', 'Coaching talk']);
  assert.equal(sarah[1].status, 'in_progress');
  assert.equal(sarah[1].byName, 'Manager');
  const updated = (await call('PATCH', `/${first.id}`, { status: 'improved' })).body.action;
  assert.equal(updated.status, 'improved');
  assert.equal(updated.problem, 'Hair in bathrooms');
  assert.equal((await call('GET', `?kind=sup&ref=${supervisor.user.id}`)).body.actions.length, 1);
});

test('renaming a housekeeper on Goals with past reports keeps their support plan', async () => {
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: [{ name: 'Pili Omar' }] } });
  await call('POST', '', action({ ref: 'Pili Omar', name: 'Pili Omar' }));
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: [{ name: 'Pili Omari' }], renames: [{ from: 'Pili Omar', to: 'Pili Omari' }] } });
  assert.equal((await call('GET', '?kind=hk&ref=Pili%20Omari')).body.actions.length, 1);
  assert.equal((await call('GET', '?kind=hk&ref=Pili%20Omar')).body.actions.length, 0);
});

test('an action can be deleted', async () => {
  const row = (await call('POST', '', action({ ref: 'Delete Me' }))).body.action;
  assert.equal((await call('DELETE', `/${row.id}`)).status, 200);
  assert.equal((await call('GET', '?kind=hk&ref=Delete%20Me')).body.actions.length, 0);
});
