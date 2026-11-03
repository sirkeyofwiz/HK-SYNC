// Inspection Rate Program reports filed before all five items were required can have a room with an item left blank.
// Supervisor performance judges that room on its total out of 50, the same as Goals & points.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startServer, login, createStaff, newDataDir, MANAGER, hotelDate } from './helpers.js';

const ITEMS = ['Bathroom', 'Bedroom', 'Balcony', 'Maintenance', 'Presentation Room'];
let server;
after(() => server?.stop());

test('a room with Presentation Room left blank counts as its total out of 50', async () => {
  // File a full report, then blank its Presentation Room in the saved data, as the older reports are.
  const first = await startServer();
  let manager = await login(first, MANAGER.email, MANAGER.password);
  const supervisor = await createStaff(first, manager, 'supervisor', 'Partial Sup');
  const scores = Object.fromEntries(ITEMS.map((item) => [item, '7']));
  const created = await first.call('POST', '/api/reports', { token: manager, body: { type: 'inspection_rate', date: hotelDate(0), data: { supervisorId: supervisor.user.id, area: 'Block 1', entries: [{ room: '101', scores, remarks: '' }] } } });
  assert.equal(created.status, 201);
  const db = new Database(path.join(first.dataDir, 'bahari.sqlite'));
  const report = JSON.parse(db.prepare('SELECT data FROM reports WHERE id = ?').get(created.body.report?.id || created.body.id).data);
  report.data.entries[0].scores['Presentation Room'] = '';
  db.prepare('UPDATE reports SET data = ? WHERE id = ?').run(JSON.stringify(report), report.id);
  db.close();
  const copy = newDataDir();
  fs.cpSync(first.dataDir, copy, { recursive: true });
  await first.stop();

  server = await startServer({}, { dataDir: copy });
  manager = await login(server, MANAGER.email, MANAGER.password);
  const { supervisors } = (await server.call('GET', '/api/hk-performance', { token: manager })).body;
  // 7 + 7 + 7 + 7 + blank = 28/50: under the pass mark (an average of the four scored items would have said 35/50).
  const row = supervisors.support.find((item) => item.name === 'Partial Sup');
  assert.ok(row, 'Partial Sup needs support');
  assert.equal(row.roomAverage, 28);
  assert.equal(row.failed, 1);
  const goals = (await server.call('GET', '/api/goals', { token: manager })).body.goals;
  assert.equal(goals.supervisorPoints.find((item) => item.name === 'Partial Sup').roomAverage, 28, 'the same as Goals & points');
});
