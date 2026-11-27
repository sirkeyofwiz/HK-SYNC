// Trainings with a trainer: who is told and when, "My trainings", marking a training done, and the "check again" reminder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let assistant;
let trainer;
let supA;
let supB;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alerts = async (token) => (await server.call('GET', '/api/notifications', { token })).body.notifications || [];
const titles = async (token, type = 'training') => (await alerts(token)).filter((alert) => alert.type === type).map((alert) => alert.title);

before(async () => {
  server = await startServer({ TRAINING_REMINDER_CHECK_MS: '200', TRAINING_REMINDER_FROM_HOUR: '0' });
  manager = await login(server, MANAGER.email, MANAGER.password);
  assistant = await createStaff(server, manager, 'assistant_manager', 'Deo Assistant');
  trainer = await createStaff(server, manager, 'supervisor', 'Happy Trainer');
  supA = await createStaff(server, manager, 'supervisor', 'Asha Sup');
  supB = await createStaff(server, manager, 'supervisor', 'Germana Sup');
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: [{ name: 'Fatma Ali' }, { name: 'Zawadi Omar' }] } });
});
after(() => server?.stop());
const plan = (body) => server.call('POST', '/api/training-plans', { token: manager, body });

test('the trainer is told when picked; housekeepers have no login, so only the trainer hears about their training', async () => {
  const made = await plan({ audience: 'hk', topicId: 'dusting', people: [{ name: 'Fatma Ali', ref: 'Fatma Ali' }, { name: 'Zawadi Omar', ref: 'Zawadi Omar' }], date: hotelDate(5), trainerId: trainer.user.id, notes: 'Block 3 linen room' });
  assert.equal(made.status, 201);
  assert.equal(made.body.plan.trainerName, 'Happy Trainer');
  const told = (await alerts(trainer.token)).find((alert) => alert.type === 'training');
  assert.match(told.title, /^You are running a training on /);
  assert.match(told.body, /Dusting high & low areas · 2 housekeepers: Fatma Ali, Zawadi Omar/);
  assert.deepEqual(told.link, { page: 'overview' }, 'a supervisor opens My trainings on the Overview');
  const mine = (await server.call('GET', '/api/my-trainings', { token: trainer.token })).body.trainings;
  assert.deepEqual(mine.map((row) => [row.role, row.topic, row.notes, row.people.length]), [['trainer', 'Dusting high & low areas', 'Block 3 linen room', 2]]);
  assert.equal((await server.call('GET', '/api/my-trainings', { token: supA.token })).body.trainings.length, 0, 'other supervisors see nothing');
  assert.equal((await server.call('POST', '/api/training-plans', { token: manager, body: { audience: 'hk', topicId: 'hair', people: [{ name: 'Fatma Ali', ref: 'Fatma Ali' }], date: hotelDate(5), trainerId: 'nobody' } })).status, 400);
});

test('a supervisor training tells each trainee too, and they see it in My trainings', async () => {
  const made = await plan({ audience: 'sup', topicId: 'sup_bathroom', people: [{ name: 'Asha Sup', ref: supA.user.id }, { name: 'Germana Sup', ref: supB.user.id }], date: hotelDate(6), trainerId: assistant.user.id });
  assert.equal(made.status, 201);
  for (const sup of [supA, supB]) {
    assert.ok((await titles(sup.token)).some((title) => /^You have a training on /.test(title)));
    const mine = (await server.call('GET', '/api/my-trainings', { token: sup.token })).body.trainings;
    assert.deepEqual(mine.map((row) => [row.role, row.trainerName]), [['trainee', 'Deo Assistant']]);
  }
  // Moving it tells everyone again.
  await server.call('PATCH', `/api/training-plans/${encodeURIComponent(made.body.plan.id)}`, { token: manager, body: { audience: 'sup', date: hotelDate(8) } });
  assert.ok((await titles(supA.token)).some((title) => /^Your training moved to /.test(title)));
  // Cancelling it too.
  await server.call('DELETE', `/api/training-plans/${encodeURIComponent(made.body.plan.id)}?audience=sup`, { token: manager });
  assert.ok((await titles(supB.token)).includes('Training cancelled'));
  assert.equal((await server.call('GET', '/api/my-trainings', { token: supB.token })).body.trainings.length, 0);
});

test('reminders: the day before and on the day to the trainer and trainees, each once', async () => {
  const eve = await plan({ audience: 'sup', topicId: 'sup_maintenance', people: [{ name: 'Asha Sup', ref: supA.user.id }], date: hotelDate(1), trainerId: trainer.user.id });
  const day = await plan({ audience: 'hk', topicId: 'hair', people: [{ name: 'Zawadi Omar', ref: 'Zawadi Omar' }], date: hotelDate(0), trainerId: trainer.user.id });
  assert.equal(eve.status, 201); assert.equal(day.status, 201);
  await wait(800);
  assert.equal((await titles(supA.token)).filter((title) => title === 'Training tomorrow: Maintenance reporting').length, 1);
  assert.equal((await titles(trainer.token)).filter((title) => title === 'Training tomorrow: Maintenance reporting').length, 1);
  assert.equal((await titles(trainer.token)).filter((title) => title === 'Training today: Hair & detail check').length, 1);
});

test('the trainer marks it done with who attended; managers are told; others cannot', async () => {
  const row = (await server.call('GET', '/api/my-trainings', { token: trainer.token })).body.trainings.find((entry) => entry.topic === 'Hair & detail check');
  assert.equal((await server.call('POST', `/api/training-plans/${encodeURIComponent(row.id)}/done`, { token: supA.token, body: {} })).status, 403, 'not their training');
  const future = (await server.call('GET', '/api/my-trainings', { token: trainer.token })).body.trainings.find((entry) => entry.topic === 'Dusting high & low areas');
  assert.equal((await server.call('POST', `/api/training-plans/${encodeURIComponent(future.id)}/done`, { token: trainer.token, body: {} })).status, 400, 'not before the day');
  const done = await server.call('POST', `/api/training-plans/${encodeURIComponent(row.id)}/done`, { token: trainer.token, body: { attended: [], note: 'Zawadi off sick' } });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.plan.done.byName, done.body.plan.done.attended, done.body.plan.done.note], ['Happy Trainer', 0, 'Zawadi off sick']);
  for (const token of [manager, assistant.token]) {
    const alert = (await alerts(token)).find((entry) => entry.title === 'Training done: Hair & detail check');
    assert.match(alert.body, /0 of 1 attended \(absent: Zawadi Omar\) · Zawadi off sick/);
  }
  const list = (await server.call('GET', '/api/training-plans?audience=hk', { token: manager })).body;
  assert.ok(list.plans.find((entry) => entry.id === row.id).done);
  assert.ok(list.trainers.some((entry) => entry.name === 'Happy Trainer'), 'the trainer list comes with the plans');
});

test('on the "check again" date, managers are reminded once', async () => {
  const made = await plan({ audience: 'hk', topicId: 'floor', people: [{ name: 'Fatma Ali', ref: 'Fatma Ali' }], date: hotelDate(-20), followUp: hotelDate(0) });
  assert.equal(made.status, 201);
  await wait(800);
  for (const token of [manager, assistant.token]) assert.equal((await titles(token)).filter((title) => title === 'Check again: Floor care').length, 1);
  assert.equal((await titles(trainer.token)).filter((title) => /Check again/.test(title)).length, 0);
});
