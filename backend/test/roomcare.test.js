// Room care: mattress rotation, upholstery and water drainage logs, and the tracker of what is due.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let supervisor;
let driver;
before(async () => {
  // Old dates are needed to see rooms fall due.
  server = await startServer({ ALLOW_ANY_REPORT_DATE: '1' });
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
  driver = await createStaff(server, manager, 'driver');
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: [{ name: 'Sarah Mussa' }] } });
});
after(() => server?.stop());

const submit = (type, entries, date = hotelDate(0), token = supervisor.token) => server.call('POST', '/api/reports', { token, body: { type, date, data: { entries } } });
const tracker = async (token = manager) => (await server.call('GET', '/api/room-care', { token })).body;

test('mattress rotation: a real room and the housekeeper are needed; the name takes the roster spelling', async () => {
  assert.match((await submit('mattress_rotation', [{ room: '999', hkName: 'Sarah Mussa' }])).body.message, /not one of the hotel's rooms/);
  assert.match((await submit('mattress_rotation', [{ room: '101', hkName: '' }])).body.message, /choose the housekeeper/);
  assert.match((await submit('mattress_rotation', [{ room: '101', hkName: 'Sarah Mussa' }, { room: '101', hkName: 'Sarah Mussa' }])).body.message, /twice/);
  const saved = await submit('mattress_rotation', [{ room: '101', hkName: 'sarah mussa' }, { room: '1905', hkName: 'Sarah Mussa' }]);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.report.data.entries[0].hkName, 'Sarah Mussa');
  assert.equal(saved.body.report.flagged, false);
});

test('upholstery: at least one item ticked, only known items kept', async () => {
  assert.match((await submit('upholstery', [{ room: '205', items: [] }])).body.message, /tick what was cleaned/);
  const saved = await submit('upholstery', [{ room: '205', items: ['Sofa', 'Armchair', 'Television'] }]);
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.report.data.entries[0].items, ['Armchair', 'Sofa']);
});

test('drainage: only marked blocks are kept, and an issue needs a remark and flags the report', async () => {
  assert.match((await submit('drainage', [{ block: 'Block 1', status: '' }])).body.message, /at least one block/);
  assert.match((await submit('drainage', [{ block: 'Block 2', status: 'Issue', remarks: '' }])).body.message, /plumbing issue/);
  const clear = await submit('drainage', [{ block: 'Block 1', status: 'Done' }, { block: 'Block 3', status: '' }]);
  assert.equal(clear.status, 201);
  assert.deepEqual(clear.body.report.data.entries.map((line) => line.block), ['Block 1']);
  const issue = await submit('drainage', [{ block: 'Block 2', status: 'Issue', remarks: 'Shower drains slowly in 204' }]);
  assert.equal(issue.body.report.flagged, true);
  const alerts = (await server.call('GET', '/api/notifications', { token: manager })).body.notifications;
  assert.ok(alerts.some((alert) => alert.type === 'report_flagged' && /Water Drainage/.test(alert.title)));
});

test('the tracker shows when each room was last done and what is due', async () => {
  // Rotated 5 months ago: due again (every 4 months). Rotated today (above): not due.
  await submit('mattress_rotation', [{ room: '102', hkName: 'Sarah Mussa' }], hotelDate(-150));
  const { tracker: all, blocks } = await tracker();
  assert.equal(blocks.length, 25);
  const mattress = all.mattress_rotation;
  assert.equal(mattress.rows.length, 207);
  const room = (key) => mattress.rows.find((row) => row.key === key);
  assert.equal(room('101').due, false);
  assert.equal(room('101').last.hkName, 'Sarah Mussa');
  assert.equal(room('102').due, true);
  assert.equal(room('103').last, null);
  assert.equal(mattress.dueCount, 205); // all but 101 and 1905
  // Upholstery and drainage are monthly; drainage also shows this month's weeks per block.
  assert.equal(all.upholstery.rows.find((row) => row.key === '205').due, false);
  const drainage = all.drainage;
  assert.equal(drainage.rows.find((row) => row.key === 'Block 2').last.status, 'Issue');
  assert.equal(drainage.weeks['Block 1'][0].status, 'Done');
});

test('supervisors can see the tracker; drivers cannot file or see room care', async () => {
  assert.equal((await server.call('GET', '/api/room-care', { token: supervisor.token })).status, 200);
  assert.equal((await server.call('GET', '/api/room-care', { token: driver.token })).status, 403);
  assert.equal((await submit('drainage', [{ block: 'Block 1', status: 'Done' }], hotelDate(0), driver.token)).status, 403);
});
