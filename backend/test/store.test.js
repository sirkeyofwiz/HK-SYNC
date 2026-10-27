// Housekeeping store: who may use it, what a day sheet accepts, and the sums behind the monthly reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, hotelDate } from './helpers.js';

let server;
let manager;
let storekeeper;
let supervisor;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  storekeeper = await createStaff(server, manager, 'storekeeper');
  supervisor = await createStaff(server, manager, 'supervisor');
});
after(() => server?.stop());

const call = (method, route, body, token = storekeeper.token) => server.call(method, `/api/store${route}`, { token, body });
const addItem = async (fields) => (await call('POST', '/items', fields)).body.item;
const sheet = (book, date, kind, lines) => call('PUT', '/sheet', { book, date, kind, lines });
const report = async (book, month) => (await call('GET', `/report?book=${book}&month=${month}`)).body.report;

test('only the storekeeper and managers can open the store; only managers change budgets', async () => {
  assert.equal((await call('GET', '')).status, 200);
  assert.equal((await call('GET', '', undefined, manager)).status, 200);
  assert.equal((await call('GET', '', undefined, supervisor.token)).status, 403);
  assert.equal((await call('PUT', '/settings', { exchangeRate: 2500 })).status, 403);
  assert.equal((await call('PUT', '/settings', { exchangeRate: 2400 }, manager)).status, 200);
});

test('items need a book, a name and a price, and a name is used once per book', async () => {
  assert.equal((await call('POST', '/items', { book: 'nope', name: 'X', unitCost: 1 })).status, 400);
  assert.equal((await call('POST', '/items', { book: 'minibar', name: '', unitCost: 1 })).status, 400);
  assert.equal((await call('POST', '/items', { book: 'minibar', name: 'Juice box', unitCost: -5 })).status, 400);
  await addItem({ book: 'minibar', name: 'Juice box', category: 'Juice', unitCost: 700 });
  assert.equal((await call('POST', '/items', { book: 'minibar', name: 'juice BOX', unitCost: 1 })).status, 400);
});

test('a day sheet refuses impossible or future dates and negative use', async () => {
  const cola = await addItem({ book: 'minibar', name: 'Cola test', category: 'Soft Drink', unitCost: 900 });
  assert.equal((await sheet('minibar', '2025-11-31', 'use', { [cola.id]: 1 })).status, 400);
  assert.equal((await sheet('minibar', '2099-01-01', 'use', { [cola.id]: 1 })).status, 400);
  assert.equal((await sheet('minibar', '2025-11-30', 'use', { [cola.id]: -1 })).status, 400);
  assert.equal((await sheet('minibar', '2025-11-30', 'adjust', { [cola.id]: -1 })).status, 200);
});

test('a month adds up daily use at the price of the day, and cost per occupied room-night uses only days with rooms', async () => {
  const beer = await addItem({ book: 'minibar', name: 'Beer test', category: 'Beer', unitCost: 1500 });
  await sheet('minibar', '2026-03-01', 'use', { [beer.id]: 10 });
  // A price rise later in the month applies from then on; the 1st keeps its price.
  await call('PUT', `/items/${beer.id}`, { unitCost: 2000 });
  await sheet('minibar', '2026-03-02', 'use', { [beer.id]: 5 });
  await call('PUT', '/occupancy', { days: { '2026-03-01': 100 } });
  const march = await report('minibar', '2026-03');
  const row = march.items.find((item) => item.id === beer.id);
  assert.equal(row.used, 15);
  assert.equal(row.cost, 10 * 1500 + 5 * 2000);
  assert.equal(march.kpis.roomNights, 100);
  assert.equal(march.kpis.costPerRoomNight, 150); // only the 1st had rooms entered: 15,000 / 100
});

test('stock: a count sets the stock, deliveries and use move it, and below par means reorder', async () => {
  const mug = await addItem({ book: 'equipment', name: 'Mug test', category: 'Glassware & Crockery', unitCost: 3500, par: 10 });
  await sheet('equipment', '2026-01-31', 'count', { [mug.id]: 20 });
  await sheet('equipment', '2026-02-01', 'receive', { [mug.id]: 6 });
  await sheet('equipment', '2026-02-10', 'use', { [mug.id]: 14 });
  await sheet('equipment', '2026-02-11', 'adjust', { [mug.id]: -3 });
  const feb = (await report('equipment', '2026-02')).items.find((item) => item.id === mug.id);
  assert.deepEqual([feb.opening, feb.received, feb.used, feb.adjust, feb.closing], [20, 6, 14, -3, 9]);
  assert.equal(feb.reorder, true);
  // A count in March finds 7 on the shelf: the 2 missing show as the count difference.
  await sheet('equipment', '2026-03-31', 'count', { [mug.id]: 7 });
  const mar = (await report('equipment', '2026-03')).items.find((item) => item.id === mug.id);
  assert.deepEqual([mar.opening, mar.countDiff, mar.closing], [9, -2, 7]);
});

test('chemicals compare cost with the guest budget (USD per guest × exchange rate)', async () => {
  const polish = await addItem({ book: 'chemicals', name: 'Polish test', category: 'Chemical', unitCost: 240000 });
  await sheet('chemicals', '2026-04-01', 'use', { [polish.id]: 2 });
  await call('PUT', '/months/2026-04', { guests: 1000 });
  const { kpis, totalCost } = await report('chemicals', '2026-04');
  assert.equal(totalCost, 480000);
  assert.equal(kpis.costPerGuest, 480);
  assert.equal(kpis.occupancyBudget, 1000 * 0.35 * 2400);
});

test('saving an empty sheet removes it', async () => {
  const soap = await addItem({ book: 'amenities', name: 'Soap test', category: 'Bathroom Amenity', unitCost: 2000 });
  const today = hotelDate(0);
  await sheet('amenities', today, 'use', { [soap.id]: 3 });
  assert.ok((await call('GET', `/day?book=amenities&date=${today}`)).body.sheets.use);
  await sheet('amenities', today, 'use', { [soap.id]: '' });
  assert.equal((await call('GET', `/day?book=amenities&date=${today}`)).body.sheets.use, null);
});
