// Room care: mattress rotation, upholstery and water drainage logs, and the tracker of what is due.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startServer, login, createStaff, newDataDir, MANAGER, hotelDate } from './helpers.js';

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
  const saved = await submit('upholstery', [{ room: '205', items: ['New rooms TV table chair', 'Bed runner', 'Sofa', 'Armchair', 'Television'] }]);
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.report.data.entries[0].items, ['Armchair', 'Sofa', 'Bed runner', 'New rooms TV table chair']);
});

test('drainage: one line per room, Done or Issue; an issue needs a remark and flags the report', async () => {
  assert.match((await submit('drainage', [{ room: '', status: 'Done' }])).body.message, /at least one room/);
  assert.match((await submit('drainage', [{ room: '999', status: 'Done' }])).body.message, /not one of the hotel's rooms/);
  assert.match((await submit('drainage', [{ room: '301', status: '' }])).body.message, /Room 301: choose Done or Issue/);
  assert.match((await submit('drainage', [{ room: '301', status: 'Done' }, { room: '301', status: 'Done' }])).body.message, /twice/);
  assert.match((await submit('drainage', [{ room: '204', status: 'Issue', remarks: '' }])).body.message, /Room 204: say what the plumbing issue is/);
  // A report by block is refused now: it would not count for any room.
  assert.match((await submit('drainage', [{ block: 'Block 1', status: 'Done' }])).body.message, /choose the room/);
  const clear = await submit('drainage', [{ room: '301', status: 'Done' }, { room: '302', status: 'Done' }]);
  assert.equal(clear.status, 201);
  assert.deepEqual(clear.body.report.data.entries.map((line) => line.room), ['301', '302']);
  assert.equal(clear.body.report.flagged, false);
  const issue = await submit('drainage', [{ room: '204', status: 'Issue', remarks: 'Shower drains slowly' }]);
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
  // Upholstery and drainage are monthly, and drainage goes room by room like the others.
  assert.equal(all.upholstery.rows.find((row) => row.key === '205').due, false);
  const drainage = all.drainage;
  assert.equal(drainage.by, 'room');
  assert.equal(drainage.rows.length, 207);
  assert.equal(drainage.rows.find((row) => row.key === '204').last.status, 'Issue');
  assert.equal(drainage.rows.find((row) => row.key === '301').due, false);
  assert.equal(drainage.dueCount, 204);
});

test('supervisors can see the tracker; drivers cannot file or see room care', async () => {
  assert.equal((await server.call('GET', '/api/room-care', { token: supervisor.token })).status, 200);
  assert.equal((await server.call('GET', '/api/room-care', { token: driver.token })).status, 403);
  assert.equal((await submit('drainage', [{ room: '301', status: 'Done' }], hotelDate(0), driver.token)).status, 403);
});

test('history: every record of a room, newest first; a room falls due again a month after draining', async () => {
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
  // Drained 70 days ago: in its history, and due again.
  const old = hotelDate(-70);
  await submit('drainage', [{ room: '905', status: 'Done' }], old);
  const rows = (await server.call('GET', '/api/room-care/history?type=drainage&key=905', { token: manager })).body.rows;
  assert.deepEqual(rows.map((row) => row.date), [old]);
  const room = (await tracker()).tracker.drainage.rows.find((row) => row.key === '905');
  assert.equal(room.last.date, old);
  assert.equal(room.due, true);
});

test('an older drainage report filed by block stays in history, counts for no room, and can still be edited', async () => {
  // File by room, then turn it into a block report in the saved data, as the older reports are.
  const first = await startServer();
  let token = await login(first, MANAGER.email, MANAGER.password);
  const created = await first.call('POST', '/api/reports', { token, body: { type: 'drainage', date: hotelDate(0), data: { entries: [{ room: '401', status: 'Done' }] } } });
  const id = created.body.report.id;
  const db = new Database(path.join(first.dataDir, 'bahari.sqlite'));
  const stored = JSON.parse(db.prepare('SELECT data FROM reports WHERE id = ?').get(id).data);
  stored.data.entries = [{ block: 'Block 4', status: 'Done', remarks: '' }];
  db.prepare('UPDATE reports SET data = ? WHERE id = ?').run(JSON.stringify(stored), id);
  db.close();
  const copy = newDataDir();
  fs.cpSync(first.dataDir, copy, { recursive: true });
  await first.stop();
  const later = await startServer({}, { dataDir: copy });
  try {
    token = await login(later, MANAGER.email, MANAGER.password);
    const { tracker: all } = (await later.call('GET', '/api/room-care', { token })).body;
    assert.equal(all.drainage.rows.find((row) => row.key === '401').last, null, 'a block record does not say this room was drained');
    assert.equal(all.drainage.neverCount, 207);
    const history = (await later.call('GET', '/api/room-care/history?type=drainage', { token })).body.rows;
    assert.deepEqual(history.map((row) => row.key), ['Block 4']);
    const edited = await later.call('PUT', `/api/reports/${id}`, { token, body: { data: { entries: [{ block: 'Block 4', status: 'Issue', remarks: 'Slow drain in 403' }, { room: '402', status: 'Done' }] } } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.report.flagged, true);
    const after = (await later.call('GET', '/api/room-care', { token })).body.tracker.drainage;
    assert.equal(after.rows.find((row) => row.key === '402').last.status, 'Done');
  } finally {
    await later.stop();
  }
});
