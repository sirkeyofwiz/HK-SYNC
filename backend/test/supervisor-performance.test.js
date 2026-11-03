// Overview "Supervisor performance": supervisors ranked by their Inspection Rate Program rooms in the last 30 days.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
before(async () => {
  server = await startServer({ ALLOW_ANY_REPORT_DATE: '1' });
  manager = await login(server, MANAGER.email, MANAGER.password);
});
after(() => server?.stop());

const ITEMS = ['Bathroom', 'Bedroom', 'Balcony', 'Maintenance', 'Presentation Room'];
// One room with these five scores (Bathroom, Bedroom, Balcony, Maintenance, Presentation Room).
const room = (scores) => ({ room: '101', scores: Object.fromEntries(ITEMS.map((item, index) => [item, String(scores[index])])), remarks: '' });
const inspect = (supervisor, rooms, date = hotelDate(0)) => server.call('POST', '/api/reports', { token: manager, body: { type: 'inspection_rate', date, data: { supervisorId: supervisor.user.id, area: 'Block 1', entries: rooms } } });

test('supervisors are split at the 30/50 pass mark, with the weakest item and failed rooms', async () => {
  const strong = await createStaff(server, manager, 'supervisor', 'Strong Sup');
  const weak = await createStaff(server, manager, 'supervisor', 'Weak Sup');
  const middle = await createStaff(server, manager, 'supervisor', 'Middle Sup');
  const edge = await createStaff(server, manager, 'supervisor', 'Edge Sup');
  const unseen = await createStaff(server, manager, 'supervisor', 'Unseen Sup');
  assert.equal((await inspect(strong, [room([9, 9, 8, 9, 9]), room([8, 9, 9, 8, 9])])).status, 201);
  await inspect(weak, [room([7, 3, 6, 7, 6]), room([5, 4, 5, 6, 5])]);
  await inspect(middle, [room([7, 8, 7, 7, 8])]);
  // Exactly 30/50 is doing well.
  await inspect(edge, [room([6, 6, 6, 6, 6])]);
  // An inspection older than 30 days doesn't count.
  await inspect(unseen, [room([2, 2, 2, 2, 2])], hotelDate(-40));
  const { supervisors } = (await server.call('GET', '/api/hk-performance', { token: manager })).body;
  assert.equal(supervisors.passAt, 30);
  assert.deepEqual(supervisors.top.map((row) => [row.name, row.roomAverage]), [['Strong Sup', 43.5], ['Middle Sup', 37], ['Edge Sup', 30]]);
  assert.deepEqual(supervisors.support.map((row) => [row.name, row.roomAverage]), [['Weak Sup', 27]]);
  const weakRow = supervisors.support[0];
  assert.equal(weakRow.rooms, 2);
  assert.equal(weakRow.failed, 2, 'both rooms (29/50 and 25/50) are under the 30/50 pass mark');
  assert.equal(weakRow.weakest.label, 'Bedroom');
  assert.equal(weakRow.weakest.average, 3.5);
  assert.deepEqual(supervisors.notInspected.map((row) => row.name), ['Unseen Sup']);
  assert.equal(supervisors.inspected, 4);
  assert.equal(supervisors.total, 5);
});

test('only managers see it', async () => {
  const supervisor = await createStaff(server, manager, 'supervisor');
  assert.equal((await server.call('GET', '/api/hk-performance', { token: supervisor.token })).status, 403);
});
