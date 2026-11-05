// Contract review: the suggested band for each housekeeper and supervisor, who may see it, and the manager's decisions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let assistant;
let supA;
let supB;
let supC;
let review;

// A Quality Checklist with one line per score in `scores`, all for housekeeper `hkName`.
const quality = (hkName, lines) => ({ type: 'quality', date: hotelDate(), data: { block: 'A', entries: lines.map(([bed, shower], index) => ({ room: String(100 + index), hkName, scores: { 'Bed / phone': bed, Shower: shower }, remarks: bed < 6 ? 'Dust under the bed' : '' })) } });
// An Inspection Rate Program session about a supervisor: `rooms` rooms, each item scored `item` (6 items, out of 60).
const inspection = (supervisorId, rooms, item) => ({ type: 'inspection_rate', date: hotelDate(), data: { area: 'North', supervisorId, entries: Array.from({ length: rooms }, (_, index) => ({ room: String(200 + index), scores: { Bathroom: item, Bedroom: item, Balcony: item, Maintenance: item, 'Presentation Room': item, 'Entrance Area': item }, remarks: '' })) } });
const send = async (token, body) => { const { status, body: answer } = await server.call('POST', '/api/reports', { token, body }); assert.equal(status, 201, JSON.stringify(answer)); };
const person = (list, name) => list.find((row) => row.name === name);

before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  assistant = await createStaff(server, manager, 'assistant_manager');
  supA = await createStaff(server, manager, 'supervisor', 'Supervisor Asha');
  supB = await createStaff(server, manager, 'supervisor', 'Supervisor Baraka');
  supC = await createStaff(server, manager, 'supervisor', 'Supervisor Chausiku');
  const roster = ['Amina Meets', 'Zawadi Plan', 'Pili Weak Area', 'Neema Failed', 'Rehema Few', 'Salma One Inspector'];
  assert.equal((await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: roster.map((name) => ({ name })) } })).status, 200);
  const six = (pair) => Array.from({ length: 6 }, () => pair);
  for (const sup of [supA, supB]) {
    await send(sup.token, quality('Amina Meets', six([9, 9])));
    await send(sup.token, quality('Zawadi Plan', six([7.5, 7.5])));
    await send(sup.token, quality('Pili Weak Area', six([10, 6.5])));
    await send(sup.token, quality('Neema Failed', [[5, 5], [5, 5], [8, 8], [8, 8], [8, 8], [8, 8]]));
  }
  await send(supA.token, quality('Rehema Few', [[9, 9], [9, 9], [9, 9]]));
  await send(supA.token, quality('Salma One Inspector', [...six([9, 9]), ...six([9, 9])]));
  // Supervisors: A strong (54/60), B average (43.2/60), C only two sessions.
  for (let session = 0; session < 6; session += 1) {
    await send(manager, inspection(supA.user.id, 4, 9));
    await send(manager, inspection(supB.user.id, 4, 7.2));
  }
  await send(manager, inspection(supC.user.id, 4, 9));
  await send(manager, inspection(supC.user.id, 4, 9));
  const response = await server.call('GET', '/api/contract-review', { token: manager });
  assert.equal(response.status, 200);
  review = response.body;
});
after(() => server?.stop());

test('only the manager opens contract reviews until they share them', async () => {
  assert.equal((await server.call('GET', '/api/contract-review', { token: supA.token })).status, 403);
  const closed = await server.call('GET', '/api/contract-review', { token: assistant.token });
  assert.equal(closed.status, 403);
  assert.match(closed.body.message, /not shared/);
  assert.equal(review.canDecide, true);
  assert.equal(review.shareWithAssistants, false);
});

test('housekeepers: meets standard, improvement plan, below standard', () => {
  const amina = person(review.housekeepers, 'Amina Meets');
  assert.equal(amina.band, 'meets');
  assert.equal(amina.inspections, 12);
  assert.equal(amina.inspectors, 2);
  assert.equal(amina.average, 9);
  assert.equal(person(review.housekeepers, 'Zawadi Plan').band, 'plan');
  const pili = person(review.housekeepers, 'Pili Weak Area');
  assert.equal(pili.band, 'plan', 'average 8.25 but hygiene 6.5');
  assert.ok(pili.reasons.some((reason) => reason.startsWith('Hygiene averages 6.5')));
  const neema = person(review.housekeepers, 'Neema Failed');
  assert.equal(neema.band, 'below', '4 of 12 inspections under 6');
  assert.equal(neema.failed, 4);
  assert.ok(neema.remarks.some((remark) => remark.text === 'Dust under the bed'));
});

