// Signing in, staying signed in, and being signed out when an account changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER } from './helpers.js';

let server;
let managerToken;
before(async () => {
  server = await startServer();
  managerToken = await login(server, MANAGER.email, MANAGER.password);
});
after(() => server?.stop());

test('the health check answers without signing in', async () => {
  const { status, body } = await server.call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('a wrong password is refused and a right one signs in', async () => {
  const wrong = await server.call('POST', '/api/auth/login', { body: { email: MANAGER.email, password: 'not-the-password' } });
  assert.equal(wrong.status, 401);
  const right = await server.call('POST', '/api/auth/login', { body: { email: MANAGER.email.toUpperCase(), password: MANAGER.password } });
  assert.equal(right.status, 200);
  assert.ok(right.body.token);
  assert.equal(right.body.user.role, 'manager');
});

test('no account details ever include the password hash', async () => {
  const me = await server.call('GET', '/api/users/me', { token: managerToken });
  assert.equal(me.body.user.password, undefined);
  const all = await server.call('GET', '/api/users/all', { token: managerToken });
  assert.ok(all.body.users.length > 0);
  for (const user of all.body.users) {
    assert.equal(user.password, undefined);
    assert.equal(user.resetTokenHash, undefined);
  }
});

test('private pages need a valid sign-in', async () => {
  assert.equal((await server.call('GET', '/api/reports')).status, 401);
  assert.equal((await server.call('GET', '/api/reports', { token: 'made-up-token' })).status, 401);
});

test('five wrong passwords lock the account, even for the right password', async () => {
  const staff = await createStaff(server, managerToken, 'driver');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await server.call('POST', '/api/auth/login', { body: { email: staff.email, password: 'wrong-password' } })).status, 401);
  }
  const locked = await server.call('POST', '/api/auth/login', { body: { email: staff.email, password: staff.password } });
  assert.equal(locked.status, 429);
});

test('a deactivated account is signed out at once and cannot sign in', async () => {
  const staff = await createStaff(server, managerToken, 'storekeeper');
  assert.equal((await server.call('GET', '/api/users/me', { token: staff.token })).status, 200);
  assert.equal((await server.call('PATCH', `/api/users/${staff.user.id}/status`, { token: managerToken, body: { active: false } })).status, 200);
  assert.equal((await server.call('GET', '/api/users/me', { token: staff.token })).status, 401);
  assert.equal((await server.call('POST', '/api/auth/login', { body: { email: staff.email, password: staff.password } })).status, 403);
});

test('changing a password signs out other devices', async () => {
  const staff = await createStaff(server, managerToken, 'supervisor');
  // Sign-ins are timed to the second; let the old sign-in fall into an earlier second than the change.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const change = await server.call('POST', '/api/users/me/password', { token: staff.token, body: { currentPassword: staff.password, newPassword: 'brand-new-password' } });
  assert.equal(change.status, 200);
  assert.equal((await server.call('GET', '/api/users/me', { token: staff.token })).status, 401, 'the old sign-in should stop working');
  assert.equal((await server.call('GET', '/api/users/me', { token: change.body.token })).status, 200, 'this device gets a fresh sign-in');
});

test("a manager's reset link lets the person set a new password", async () => {
  const staff = await createStaff(server, managerToken, 'driver');
  const reset = await server.call('POST', `/api/users/${staff.user.id}/reset-password`, { token: managerToken });
  assert.equal(reset.status, 200);
  const token = new URL(reset.body.resetLink).searchParams.get('reset');
  assert.equal((await server.call('POST', '/api/auth/reset-password', { body: { token, password: 'short' } })).status, 400);
  assert.equal((await server.call('POST', '/api/auth/reset-password', { body: { token, password: 'reset-password-1' } })).status, 200);
  assert.ok(await login(server, staff.email, 'reset-password-1'));
  assert.equal((await server.call('POST', '/api/auth/reset-password', { body: { token, password: 'reset-password-2' } })).status, 400, 'a link works only once');
});
