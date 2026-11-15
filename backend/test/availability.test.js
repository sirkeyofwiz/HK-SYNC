// Store availability: supervisors see what the store has; the store team and managers keep it up to date.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER } from './helpers.js';

let server;
let manager;
let supervisor;
let storekeeper;
let laundry;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  supervisor = await createStaff(server, manager, 'supervisor', 'Sam Supervisor');
  storekeeper = await createStaff(server, manager, 'storekeeper', 'Stella Store');
  laundry = await createStaff(server, manager, 'laundry', 'Lulu Laundry');
});
after(() => server?.stop());

const get = (token) => server.call('GET', '/api/availability', { token });

test('supervisors see the list but cannot change it; laundry staff cannot open it', async () => {
  const seen = await get(supervisor.token);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.canEdit, false);
  assert.equal((await get(laundry.token)).status, 403);
  assert.equal((await server.call('POST', '/api/availability/items', { token: supervisor.token, body: { name: 'Mug', inStock: 3 } })).status, 403);
  assert.equal((await get(storekeeper.token)).body.canEdit, true);
});

test('import from the Excel book, then counts and par levels decide the status', async () => {
  const imported = await server.call('POST', '/api/availability/import', { token: storekeeper.token, body: { asOf: '2026-10-15', items: [
    { name: 'BOTTLE OPENER', category: 'Room Equipment', par: 28, inStock: 17 },
    { name: 'ADAPTOR', category: 'Room Equipment', par: 13, inStock: 17 },
    { name: 'WINE OPENER', category: 'Room Equipment', par: 2, inStock: 0 }
  ] } });
  assert.equal(imported.status, 200);
  assert.deepEqual([imported.body.added, imported.body.updated], [3, 0]);
  const list = (await get(supervisor.token)).body.items;
  const byName = Object.fromEntries(list.map((item) => [item.name, item]));
  assert.equal(byName['Bottle opener'].status, 'low', 'below par');
  assert.equal(byName.Adaptor.status, 'available');
  assert.equal(byName['Wine opener'].status, 'out');
  assert.equal(byName.Adaptor.updatedAt.slice(0, 10), '2026-10-15');

  // Importing again updates the same items instead of adding copies.
  const again = await server.call('POST', '/api/availability/import', { token: manager, body: { items: [{ name: 'Adaptor', category: 'Room Equipment', par: 13, inStock: 5 }] } });
  assert.deepEqual([again.body.added, again.body.updated], [0, 1]);

  const patched = await server.call('PATCH', `/api/availability/items/${byName['Wine opener'].id}`, { token: storekeeper.token, body: { inStock: 4 } });
  assert.equal(patched.body.item.status, 'available');
  assert.equal(patched.body.item.updatedByName, 'Stella Store');
  assert.equal((await server.call('PATCH', `/api/availability/items/${byName['Wine opener'].id}`, { token: storekeeper.token, body: { inStock: -1 } })).status, 400);
});

test('add and remove items; no duplicates', async () => {
  const added = await server.call('POST', '/api/availability/items', { token: manager, body: { name: 'Hangers', category: 'Room Equipment', inStock: 40, par: '' } });
  assert.equal(added.status, 201);
  assert.equal(added.body.item.par, null);
  assert.equal(added.body.item.status, 'available');
  assert.equal((await server.call('POST', '/api/availability/items', { token: manager, body: { name: 'hangers', inStock: 1 } })).status, 409);
  assert.equal((await server.call('DELETE', `/api/availability/items/${added.body.item.id}`, { token: storekeeper.token })).status, 200);
  assert.ok(!(await get(supervisor.token)).body.items.some((item) => item.name === 'Hangers'));
});