test('housekeepers: too few inspections, or one inspector only, is "not enough evidence"', () => {
  const rehema = person(review.housekeepers, 'Rehema Few');
  assert.equal(rehema.band, 'not_enough');
  assert.match(rehema.reasons[0], /3 inspections/);
  const salma = person(review.housekeepers, 'Salma One Inspector');
  assert.equal(salma.inspections, 12);
  assert.equal(salma.band, 'not_enough');
  assert.ok(salma.reasons.some((reason) => /1 supervisor/.test(reason)));
});

test('supervisors: meets standard, improvement plan, not enough evidence', () => {
  const asha = person(review.supervisors, 'Supervisor Asha');
  assert.equal(asha.band, 'meets');
  assert.equal(asha.sessions, 6);
  assert.equal(asha.rooms, 24);
  assert.equal(asha.average, 54);
  assert.equal(asha.passRate, 1);
  const baraka = person(review.supervisors, 'Supervisor Baraka');
  assert.equal(baraka.band, 'plan', 'average 43.2/60, every room passes 36/60');
  assert.equal(person(review.supervisors, 'Supervisor Chausiku').band, 'not_enough');
  assert.ok(Number.isInteger(asha.reportsFiled) && asha.reportsFiled >= 6, 'context: reports the supervisor filed');
});

test('supervisor standards are out of 60: 48 meets, under 42 is below', async () => {
  assert.deepEqual([review.defaults.supervisor.meetsAverage, review.defaults.supervisor.belowAverage], [48, 42]);
  const saved = await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { bands: { supervisor: { meetsAverage: 50 } } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.bands.supervisor.meetsAverage, 50, 'saved now: already on the 60 scale');
  assert.equal((await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { bands: { supervisor: { meetsAverage: 61 } } } })).status, 400);
  await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { bands: { supervisor: { meetsAverage: 48 } } } });
});

test('the manager records a decision; serious ones need a reason', async () => {
  const year = review.period.startYear;
  const decide = (body, token = manager) => server.call('PUT', '/api/contract-review/decision', { token, body: { year, kind: 'hk', key: 'Neema Failed', ...body } });
  assert.equal((await decide({ decision: 'do_not_renew' })).status, 400, 'reason required');
  assert.equal((await decide({ decision: 'maybe' })).status, 400);
  assert.equal((await decide({ decision: 'renew', key: 'Nobody On Roster' })).status, 400);
  const saved = await decide({ decision: 'renew_with_plan', reason: 'Two failed rooms in October; retrain on bed dusting.' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.decision.byName, 'Manager');
  const again = await server.call('GET', '/api/contract-review', { token: manager });
  assert.equal(person(again.body.housekeepers, 'Neema Failed').decision.decision, 'renew_with_plan');
  const supervisorDecision = await server.call('PUT', '/api/contract-review/decision', { token: manager, body: { year, kind: 'supervisor', key: supA.user.id, decision: 'renew' } });
  assert.equal(supervisorDecision.status, 200);
});

test('shared with assistant managers: they can read, not decide or change settings', async () => {
  assert.equal((await server.call('PUT', '/api/contract-review/settings', { token: assistant.token, body: { shareWithAssistants: true } })).status, 403);
  assert.equal((await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { shareWithAssistants: true } })).status, 200);
  const shared = await server.call('GET', '/api/contract-review', { token: assistant.token });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.canDecide, false);
  assert.equal(person(shared.body.housekeepers, 'Neema Failed').decision.decision, 'renew_with_plan');
  assert.equal((await server.call('PUT', '/api/contract-review/decision', { token: assistant.token, body: { year: review.period.startYear, kind: 'hk', key: 'Amina Meets', decision: 'renew' } })).status, 403);
  assert.equal((await server.call('GET', '/api/contract-review', { token: supA.token })).status, 403, 'supervisors never');
  await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { shareWithAssistants: false } });
  assert.equal((await server.call('GET', '/api/contract-review', { token: assistant.token })).status, 403, 'unshared again');
});

test('the manager can change the bands; every review follows', async () => {
  assert.equal((await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { bands: { hk: { meetsAverage: 'high' } } } })).status, 400);
  assert.equal((await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { bands: { hk: { surprise: 3 } } } })).status, 400);
  assert.equal((await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { bands: { hk: { belowAverage: 9 } } } })).status, 400, 'below above meets');
  const changed = await server.call('PUT', '/api/contract-review/settings', { token: manager, body: { bands: { hk: { meetsAverage: 7.4 } } } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.bands.hk.meetsAverage, 7.4);
  const after = await server.call('GET', '/api/contract-review', { token: manager });
  assert.equal(person(after.body.housekeepers, 'Zawadi Plan').band, 'meets', '7.5 now meets a 7.4 standard');
  assert.equal(after.body.defaults.hk.meetsAverage, 8, 'the starting values stay available');
});
