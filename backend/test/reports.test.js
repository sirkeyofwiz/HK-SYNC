// Submitting, checking, flagging, signing, editing and deleting reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, qualityReport, hotelDate, PHOTO } from './helpers.js';

let server;
let manager;
let supervisor;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
});
after(() => server?.stop());

const submit = (body, token = supervisor.token) => server.call('POST', '/api/reports', { token, body });

test('a good report is saved with its average and is not flagged', async () => {
  const { status, body } = await submit(qualityReport(9));
  assert.equal(status, 201);
  assert.equal(body.report.average, 9);
  assert.equal(body.report.itemCount, 1);
  assert.equal(body.report.flagged, false);
});

test('scores outside 0-10 are refused', async () => {
  assert.equal((await submit(qualityReport(11))).status, 400);
  assert.equal((await submit(qualityReport(-1))).status, 400);
  assert.equal((await submit(qualityReport('abc'))).status, 400);
});

test('report dates: up to 7 days back, never in the future', async () => {
  assert.equal((await submit({ ...qualityReport(), date: hotelDate(-7) })).status, 201);
  assert.equal((await submit({ ...qualityReport(), date: hotelDate(-9) })).status, 400);
  assert.equal((await submit({ ...qualityReport(), date: hotelDate(3) })).status, 400);
  assert.equal((await submit({ ...qualityReport(), date: 'yesterday' })).status, 400);
});

test('broken or oversized reports are refused', async () => {
  assert.equal((await submit({ type: 'quality', date: hotelDate() })).status, 400, 'no details');
  assert.equal((await submit({ type: 'quality', date: hotelDate(), data: { entries: 'not a list' } })).status, 400);
  const tooMany = qualityReport();
  tooMany.data.entries = Array.from({ length: 201 }, () => tooMany.data.entries[0]);
  assert.equal((await submit(tooMany)).status, 400);
});

test('photos must be pictures taken in the app, never web links', async () => {
  assert.equal((await submit(qualityReport(9, { photo: 'https://example.com/a.jpg' }))).status, 400);
  assert.equal((await submit(qualityReport(9, { photo: 'data:text/html;base64,PGgxPg==' }))).status, 400);
  assert.equal((await submit(qualityReport(9, { photo: PHOTO }))).status, 201);
});

test('the report list leaves photos out; opening the report includes them', async () => {
  const created = await submit(qualityReport(9, { photo: PHOTO }));
  const id = created.body.report.id;
  const list = await server.call('GET', '/api/reports', { token: manager });
  const listed = list.body.reports.find((report) => report.id === id);
  assert.equal(listed.data.entries[0].photo, undefined);
  assert.equal(listed.data.entries[0].hasPhoto, true);
  const full = await server.call('GET', `/api/reports/${id}`, { token: manager });
  assert.equal(full.body.report.data.entries[0].photo, PHOTO);
});

test('a low score flags the report and alerts the managers', async () => {
  const { body } = await submit(qualityReport(3));
  assert.equal(body.report.flagged, true);
  const alerts = await server.call('GET', '/api/notifications', { token: manager });
  assert.ok(alerts.body.notifications.some((alert) => alert.type === 'report_flagged' && alert.link?.id === body.report.id));
});

