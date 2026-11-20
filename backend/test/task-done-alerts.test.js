// A completed task alerts whoever created it, plus the manager and every assistant manager (once each).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER } from './helpers.js';

let server;
let manager;
let assistant;
let assistant2;
let storeSupervisor;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  assistant = await createStaff(server, manager, 'assistant_manager', 'Deo Assistant');
  assistant2 = await createStaff(server, manager, 'assistant_manager', 'Second Assistant');
  storeSupervisor = await createStaff(server, manager, 'store_supervisor', 'Frank Store');
});
after(() => server?.stop());
const alerts = async (token) => (await server.call('GET', '/api/notifications', { token })).body.notifications || [];
const about = (list, taskId) => list.filter((alert) => alert.link?.id === taskId && alert.type === 'task');

test('a task an assistant manager created: completing it alerts her, the manager and the other assistant manager, once each', async () => {
  const task = (await server.call('POST', '/api/tasks', { token: assistant.token, body: { title: 'Duster code', location: 'Store', assignedTo: storeSupervisor.user.id } })).body.task;
  await server.call('PATCH', `/api/tasks/${task.id}/status`, { token: storeSupervisor.token, body: { status: 'in_progress' } });
  assert.equal(about(await alerts(manager), task.id).length, 0, 'starting a task does not alert every manager');
  await server.call('PATCH', `/api/tasks/${task.id}/status`, { token: storeSupervisor.token, body: { status: 'completed' } });
  const toCreator = about(await alerts(assistant.token), task.id).map((alert) => alert.title);
  assert.deepEqual(toCreator, ['Frank Store completed', 'Frank Store started'], 'the creator gets her usual alerts, no extra copy');
  assert.deepEqual(about(await alerts(manager), task.id).map((alert) => alert.title), ['Frank Store completed a task']);
  assert.deepEqual(about(await alerts(assistant2.token), task.id).map((alert) => alert.title), ['Frank Store completed a task']);
  assert.equal(about(await alerts(storeSupervisor.token), task.id).filter((alert) => /completed/.test(alert.title)).length, 0, 'not told about their own completion');
});

test('a manager completing a task for someone tells the others which person it was for', async () => {
  const task = (await server.call('POST', '/api/tasks', { token: manager, body: { title: 'Check minibar stock', location: 'Store', assignedTo: storeSupervisor.user.id } })).body.task;
  await server.call('PATCH', `/api/tasks/${task.id}/status`, { token: assistant.token, body: { status: 'completed' } });
  assert.deepEqual(about(await alerts(assistant2.token), task.id).map((alert) => alert.title), ['Deo Assistant completed a task for Frank Store']);
  assert.ok(about(await alerts(manager), task.id).length === 1, 'the manager (creator) gets one alert');
  assert.equal(about(await alerts(assistant.token), task.id).length, 0, 'not told about her own action');
});
