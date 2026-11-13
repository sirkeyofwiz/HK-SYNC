// The bell: clear one notification or all of them; only your own are touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER } from './helpers.js';

let server;
let manager;
let laundry;
let supervisor;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  laundry = await createStaff(server, manager, 'laundry', 'Lulu Laundry');
  supervisor = await createStaff(server, manager, 'supervisor', 'Sam Supervisor');
});
after(() => server?.stop());

const list = async (who) => (await server.call('GET', '/api/notifications', { token: who.token })).body.notifications;
const newBag = (room) => server.call('POST', '/api/laundry/bags', { token: manager, body: { room, service: 'wash_iron', speed: 'standard', collectedBy: 'Asha Juma', items: { Shirt: 1 } } });

test('clear one notification, then all of them, without touching anyone else', async () => {
  await newBag('101'); await newBag('102'); await newBag('103');
  const mine = await list(laundry);
  assert.ok(mine.length >= 3);
  const before = (await list(supervisor)).length;
  assert.equal((await server.call('POST', '/api/notifications/clear', { token: laundry.token, body: {} })).status, 400);

  const one = await server.call('POST', '/api/notifications/clear', { token: laundry.token, body: { ids: [mine[0].id] } });
  assert.equal(one.body.cleared, 1);
  assert.ok(!(await list(laundry)).some((entry) => entry.id === mine[0].id));

  const theirs = (await list(supervisor))[0];
  assert.equal((await server.call('POST', '/api/notifications/clear', { token: laundry.token, body: { ids: [theirs.id] } })).body.cleared, 0, "someone else's stays");

  const all = await server.call('POST', '/api/notifications/clear', { token: laundry.token, body: { all: true } });
  assert.equal(all.body.cleared, mine.length - 1);
  assert.equal((await list(laundry)).length, 0);
  assert.equal((await list(supervisor)).length, before, 'the supervisor still has theirs');
});
