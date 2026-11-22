// Training suggestions: problems that repeat in remarks, counted across the team, and planning a training from them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let supervisor;
let supervisor2;
const HK = ['Asha Juma', 'Fatma Ali', 'Mwanaidi Ally', 'Zawadi Omar'];
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor', 'Happy Sup');
  supervisor2 = await createStaff(server, manager, 'supervisor', 'Germana Sup');
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: HK.map((name) => ({ name })) } });
  const line = (room, hkName, remarks) => ({ room, hkName, scores: { Wardrobe: '7', Shower: '7' }, remarks });
  await server.call('POST', '/api/reports', { token: supervisor.token, body: { type: 'quality', date: hotelDate(-2), data: { block: 'B1', entries: [
    line('101', 'Asha Juma', 'Dust on the TV table'), line('102', 'Fatma Ali', 'Vumbi kwenye dirisha'), line('103', 'Mwanaidi Ally', 'Dusty headboard and hair in the shower'),
    line('104', 'Asha Juma', 'dust under the bed'), line('105', 'Zawadi Omar', 'All good, well done')
  ] } } });
  await server.call('POST', '/api/reports', { token: supervisor.token, body: { type: 'quality', date: hotelDate(-1), data: { block: 'B2', entries: [line('201', 'Zawadi Omar', 'Nywele bafuni')] } } });
});
after(() => server?.stop());
const suggestions = async (query = '') => (await server.call('GET', `/api/training-suggestions?audience=hk${query}`, { token: manager })).body;

test('remarks are matched to topics, counted, and each person counted once per topic', async () => {
  const body = await suggestions();
  assert.equal(body.days, 30);
  assert.equal(body.totalRemarks, 6);
  assert.equal(body.unmatched.count, 1, '"All good, well done" matches nothing');
  const dusting = body.topics.find((topic) => topic.id === 'dusting');
  assert.equal(dusting.times, 4, 'English and Kiswahili both count');
  assert.deepEqual(dusting.people.map((person) => [person.name, person.times]), [['Asha Juma', 2], ['Fatma Ali', 1], ['Mwanaidi Ally', 1]]);
  assert.equal(dusting.suggested, true);
  assert.equal(dusting.group, 'team', '3 people → team training');
  const hair = body.topics.find((topic) => topic.id === 'hair');
  assert.deepEqual([hair.times, hair.people.length, hair.group], [2, 2, 'group']);
  assert.equal(body.topics[0].id, 'dusting', 'most people first');
});

test('the thresholds decide what is suggested', async () => {
  const body = await suggestions('&minTimes=5&minPeople=3');
  assert.equal(body.topics.find((topic) => topic.id === 'hair').suggested, false);
  assert.equal(body.topics.find((topic) => topic.id === 'dusting').suggested, true);
});

test('planning a training adds it to each person\'s support plan and shows as planned', async () => {
  const dusting = (await suggestions()).topics.find((topic) => topic.id === 'dusting');
  const planned = await server.call('POST', '/api/training-plans', { token: manager, body: { audience: 'hk', topicId: 'dusting', people: dusting.people.map(({ name, ref }) => ({ name, ref })), date: hotelDate(3), followUp: hotelDate(33), notes: 'Morning briefing' } });
  assert.equal(planned.status, 201, 'a training can be planned for a future date');
  assert.equal(planned.body.created, 3);
  const plan = (await server.call('GET', `/api/support-actions?kind=hk&ref=${encodeURIComponent('Asha Juma')}`, { token: manager })).body.actions;
  assert.equal(plan[0].action, 'Training');
  assert.equal(plan[0].problem, 'Training: Dusting high & low areas');
  assert.deepEqual((await suggestions()).topics.find((topic) => topic.id === 'dusting').planned, { people: 3, last: hotelDate(3) });
  const coaching = await server.call('POST', '/api/support-actions', { token: manager, body: { kind: 'hk', ref: 'Asha Juma', date: hotelDate(3), action: 'Coaching talk', problem: 'x' } });
  assert.equal(coaching.status, 400, 'other actions still record what was already done');
});

