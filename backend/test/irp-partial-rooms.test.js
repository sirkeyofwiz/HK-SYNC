// Inspection Rate Program rooms filed before Entrance Area was added have five items (out of 50, pass at 30); new rooms
// have six (out of 60, pass at 36). Some older rooms also left an item blank. Each room is judged on its own items, and
// averages put every room on the 60 scale.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startServer, login, createStaff, newDataDir, MANAGER, hotelDate } from './helpers.js';

const ITEMS = ['Bathroom', 'Bedroom', 'Balcony', 'Maintenance', 'Presentation Room', 'Entrance Area'];
const scores = (value) => Object.fromEntries(ITEMS.map((item) => [item, String(value)]));
let server;
let manager;
let partial;
let older;
let mixed;
let olderReportId;

before(async () => {
  // File full reports, then turn them into older five-item rooms in the saved data, as the older reports are.
  const first = await startServer();
  let token = await login(first, MANAGER.email, MANAGER.password);
  const file = async (supervisor, rooms) => (await first.call('POST', '/api/reports', { token, body: { type: 'inspection_rate', date: hotelDate(0), data: { supervisorId: supervisor.user.id, area: 'Block 1', entries: rooms } } })).body.report.id;
  const p = await createStaff(first, token, 'supervisor', 'Partial Sup');
  const o = await createStaff(first, token, 'supervisor', 'Older Sup');
  const m = await createStaff(first, token, 'supervisor', 'Mixed Sup');
  const partialId = await file(p, [{ room: '101', scores: scores(7), remarks: '' }]);
  const olderId = await file(o, [{ room: '102', scores: scores(7), remarks: '' }]);
  const mixedOld = await file(m, [{ room: '103', scores: scores(6), remarks: '' }]);
  await file(m, [{ room: '104', scores: scores(6), remarks: '' }, { room: '105', scores: { ...scores(6), 'Entrance Area': '5' }, remarks: '' }]);
  const db = new Database(path.join(first.dataDir, 'bahari.sqlite'));
  const change = (id, edit) => { const report = JSON.parse(db.prepare('SELECT data FROM reports WHERE id = ?').get(id).data); for (const entry of report.data.entries) edit(entry.scores); db.prepare('UPDATE reports SET data = ? WHERE id = ?').run(JSON.stringify(report), id); };
  change(partialId, (s) => { delete s['Entrance Area']; s['Presentation Room'] = ''; });
  change(olderId, (s) => { delete s['Entrance Area']; });
  change(mixedOld, (s) => { delete s['Entrance Area']; });
  db.close();
  const copy = newDataDir();
  fs.cpSync(first.dataDir, copy, { recursive: true });
  await first.stop();
  server = await startServer({}, { dataDir: copy });
  manager = await login(server, MANAGER.email, MANAGER.password);
  [partial, older, mixed] = [p, o, m];
  olderReportId = olderId;
});
after(() => server?.stop());

test('a five-item room with Presentation Room left blank counts as 28/50, which is 33.6 on the 60 scale', async () => {
  const { supervisors } = (await server.call('GET', '/api/hk-performance', { token: manager })).body;
  // 7 + 7 + 7 + 7 + blank = 28/50: under its pass mark (30/50), and 33.6/60 on the shared scale.
  const row = supervisors.support.find((item) => item.name === 'Partial Sup');
  assert.ok(row, 'Partial Sup needs support');
  assert.equal(row.roomAverage, 33.6);
  assert.equal(row.failed, 1);
  const goals = (await server.call('GET', '/api/goals', { token: manager })).body.goals;
  const points = goals.supervisorPoints.find((item) => item.id === partial.user.id);
  assert.equal(points.roomAverage, 33.6, 'the same as Goals & points');
  assert.equal(points.points, 0);
});

test('each room passes on its own mark: 30/50 for five items, 36/60 for six, and adds its real total', async () => {
  const goals = (await server.call('GET', '/api/goals', { token: manager })).body.goals;
  const row = (supervisor) => goals.supervisorPoints.find((item) => item.id === supervisor.user.id);
  // Older Sup: one five-item room of 35/50 passes and adds 35.
  assert.deepEqual([row(older).points, row(older).passedRooms, row(older).roomAverage], [35, 1, 42]);
  // Mixed Sup: 30/50 (old, passes, +30), 36/60 (new, passes, +36), 35/60 (new, Entrance Area 5: fails).
  assert.deepEqual([row(mixed).points, row(mixed).passedRooms, row(mixed).rooms], [66, 2, 3]);
  assert.equal(row(mixed).passMark, 36);
});

test('a new report needs Entrance Area; an older five-item report can be edited without it', async () => {
  const supervisor = await createStaff(server, manager, 'supervisor');
  const { 'Entrance Area': _, ...five } = scores(8);
  const refused = await server.call('POST', '/api/reports', { token: manager, body: { type: 'inspection_rate', date: hotelDate(0), data: { supervisorId: supervisor.user.id, area: 'Block 2', entries: [{ room: '201', scores: five, remarks: '' }] } } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /Entrance Area\. All six items are needed/);
  const old = (await server.call('GET', `/api/reports/${olderReportId}`, { token: manager })).body.report;
  const edited = await server.call('PUT', `/api/reports/${olderReportId}`, { token: manager, body: { data: { ...old.data, entries: old.data.entries.map((entry) => ({ ...entry, remarks: 'Checked again' })) } } });
  assert.equal(edited.status, 200);
  // Adding Entrance Area to the older room makes it a six-item room: out of 60.
  const upgraded = await server.call('PUT', `/api/reports/${olderReportId}`, { token: manager, body: { data: { ...old.data, entries: old.data.entries.map((entry) => ({ ...entry, scores: { ...entry.scores, 'Entrance Area': '7' } })) } } });
  assert.equal(upgraded.status, 200);
  const goals = (await server.call('GET', '/api/goals', { token: manager })).body.goals;
  assert.equal(goals.supervisorPoints.find((item) => item.id === older.user.id).points, 42);
});
