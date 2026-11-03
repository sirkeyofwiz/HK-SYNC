// Overview "Housekeeper performance": everyone inspected in the last 30 days is on one of the two lists, split at 7.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let supervisor;
const SCORES = [['Fay Nine', 9, 9], ['Bea Eight', 8, 8], ['Cia SevenFive', 7, 8], ['Ana Seven', 7, 7], ['Gia Seven', 7, 7], ['Hana Seven', 7, 7], ['Dee SixFive', 6, 7], ['Eve Five', 5, 5]];
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: SCORES.map(([name]) => ({ name })) } });
});
after(() => server?.stop());

test('7 and above is doing well, under 7 needs support, and nobody is cut off', async () => {
  const entries = SCORES.map(([hkName, a, b], index) => ({ room: String(101 + index), hkName, scores: { Wardrobe: String(a), Shower: String(b) } }));
  assert.equal((await server.call('POST', '/api/reports', { token: supervisor.token, body: { type: 'quality', date: hotelDate(0), data: { block: 'B1', entries } } })).status, 201);
  const body = (await server.call('GET', '/api/hk-performance', { token: manager })).body;
  assert.equal(body.goodAt, 7);
  assert.equal(body.supportBelow, 7);
  // Six at 7 or more: more than the old cap of five, and the 7s that used to fall between the lists.
  assert.deepEqual(body.top.map((row) => row.average), [9, 8, 7.5, 7, 7, 7]);
  assert.deepEqual(body.support.map((row) => [row.name, row.average]), [['Eve Five', 5], ['Dee SixFive', 6.5]]);
  assert.equal(body.top.length + body.support.length, body.inspected, 'every inspected housekeeper is on a list');
});
