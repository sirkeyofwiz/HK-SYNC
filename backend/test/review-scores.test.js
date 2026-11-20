// Guest review scores on Department targets: the manager types in Booking.com / ReviewPro scores with their date.
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

test('three review scores to start with, none filled in yet', async () => {
  const rows = (await goals()).reviewScores;
  assert.deepEqual(rows.map((row) => [row.label, row.scale, row.target, row.latest]), [
    ['Booking.com – Overall', 10, null, null], ['Booking.com – Cleanliness', 10, null, null], ['ReviewPro – GRI', 100, null, null]
  ]);
});

test('scores are kept with their date; the latest and the one before are shown', async () => {
  const key = (await goals()).reviewScores[1].key;
  const add = (date, score, token = manager) => server.call('POST', `/api/goals/review-scores/${key}/entries`, { token, body: { date, score } });
  assert.equal((await add(hotelDate(-30), 8.6)).status, 201);
  assert.equal((await add(hotelDate(0), 8.9)).status, 201);
  const row = (await goals()).reviewScores[1];
  assert.equal(row.latest.score, 8.9);
  assert.equal(row.previous.score, 8.6);
  assert.equal(row.latest.by, 'Manager');
  assert.equal((await add(hotelDate(0), 11)).status, 400, 'not above the scale');
  assert.equal((await add(hotelDate(1), 9)).status, 400, 'not in the future');
  assert.equal((await add('2026-02-30', 9)).status, 400, 'a real date');
  assert.equal((await add(hotelDate(0), 9, supervisor.token)).status, 403, 'only managers');
  const removed = await server.call('DELETE', `/api/goals/review-scores/${key}/entries/${row.latest.id}`, { token: manager });
  assert.equal(removed.body.reviewScores[1].latest.score, 8.6);
});

test('managers add, rename and remove rows and set targets; a row with scores keeps its scale', async () => {
  const rows = (await goals()).reviewScores;
  const body = (list) => ({ rows: list.map(({ key, label, scale, target }) => ({ key, label, scale, target })) });
  const put = (list) => server.call('PUT', '/api/goals/review-scores', { token: manager, body: body(list) });
  const saved = await put([{ ...rows[1], label: 'Booking.com – Cleanliness score', target: 9.2 }, { ...rows[2], target: 90 }, { label: 'TripAdvisor', scale: 5, target: 4.5 }]);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.reviewScores.map((row) => [row.label, row.target]), [['Booking.com – Cleanliness score', 9.2], ['ReviewPro – GRI', 90], ['TripAdvisor', 4.5]]);
  assert.equal(saved.body.reviewScores[0].latest.score, 8.6, 'renaming keeps the history');
  assert.equal((await put([{ ...saved.body.reviewScores[0], scale: 100 }])).status, 400, 'scale is fixed once there are scores');
  assert.equal((await put([{ label: 'X', scale: 10, target: 12 }])).status, 400, 'target within the scale');
  assert.equal((await put([{ label: '', scale: 10 }])).status, 400, 'needs a name');
});