test('a handover that needs a manager must say why', async () => {
  const handover = (data) => ({ type: 'handover', date: hotelDate(), data: { notes: '', ...data } });
  assert.equal((await submit(handover({ needsManager: true }))).status, 400);
  const ok = await submit(handover({ needsManager: true, managerTopic: 'Guest complaint', managerNote: 'Room 12 noise' }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.report.flagged, true);
});

test('after sign-off only a manager can change or delete a report', async () => {
  const created = await submit(qualityReport(9));
  const id = created.body.report.id;
  assert.equal((await server.call('PUT', `/api/reports/${id}`, { token: supervisor.token, body: { data: qualityReport(8).data } })).status, 200, 'editable before sign-off');
  assert.equal((await server.call('POST', `/api/reports/${id}/sign`, { token: manager })).status, 200);
  assert.equal((await server.call('PUT', `/api/reports/${id}`, { token: supervisor.token, body: { data: qualityReport(2).data } })).status, 403);
  assert.equal((await server.call('DELETE', `/api/reports/${id}`, { token: supervisor.token })).status, 403);
  const edited = await server.call('PUT', `/api/reports/${id}`, { token: manager, body: { data: qualityReport(7).data } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.report.average, 7);
  const alerts = await server.call('GET', '/api/notifications', { token: supervisor.token });
  assert.ok(alerts.body.notifications.some((alert) => alert.type === 'report_signed' && alert.link?.id === id), 'the supervisor hears it was signed');
});

test('a deleted report disappears for everyone', async () => {
  const created = await submit(qualityReport(9));
  const id = created.body.report.id;
  assert.equal((await server.call('DELETE', `/api/reports/${id}`, { token: supervisor.token })).status, 200);
  assert.equal((await server.call('GET', `/api/reports/${id}`, { token: manager })).status, 404);
  const list = await server.call('GET', '/api/reports', { token: manager });
  assert.ok(!list.body.reports.some((report) => report.id === id));
});

test('oversized photos and padded-out reports are refused', async () => {
  const hugePhoto = `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024 + 4)}`;
  assert.equal((await submit(qualityReport(9, { photo: hugePhoto }))).status, 400);
  assert.equal((await submit(qualityReport(9, { remarks: 'x'.repeat(600 * 1024) }))).status, 400);
  const padded = qualityReport(9);
  padded.data.junk = 'x'.repeat(600 * 1024);
  assert.equal((await submit(padded)).status, 400, 'extra fields count too');
  assert.equal((await submit(qualityReport(9, { remarks: 'Stain on the carpet near the balcony door. '.repeat(20) }))).status, 201, 'long real remarks are fine');
});

const newTask = (changes) => server.call('POST', '/api/tasks', { token: manager, body: { title: 'Fix tap', location: 'Room 12', priority: 'medium', ...changes } });

test('a task needs a real title and location', async () => {
  assert.equal((await newTask({ title: { not: 'text' } })).status, 400);
  assert.equal((await newTask({ title: '   ' })).status, 400);
  assert.equal((await newTask({ location: ['Lobby'] })).status, 400);
  assert.equal((await newTask({ title: 'x'.repeat(5000) })).status, 400);
});

test('a task priority must be one the app knows', async () => {
  assert.equal((await newTask({ priority: 'whenever' })).status, 400);
  for (const priority of ['low', 'medium', 'urgent']) assert.equal((await newTask({ priority })).status, 201);
});

test('a task can only be assigned to an active colleague', async () => {
  assert.equal((await newTask({ assignedTo: 'nobody' })).status, 400);
  const leaver = await createStaff(server, manager, 'driver');
  await server.call('PATCH', `/api/users/${leaver.user.id}/status`, { token: manager, body: { active: false } });
  assert.equal((await newTask({ assignedTo: leaver.user.id })).status, 400);
  assert.equal((await newTask({ assignedTo: supervisor.user.id })).status, 201);
});

test('a task due date must be a real date, or left blank', async () => {
  assert.equal((await newTask({ dueDate: 'tomorrow' })).status, 400);
  assert.equal((await newTask({ dueDate: hotelDate(1) })).status, 201);
});

test('tasks the app sends today are still accepted', async () => {
  // The New task form with nobody chosen and no date, and the "＋ Task" follow-up button on a report.
  const blank = await newTask({ title: 'Check minibar', location: 'Room 7', assignedTo: '', dueDate: '' });
  assert.equal(blank.status, 201);
  assert.equal(blank.body.task.assignedTo, null);
  assert.equal(blank.body.task.dueDate, null);
  assert.equal((await newTask({ title: 'Quality Checklist follow-up', location: 'Block A', priority: 'urgent', dueDate: hotelDate() })).status, 201);
  const trimmed = await newTask({ title: '  Fix tap  ' });
  assert.equal(trimmed.body.task.title, 'Fix tap');
});