test('managers edit the topic library; supervisors cannot see any of it', async () => {
  const saved = await server.call('PUT', '/api/training-topics', { token: manager, body: { audience: 'hk', topics: [{ label: 'Positive feedback', words: 'good, well done' }] } });
  assert.equal(saved.status, 200);
  const body = await suggestions();
  assert.deepEqual(body.topics.map((topic) => [topic.label, topic.times]), [['Positive feedback', 1]]);
  await server.call('PUT', '/api/training-topics', { token: manager, body: { audience: 'hk', topics: [] } });
  assert.equal((await suggestions()).topics.find((topic) => topic.id === 'dusting').times, 4, 'empty list restores the defaults');
  assert.equal((await server.call('GET', '/api/training-suggestions?audience=hk', { token: supervisor.token })).status, 403);
});

test('supervisors: remarks managers write on Inspection Rate Program rooms', async () => {
  const room = (remarks) => ({ room: '301', scores: { Bathroom: '6', Bedroom: '7', Balcony: '7', Maintenance: '7', 'Presentation Room': '7', 'Entrance Area': '7' }, remarks });
  for (const sup of [supervisor, supervisor2]) {
    await server.call('POST', '/api/reports', { token: manager, body: { type: 'inspection_rate', date: hotelDate(-1), data: { supervisorId: sup.user.id, entries: [room('Shower not clean, limescale on tiles'), room('Bulb not working, not reported')] } } });
  }
  const body = (await server.call('GET', '/api/training-suggestions?audience=sup', { token: manager })).body;
  const bathroom = body.topics.find((topic) => topic.id === 'sup_bathroom');
  assert.deepEqual([bathroom.times, bathroom.people.length, bathroom.group], [2, 2, 'group']);
  assert.ok(bathroom.people.every((person) => [supervisor.user.id, supervisor2.user.id].includes(person.ref)), 'supervisors are known by their account');
  assert.equal(body.topics.find((topic) => topic.id === 'sup_maintenance').times, 2);
});

test('a planned training is one row: edit it for everyone, remove one person, or delete it all', async () => {
  const people = HK.slice(0, 3).map((name) => ({ name, ref: name }));
  await server.call('POST', '/api/training-plans', { token: manager, body: { audience: 'hk', topicId: 'hair', people, date: hotelDate(5), followUp: hotelDate(35), notes: 'Briefing room' } });
  const list = async () => (await server.call('GET', '/api/training-plans?audience=hk', { token: manager })).body.plans;
  const plan = (await list()).find((row) => row.topic === 'Hair & detail check');
  assert.equal(plan.people.length, 3);
  assert.equal(plan.notes, 'Briefing room');
  assert.ok((await list()).some((row) => row.topic === 'Dusting high & low areas' && row.people.length === 3), 'the earlier training is its own row');

  const edited = await server.call('PATCH', `/api/training-plans/${encodeURIComponent(plan.id)}`, { token: manager, body: { audience: 'hk', date: hotelDate(6), notes: 'Moved to Thursday', status: 'improved' } });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.plan.date, edited.body.plan.notes, edited.body.plan.status], [hotelDate(6), 'Moved to Thursday', 'improved']);
  const onProfile = (await server.call('GET', `/api/support-actions?kind=hk&ref=${encodeURIComponent(HK[1])}`, { token: manager })).body.actions.find((row) => row.problem === 'Training: Hair & detail check');
  assert.deepEqual([onProfile.date, onProfile.notes, onProfile.status], [hotelDate(6), 'Moved to Thursday', 'improved'], 'the profile shows the change');

  assert.equal((await server.call('DELETE', `/api/support-actions/${plan.people[0].actionId}`, { token: manager })).status, 200, 'remove one person');
  assert.equal((await list()).find((row) => row.id === plan.id).people.length, 2);

  const deleted = await server.call('DELETE', `/api/training-plans/${encodeURIComponent(plan.id)}?audience=hk`, { token: manager });
  assert.equal(deleted.body.deleted, 2);
  assert.ok(!(await list()).some((row) => row.id === plan.id));
  assert.equal((await server.call('GET', '/api/training-plans?audience=hk', { token: supervisor.token })).status, 403);
});
