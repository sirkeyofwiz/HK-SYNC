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
  const saved = await submit('upholstery', [{ room: '205', items: ['Bed runner', 'Sofa', 'Armchair', 'Television'] }]);
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.report.data.entries[0].items, ['Armchair', 'Sofa', 'Bed runner']);
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

test('history: every record of a room, newest first, and earlier months of the drainage sheet', async () => {
  await submit('mattress_rotation', [{ room: '108', hkName: 'Sarah Mussa', remarks: 'Mattress stained' }], hotelDate(-200));
  await submit('mattress_rotation', [{ room: '108', hkName: 'Sarah Mussa' }], hotelDate(-60));
  const history = (await server.call('GET', '/api/room-care/history?type=mattress_rotation&key=108', { token: manager })).body.rows;
  assert.deepEqual(history.map((row) => row.date), [hotelDate(-60), hotelDate(-200)]);
  assert.equal(history[1].remarks, 'Mattress stained');
  // All records of a log, for the history list.
  const all = (await server.call('GET', '/api/room-care/history?type=mattress_rotation', { token: supervisor.token })).body.rows;
  assert.ok(all.length >= 5 && all[0].date >= all[all.length - 1].date);
  assert.equal((await server.call('GET', '/api/room-care/history?type=nothing', { token: manager })).status, 400);
  assert.equal((await server.call('GET', '/api/room-care/history?type=drainage', { token: driver.token })).status, 403);
  // Drainage in an earlier month shows on that month's sheet only.
  const old = hotelDate(-70);
  await submit('drainage', [{ block: 'Block 9', status: 'Done' }], old);
  const then = (await server.call('GET', `/api/room-care?month=${old.slice(0, 7)}`, { token: manager })).body.tracker.drainage;
  assert.equal(then.month, old.slice(0, 7));
  assert.equal(then.weeks['Block 9'][0].date, old);
  const now = (await tracker()).tracker.drainage;
  assert.equal(now.weeks['Block 9'].length, 0);
  // A future month falls back to this month.
  assert.equal((await server.call('GET', '/api/room-care?month=2999-01', { token: manager })).body.tracker.drainage.month, now.month);
});
