// Notes for the manager: a supervisor adds a note to their report or task, managers are told and can read it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, qualityReport } from './helpers.js';

let server;
let manager;
let supervisor;
let other;
let reportId;
let taskId;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
  other = await createStaff(server, manager, 'driver');
  reportId = (await server.call('POST', '/api/reports', { token: supervisor.token, body: qualityReport(9) })).body.report.id;
  taskId = (await server.call('POST', '/api/tasks', { token: manager, body: { title: 'Fix the tap', location: 'Room 214', assignedTo: supervisor.user.id } })).body.task.id;
});
after(() => server?.stop());

const call = (method, route, body, token = supervisor.token) => server.call(method, `/api/notes${route}`, { token, body });

test('a supervisor adds a note to their report; managers are told and see it', async () => {
  const added = await call('POST', '', { kind: 'report', id: reportId, text: '  Guest in 101 asked for late cleaning  ' });
  assert.equal(added.status, 201);
  assert.equal(added.body.note.text, 'Guest in 101 asked for late cleaning');
  const alerts = (await server.call('GET', '/api/notifications', { token: manager })).body.notifications;
  assert.ok(alerts.some((alert) => alert.type === 'note' && alert.link?.page === 'report' && alert.link.id === reportId && /late cleaning/.test(alert.body)));
  const read = await call('GET', `?kind=report&id=${reportId}`, undefined, manager);
  assert.deepEqual(read.body.notes.map((row) => row.text), ['Guest in 101 asked for late cleaning']);
  const listed = (await server.call('GET', '/api/reports', { token: manager })).body.reports.find((report) => report.id === reportId);
  assert.equal(listed.noteCount, 1);
  assert.equal((await server.call('GET', `/api/reports/${reportId}`, { token: supervisor.token })).body.report.noteCount, 1);
});

test('a note on a task counts on the task list', async () => {
  assert.equal((await call('POST', '', { kind: 'task', id: taskId, text: 'Waiting for maintenance' })).status, 201);
  const task = (await server.call('GET', '/api/tasks', { token: manager })).body.tasks.find((row) => row.id === taskId);
  assert.equal(task.noteCount, 1);
});

test('an empty note, or a report someone cannot open, is refused', async () => {
  assert.equal((await call('POST', '', { kind: 'report', id: reportId, text: '   ' })).status, 400);
  assert.equal((await call('POST', '', { kind: 'report', id: reportId, text: 'Hi' }, other.token)).status, 404);
  assert.equal((await call('GET', `?kind=task&id=${taskId}`, undefined, other.token)).status, 404);
  assert.equal((await call('POST', '', { kind: 'nothing', id: reportId, text: 'Hi' })).status, 400);
});

test('only the writer or a manager can delete a note', async () => {
  const note = (await call('POST', '', { kind: 'task', id: taskId, text: 'Second note' })).body.note;
  const colleague = await createStaff(server, manager, 'supervisor');
  // Supervisors can open each other's tasks, but not delete each other's notes.
  assert.equal((await call('DELETE', `/${note.id}`, undefined, colleague.token)).status, 403);
  assert.equal((await call('DELETE', `/${note.id}`, undefined, manager)).status, 200);
  const left = (await call('GET', `?kind=task&id=${taskId}`)).body.notes;
  assert.deepEqual(left.map((row) => row.text), ['Waiting for maintenance']);
});
