// Task reminders: an open task reminds its assignee (here every second instead of every hour) until it is completed;
// the manager who assigned it hears once when it is overdue.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let supervisor;
before(async () => {
  server = await startServer({ TASK_REMINDER_MINUTES: String(1 / 60), TASK_REMINDER_CHECK_MS: '200' });
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
  // Tests can run at night: switch the supervisor's quiet hours off, except in the quiet-hours test.
  await server.call('PUT', '/api/users/me/notify', { token: supervisor.token, body: { quietHours: { enabled: false } } });
});
after(() => server?.stop());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newTask = async (fields = {}) => (await server.call('POST', '/api/tasks', { token: manager, body: { title: 'Fix the tap', location: 'Room 214', assignedTo: supervisor.user.id, dueDate: hotelDate(0), ...fields } })).body.task;
const alerts = async (token) => (await server.call('GET', '/api/notifications', { token })).body.notifications;
const remindersFor = async (task, token = supervisor.token) => (await alerts(token)).filter((alert) => alert.type === 'task_reminder' && alert.link?.id === task.id);
const setStatus = (task, status) => server.call('PATCH', `/api/tasks/${task.id}/status`, { token: supervisor.token, body: { status } });

test('an open task keeps reminding until it is completed; only the newest reminder stays unread', async () => {
  const task = await newTask();
  await sleep(2500);
  const pending = await remindersFor(task);
  assert.ok(pending.length >= 2, `expected repeated reminders, got ${pending.length}`);
  assert.match(pending[0].title, /not started yet/);
  assert.match(pending[0].body, /Fix the tap · Room 214/);
  assert.equal(pending.filter((alert) => !alert.readAt).length, 1);
  await setStatus(task, 'in_progress');
  await sleep(1500);
  assert.ok((await remindersFor(task)).some((alert) => /still in progress/.test(alert.title)));
  await setStatus(task, 'completed');
  const count = (await remindersFor(task)).length;
  assert.equal((await remindersFor(task)).filter((alert) => !alert.readAt).length, 0, 'completing clears the reminder');
  await sleep(1500);
  assert.equal((await remindersFor(task)).length, count, 'no reminders after it is completed');
});

test('quiet hours hold reminders back, except for urgent tasks', async () => {
  await server.call('PUT', '/api/users/me/notify', { token: supervisor.token, body: { quietHours: { enabled: true, start: '00:00', end: '23:59' } } });
  const normal = await newTask({ title: 'Normal task' });
  const urgent = await newTask({ title: 'Urgent task', priority: 'urgent' });
  await sleep(2000);
  assert.equal((await remindersFor(normal)).length, 0);
  assert.ok((await remindersFor(urgent)).length >= 1);
  await server.call('PUT', '/api/users/me/notify', { token: supervisor.token, body: { quietHours: { enabled: false } } });
  await sleep(1500);
  assert.ok((await remindersFor(normal)).length >= 1, 'reminders resume after quiet hours');
  for (const task of [normal, urgent]) await setStatus(task, 'completed');
});

test('an overdue task tells the manager who assigned it, once', async () => {
  const task = await newTask({ title: 'Replace curtain', dueDate: hotelDate(-2) });
  await sleep(1500);
  const overdue = (await alerts(manager)).filter((alert) => alert.title === 'Task overdue' && alert.link?.id === task.id);
  assert.equal(overdue.length, 1);
  assert.match(overdue[0].body, /Replace curtain/);
  assert.ok((await remindersFor(task)).some((alert) => /overdue since/.test(alert.body)));
  // Long-overdue tasks (over a week) are not announced again.
  const old = await newTask({ title: 'Old job', dueDate: hotelDate(-30) });
  await sleep(1000);
  assert.equal((await alerts(manager)).filter((alert) => alert.link?.id === old.id && alert.title === 'Task overdue').length, 0);
  for (const item of [task, old]) await setStatus(item, 'completed');
});

test('a deleted task stops reminding', async () => {
  const task = await newTask({ title: 'Cancelled job' });
  await sleep(1300);
  await server.call('DELETE', `/api/tasks/${task.id}`, { token: manager });
  const count = (await remindersFor(task)).length;
  await sleep(1300);
  assert.equal((await remindersFor(task)).length, count);
  assert.equal((await remindersFor(task)).filter((alert) => !alert.readAt).length, 0);
});
