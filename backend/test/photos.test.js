// Report photos are kept as files on the volume, not inside the reports, while the app sees the same photos as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { startServer, login, createStaff, newDataDir, MANAGER, qualityReport, hotelDate, PHOTO } from './helpers.js';

// A second, different valid picture (1x1 PNG of another colour).
const OTHER_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let server;
let manager;
let supervisor;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
});
after(() => server?.stop());

const photoFiles = (dataDir) => fs.readdirSync(path.join(dataDir, 'report-photos')).filter((name) => !name.endsWith('.tmp'));
// What is stored for a report in the database itself, read straight from the file.
const storedReport = (dataDir, id) => {
  const db = new Database(path.join(dataDir, 'bahari.sqlite'), { readonly: true });
  try { return JSON.parse(db.prepare('SELECT data FROM reports WHERE id = ?').get(id).data); } finally { db.close(); }
};

test('a new photo is saved as a file and the report only names it', async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisor.token, body: qualityReport(9, { photo: PHOTO }) });
  assert.equal(created.status, 201);
  const id = created.body.report.id;
  const line = storedReport(server.dataDir, id).data.entries[0];
  assert.equal(line.photo, undefined, 'no picture inside the database');
  assert.match(line.photoFile, /^[0-9a-f]{64}\.png$/);
  assert.ok(photoFiles(server.dataDir).includes(line.photoFile));
  const full = await server.call('GET', `/api/reports/${id}`, { token: manager });
  assert.equal(full.body.report.data.entries[0].photo, PHOTO, 'the app gets the same picture back');
  assert.equal(full.body.report.data.entries[0].photoFile, undefined);
});

test('saving an edit with the same photo does not store it twice', async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisor.token, body: qualityReport(9, { photo: OTHER_PHOTO }) });
  const id = created.body.report.id;
  const filesBefore = photoFiles(server.dataDir).length;
  // The app opens the full report to edit it and sends every photo back.
  const opened = await server.call('GET', `/api/reports/${id}`, { token: supervisor.token });
  const data = opened.body.report.data;
  data.entries[0].remarks = 'Re-checked';
  assert.equal((await server.call('PUT', `/api/reports/${id}`, { token: supervisor.token, body: { data } })).status, 200);
  assert.equal(photoFiles(server.dataDir).length, filesBefore);
  const after = await server.call('GET', `/api/reports/${id}`, { token: manager });
  assert.equal(after.body.report.data.entries[0].photo, OTHER_PHOTO);
  assert.equal(after.body.report.data.entries[0].remarks, 'Re-checked');
});

test('an edit can replace a photo', async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisor.token, body: qualityReport(9, { photo: PHOTO }) });
  const id = created.body.report.id;
  assert.equal((await server.call('PUT', `/api/reports/${id}`, { token: supervisor.token, body: { data: qualityReport(9, { photo: OTHER_PHOTO }).data } })).status, 200);
  const after = await server.call('GET', `/api/reports/${id}`, { token: manager });
  assert.equal(after.body.report.data.entries[0].photo, OTHER_PHOTO);
});

test('the app cannot point a report at a file of its choosing', async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisor.token, body: qualityReport(9, { photoFile: '../bahari.sqlite' }) });
  assert.equal(created.status, 201);
  assert.equal(storedReport(server.dataDir, created.body.report.id).data.entries[0].photoFile, undefined);
  const full = await server.call('GET', `/api/reports/${created.body.report.id}`, { token: manager });
  assert.ok(!full.body.report.data.entries[0].photo);
});

test('the report list still says which lines have a photo', async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisor.token, body: qualityReport(9, { photo: PHOTO }) });
  const list = await server.call('GET', '/api/reports', { token: manager });
  const line = list.body.reports.find((report) => report.id === created.body.report.id).data.entries[0];
  assert.equal(line.hasPhoto, true);
  assert.equal(line.photo, undefined);
  assert.equal(line.photoFile, undefined);
});

test('photos inside older reports are moved into files when the server starts', async () => {
  // A database as it is today on the live server: the photo sits inside the report.
  const dataDir = newDataDir();
  const id = randomUUID();
  const old = { id, type: 'trolley_pantry', date: hotelDate(), submittedBy: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hodSignature: null,
    data: { trolleys: [{ block: '3', hkName: 'Old Housekeeper', scores: { Clean: 8 }, remarks: '', photo: PHOTO }], pantries: [{ block: '3', hkName: '', scores: { Clean: 9 }, remarks: '', photo: OTHER_PHOTO }] } };
  const db = new Database(path.join(dataDir, 'bahari.sqlite'));
  db.exec('CREATE TABLE reports (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  db.prepare('INSERT INTO reports (id, data) VALUES (?, ?)').run(id, JSON.stringify(old));
  db.close();

  const upgraded = await startServer({}, { dataDir });
  try {
    assert.match(upgraded.output(), /moved the photos of 1 report into files/);
    const stored = storedReport(dataDir, id).data;
    assert.equal(stored.trolleys[0].photo, undefined);
    assert.equal(stored.pantries[0].photo, undefined);
    assert.equal(photoFiles(dataDir).length, 2);
    const token = await login(upgraded, MANAGER.email, MANAGER.password);
    const full = await upgraded.call('GET', `/api/reports/${id}`, { token });
    assert.equal(full.body.report.data.trolleys[0].photo, PHOTO);
    assert.equal(full.body.report.data.pantries[0].photo, OTHER_PHOTO);
    assert.equal(full.body.report.data.trolleys[0].hkName, 'Old Housekeeper', 'everything else is untouched');
  } finally {
    await upgraded.stop();
  }
});

test('a missing photo file shows no photo instead of breaking the report', async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisor.token, body: qualityReport(4, { photo: PHOTO, remarks: 'Stain' }) });
  const name = storedReport(server.dataDir, created.body.report.id).data.entries[0].photoFile;
  fs.renameSync(path.join(server.dataDir, 'report-photos', name), path.join(server.dataDir, 'report-photos', `${name}.hidden`));
  try {
    const full = await server.call('GET', `/api/reports/${created.body.report.id}`, { token: manager });
    assert.equal(full.status, 200);
    assert.equal(full.body.report.data.entries[0].photo, null);
    assert.equal(full.body.report.data.entries[0].remarks, 'Stain');
  } finally {
    fs.renameSync(path.join(server.dataDir, 'report-photos', `${name}.hidden`), path.join(server.dataDir, 'report-photos', name));
  }
});
