// ReviewPro guest ratings on Department targets: the % guests give housekeeping on ReviewPro, for the four SMART categories.
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
const goals = async () => (await server.call('GET', '/api/goals', { token: manager })).body.goals;
const rate = (body, token = manager) => server.call('POST', '/api/goals/guest-ratings', { token, body });

test('the four Department target categories each start with no guest rating', async () => {
  const smart = (await goals()).smartGoals;
  assert.deepEqual(smart.map((goal) => [goal.key, goal.guest.latest, goal.guestTarget]), [
    ['cleaning_level', null, null], ['hygiene_standard', null, null], ['organization_supplies', null, null], ['guest_interaction', null, null]
  ]);
});

test('an update keeps the date and the % for any of the four; latest and previous per category', async () => {
  assert.equal((await rate({ date: hotelDate(-7), scores: { cleaning_level: 88, hygiene_standard: 90 } })).status, 201);
  const second = await rate({ date: hotelDate(0), scores: { cleaning_level: 91.5, guest_interaction: 84 }, note: 'Weekly check' });
  assert.equal(second.status, 201);
  const smart = Object.fromEntries(second.body.goals.smartGoals.map((goal) => [goal.key, goal.guest]));
  assert.equal(smart.cleaning_level.latest.score, 91.5);
  assert.equal(smart.cleaning_level.previous.score, 88);
  assert.equal(smart.hygiene_standard.latest.score, 90, 'a category left blank keeps its last %');
  assert.equal(smart.organization_supplies.latest, null);
  assert.equal(smart.guest_interaction.latest.by, 'Manager');
  assert.equal(second.body.goals.guestRatings[0].note, 'Weekly check');
});

test('updates are checked and only managers make them; a wrong one can be deleted', async () => {
  assert.equal((await rate({ date: hotelDate(0), scores: {} })).status, 400, 'at least one category');
  assert.equal((await rate({ date: hotelDate(0), scores: { cleaning_level: 101 } })).status, 400, 'a % from 0 to 100');
  assert.equal((await rate({ date: hotelDate(1), scores: { cleaning_level: 90 } })).status, 400, 'not in the future');
  assert.equal((await rate({ date: '2026-02-30', scores: { cleaning_level: 90 } })).status, 400, 'a real date');
  assert.equal((await rate({ date: hotelDate(0), scores: { cleaning_level: 90 } }, supervisor.token)).status, 403);
  const latest = (await goals()).guestRatings[0];
  const removed = await server.call('DELETE', `/api/goals/guest-ratings/${latest.id}`, { token: manager });
  assert.equal(removed.body.goals.smartGoals[0].guest.latest.score, 88, 'back to the earlier %');
});

test('the guest target % is saved with the SMART targets', async () => {
  const rows = (await goals()).smartGoals.map((goal) => ({ key: goal.key, target: goal.target, guestTarget: goal.key === 'cleaning_level' ? 92 : '' }));
  const saved = (await server.call('PUT', '/api/goals', { token: manager, body: { smartGoals: rows } })).body.goals.smartGoals;
  assert.equal(saved[0].guestTarget, 92);
  assert.equal(saved[1].guestTarget, null);
});
