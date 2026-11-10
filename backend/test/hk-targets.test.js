// Housekeeper goals: four targets a year (Cleaning 150, Hygiene 150, Trolley & Pantry 150, Guest interaction 90);
// every score adds its points to its own category.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let supervisor;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor');
  await server.call('PUT', '/api/goals', { token: manager, body: { hkProgress: [{ name: 'Sarah Mussa' }] } });
});
after(() => server?.stop());

const file = (type, data) => server.call('POST', '/api/reports', { token: supervisor.token, body: { type, date: hotelDate(0), data } });
const sarah = async () => (await server.call('GET', '/api/goals', { token: manager })).body.goals.hkPoints.find((row) => row.name === 'Sarah Mussa');

test('each report adds to its own categories, and the targets are 150 / 150 / 150 / 90', async () => {
  // Quality room: cleaning = room average (7.5), hygiene = bathroom items (Shower 9, Toilet 7 → 8).
  await file('quality', { block: 'B1', entries: [{ room: '101', hkName: 'Sarah Mussa', scores: { 'Doors / balcony': '8', Wardrobe: '6', Shower: '9', 'Toilet / WC': '7' } }] });
  // Neglected Area: its own Cleaning and Hygiene.
  await file('neglected', { area: 'Corridor', entries: [{ room: 'C1', hkName: 'Sarah Mussa', scores: { Area: '7', Cleaning: '6', Hygiene: '8' } }] });
  // Trolley: the line's average (8).
  await file('trolley_pantry', { trolleys: [{ block: '1', hkName: 'Sarah Mussa', scores: { Cleanliness: '9', Stock: '7' } }], pantries: [] });
  // Guest Interaction: the average of its three criteria (9).
  await file('guest_interaction', { entries: [{ hkName: 'Sarah Mussa', scores: { 'English level': '8', 'Guest approaching': '9', Introduction: '10' } }] });
  const row = await sarah();
  assert.deepEqual(Object.fromEntries(Object.entries(row.categories).map(([key, value]) => [key, [value.points, value.target]])), {
    cleaning: [13.5, 150], hygiene: [16, 150], trolleyPantry: [8, 150], guestInteraction: [9, 90]
  });
  assert.equal(row.met, 0);
  assert.equal(row.done, false);
});

test('the goals response and the profile give the four targets', async () => {
  const goals = (await server.call('GET', '/api/goals', { token: manager })).body.goals;
  assert.deepEqual(goals.targets.hk, { cleaning: 150, hygiene: 150, trolleyPantry: 150, guestInteraction: 90 });
  const profile = (await server.call('GET', '/api/hk-profiles/Sarah%20Mussa', { token: manager })).body.profile;
  assert.equal(profile.points.categories.guestInteraction.points, 9);
  assert.equal(profile.points.met, 0);
});

test('the profile trend also gives the average per inspection, one per report, oldest first', async () => {
  // Two rooms on one Quality Checklist: 6 and 8 → this inspection averages 7.
  const two = (await file('quality', { block: 'B2', entries: [{ room: '201', hkName: 'Sarah Mussa', scores: { Shower: '6' } }, { room: '202', hkName: 'Sarah Mussa', scores: { Shower: '8' } }] })).body.report;
  const profile = (await server.call('GET', '/api/hk-profiles/Sarah%20Mussa', { token: manager })).body.profile;
  const visit = profile.byInspection.find((row) => row.reportId === two.id);
  assert.equal(visit.rooms, 2);
  assert.equal(visit.average, 7);
  assert.equal(visit.type, 'Quality Checklist');
  assert.equal(visit.kind, 'quality');
  assert.deepEqual(visit.places, ['Room 201', 'Room 202']);
  // Each report that rated her is one inspection, her Guest Interaction Check included.
  assert.equal(profile.byInspection.length, 5);
  assert.equal(profile.byInspection.filter((row) => row.kind === 'guest_interaction').length, 1);
  assert.equal(profile.byInspection.at(-1).reportId, two.id);
});
