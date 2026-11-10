// Overview "Housekeeper performance": everyone inspected in the last 30 days is on one of the two lists, split at 7.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let supervisor;
const SCORES = [['Fay Nine', 9, 9], ['Bea Eight', 8, 8], ['Cia SevenFive', 7, 8], ['Ana Seven', 7, 7], ['Gia Seven', 7, 7], ['Hana Seven', 7, 7], ['Dee SixFive', 6, 7], ['Eve Five', 5, 5]];
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: SCORES.map(([name]) => ({ name })) } });
});
after(() => server?.stop());

test('7 and above is doing well, under 7 needs support, and nobody is cut off', async () => {
  const entries = SCORES.map(([hkName, a, b], index) => ({ room: String(101 + index), hkName, scores: { Wardrobe: String(a), Shower: String(b) } }));
  assert.equal((await server.call('POST', '/api/reports', { token: supervisor.token, body: { type: 'quality', date: hotelDate(0), data: { block: 'B1', entries } } })).status, 201);
  const body = (await server.call('GET', '/api/hk-performance', { token: manager })).body;
  assert.equal(body.goodAt, 7);
  assert.equal(body.supportBelow, 7);
  // Six at 7 or more: more than the old cap of five, and the 7s that used to fall between the lists.
  assert.deepEqual(body.top.map((row) => row.average), [9, 8, 7.5, 7, 7, 7]);
  assert.deepEqual(body.support.map((row) => [row.name, row.average]), [['Eve Five', 5], ['Dee SixFive', 6.5]]);
  assert.equal(body.top.length + body.support.length, body.inspected, 'every inspected housekeeper is on a list');
});

test('a Guest Interaction Check counts: a housekeeper with only a guest check is on a list', async () => {
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: [...SCORES.map(([name]) => ({ name })), { name: 'Ida Guest' }] } });
  const entries = [{ hkName: 'Ida Guest', scores: { 'English level': '5', 'Guest approaching': '6', Introduction: '4' }, remarks: 'Shy with guests' }];
  assert.equal((await server.call('POST', '/api/reports', { token: supervisor.token, body: { type: 'guest_interaction', date: hotelDate(0), data: { entries } } })).status, 201);
  const body = (await server.call('GET', '/api/hk-performance', { token: manager })).body;
  const ida = body.support.find((row) => row.name === 'Ida Guest');
  assert.ok(ida, 'listed under needs support');
  assert.equal(ida.average, 5);
  assert.equal(ida.checks, 1);
  assert.equal(ida.rooms, 0);
  const profile = (await server.call('GET', `/api/hk-profiles/${encodeURIComponent('Ida Guest')}`, { token: manager })).body;
  assert.ok((profile.remarks || profile.profile?.remarks || []).some((remark) => remark.text === 'Shy with guests'), 'the coaching note is in the profile remarks');
  assert.deepEqual(profile.profile.byInspection.map((visit) => [visit.kind, visit.average]), [['guest_interaction', 5]], 'the guest check is a bar on the trend chart');
  assert.equal(profile.profile.trend.at(-1).average, 5, 'and counts in the month');
});

test('a low guest interaction check puts a housekeeper on needs support even when her rooms lift the overall average', async () => {
  const names = [...SCORES.map(([name]) => ({ name })), { name: 'Ida Guest' }, { name: 'Agnes Rooms' }];
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: names } });
  const rooms = [{ room: '201', hkName: 'Agnes Rooms', scores: { Wardrobe: '9', Shower: '9' } }, { room: '202', hkName: 'Agnes Rooms', scores: { Wardrobe: '9', Shower: '9' } }];
  assert.equal((await server.call('POST', '/api/reports', { token: supervisor.token, body: { type: 'quality', date: hotelDate(0), data: { block: 'B2', entries: rooms } } })).status, 201);
  const guest = [{ hkName: 'Agnes Rooms', scores: { 'English level': '6', 'Guest approaching': '7', Introduction: '6' } }];
  assert.equal((await server.call('POST', '/api/reports', { token: supervisor.token, body: { type: 'guest_interaction', date: hotelDate(0), data: { entries: guest } } })).status, 201);
  const body = (await server.call('GET', '/api/hk-performance', { token: manager })).body;
  const agnes = body.support.find((row) => row.name === 'Agnes Rooms');
  assert.ok(agnes, 'listed under needs support');
  assert.ok(agnes.average >= 7, 'her overall average alone would have put her on the good list');
  assert.equal(agnes.guestAverage, 6.3);
  assert.equal(agnes.roomAverage, 9);
  assert.deepEqual(agnes.below, [{ label: 'Guest interaction', average: 6.3 }]);
  assert.ok(!body.top.some((row) => row.name === 'Agnes Rooms'), 'not also on the good list');
  assert.equal(body.top.length + body.support.length, body.inspected, 'every inspected housekeeper is on one list');
  const profile = (await server.call('GET', `/api/hk-profiles/${encodeURIComponent('Agnes Rooms')}`, { token: manager })).body;
  assert.equal((profile.profile || profile).guestInteraction, 6.3, 'the profile carries her latest guest check for What needs attention');
});
