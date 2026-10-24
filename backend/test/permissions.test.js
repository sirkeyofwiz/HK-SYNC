// Who can see and do what. One wrong rule here shows a manager's data to a driver, so each role is checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, createStaff, MANAGER, qualityReport, hotelDate } from './helpers.js';

let server;
let manager;
let assistant;
let supervisorA;
let supervisorB;
let driver;
let otherDriver;
let storekeeper;
before(async () => {
  server = await startServer();
  manager = await login(server, MANAGER.email, MANAGER.password);
  assistant = await createStaff(server, manager, 'assistant_manager');
  supervisorA = await createStaff(server, manager, 'supervisor');
  supervisorB = await createStaff(server, manager, 'supervisor');
  driver = await createStaff(server, manager, 'driver');
  otherDriver = await createStaff(server, manager, 'driver');
  storekeeper = await createStaff(server, manager, 'storekeeper');
});
after(() => server?.stop());

const newStaff = (role) => ({ name: `New ${role}`, email: `new.${role}.${Date.now()}@test.local`, password: 'staff-password-1', role });

test('only managers create accounts, and only the manager creates assistant managers', async () => {
  assert.equal((await server.call('POST', '/api/users/staff', { token: supervisorA.token, body: newStaff('driver') })).status, 403);
  assert.equal((await server.call('POST', '/api/users/staff', { token: driver.token, body: newStaff('driver') })).status, 403);
  assert.equal((await server.call('POST', '/api/users/staff', { token: assistant.token, body: newStaff('driver') })).status, 201);
  assert.equal((await server.call('POST', '/api/users/staff', { token: assistant.token, body: newStaff('assistant_manager') })).status, 403);
  assert.equal((await server.call('POST', '/api/users/staff', { token: manager, body: { ...newStaff('manager') } })).status, 400, 'nobody can create a second manager');
});

test('an assistant manager cannot lock out the manager or another assistant manager', async () => {
  const me = await server.call('GET', '/api/users/me', { token: manager });
  assert.equal((await server.call('PATCH', `/api/users/${me.body.user.id}/status`, { token: assistant.token, body: { active: false } })).status, 403);
  assert.equal((await server.call('POST', `/api/users/${me.body.user.id}/reset-password`, { token: assistant.token })).status, 403);
  const second = await createStaff(server, manager, 'assistant_manager');
  assert.equal((await server.call('PATCH', `/api/users/${second.user.id}/status`, { token: assistant.token, body: { active: false } })).status, 403);
});

test('manager-only pages are closed to field staff', async () => {
  for (const route of ['/api/goals', '/api/hk-profiles', '/api/supervisor-profiles', '/api/hk-performance', '/api/backups']) {
    for (const staff of [supervisorA, driver, storekeeper]) {
      assert.equal((await server.call('GET', route, { token: staff.token })).status, 403, `${staff.user.role} should not open ${route}`);
    }
  }
});

test('backups are for the manager alone, not assistant managers', async () => {
  assert.equal((await server.call('GET', '/api/backups', { token: assistant.token })).status, 403);
  assert.equal((await server.call('GET', '/api/backups/download', { token: assistant.token })).status, 403);
  assert.equal((await server.call('GET', '/api/backups', { token: manager })).status, 200);
});

test('each role submits only its own report types', async () => {
  const vehicle = { type: 'vehicle', date: hotelDate(), data: { vehicleId: 'T 123 ABC', vehicle: { Tyres: 'OK' } } };
  const tools = { type: 'tools', date: hotelDate(), data: { entries: [{ tool: 'Vacuum', quantity: '2', status: 'Good', assignedTo: '', remarks: '' }] } };
  assert.equal((await server.call('POST', '/api/reports', { token: driver.token, body: qualityReport() })).status, 403);
  assert.equal((await server.call('POST', '/api/reports', { token: driver.token, body: tools })).status, 403);
  assert.equal((await server.call('POST', '/api/reports', { token: driver.token, body: vehicle })).status, 201);
  assert.equal((await server.call('POST', '/api/reports', { token: storekeeper.token, body: vehicle })).status, 403);
  assert.equal((await server.call('POST', '/api/reports', { token: storekeeper.token, body: tools })).status, 201);
  assert.equal((await server.call('POST', '/api/reports', { token: supervisorA.token, body: vehicle })).status, 403);
  assert.equal((await server.call('POST', '/api/reports', { token: supervisorA.token, body: qualityReport() })).status, 201);
});

test("a supervisor's report is hidden from drivers and other supervisors, and open to managers", async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisorA.token, body: qualityReport() });
  const id = created.body.report.id;
  for (const outsider of [driver, storekeeper, supervisorB]) {
    assert.equal((await server.call('GET', `/api/reports/${id}`, { token: outsider.token })).status, 404, `${outsider.user.role} should not open it`);
    const list = await server.call('GET', '/api/reports', { token: outsider.token });
    assert.ok(!list.body.reports.some((report) => report.id === id), `${outsider.user.role} should not see it in the list`);
  }
  for (const boss of [manager, assistant.token]) {
    assert.equal((await server.call('GET', `/api/reports/${id}`, { token: boss })).status, 200);
  }
});

test('every supervisor sees every shift handover, drivers do not', async () => {
  const handover = { type: 'handover', date: hotelDate(), data: { receivedById: supervisorB.user.id, notes: 'All quiet' } };
  const created = await server.call('POST', '/api/reports', { token: supervisorA.token, body: handover });
  assert.equal(created.status, 201);
  const id = created.body.report.id;
  assert.equal((await server.call('GET', `/api/reports/${id}`, { token: supervisorB.token })).status, 200);
  assert.equal((await server.call('GET', `/api/reports/${id}`, { token: driver.token })).status, 404);
});

test("staff cannot sign, change or delete someone else's report", async () => {
  const created = await server.call('POST', '/api/reports', { token: supervisorA.token, body: qualityReport() });
  const id = created.body.report.id;
  assert.equal((await server.call('POST', `/api/reports/${id}/sign`, { token: supervisorA.token })).status, 403);
  assert.equal((await server.call('PUT', `/api/reports/${id}`, { token: supervisorB.token, body: { data: qualityReport(1).data } })).status, 404);
  assert.equal((await server.call('DELETE', `/api/reports/${id}`, { token: supervisorB.token })).status, 404);
  assert.equal((await server.call('DELETE', `/api/reports/${id}`, { token: driver.token })).status, 404);
});

test('only managers create or delete tasks; only the right people update them', async () => {
  const task = { title: 'Replace bulb', location: 'Room 204', assignedTo: driver.user.id, priority: 'medium' };
  assert.equal((await server.call('POST', '/api/tasks', { token: supervisorA.token, body: task })).status, 403);
  const created = await server.call('POST', '/api/tasks', { token: manager, body: task });
  assert.equal(created.status, 201);
  const id = created.body.task.id;
  assert.equal((await server.call('PATCH', `/api/tasks/${id}/status`, { token: otherDriver.token, body: { status: 'completed' } })).status, 403);
  assert.equal((await server.call('GET', `/api/tasks/${id}`, { token: otherDriver.token })).status, 404);
  assert.equal((await server.call('PATCH', `/api/tasks/${id}/status`, { token: driver.token, body: { status: 'in_progress' } })).status, 200);
  assert.equal((await server.call('DELETE', `/api/tasks/${id}`, { token: driver.token })).status, 403);
  assert.equal((await server.call('DELETE', `/api/tasks/${id}`, { token: manager })).status, 200);
  const list = await server.call('GET', '/api/tasks', { token: driver.token });
  assert.ok(!list.body.tasks.some((entry) => entry.id === id), 'a deleted task disappears');
});

test("supervisors can cover each other's tasks, but not a driver's", async () => {
  const forB = await server.call('POST', '/api/tasks', { token: manager, body: { title: 'Check linen', location: 'Block C', assignedTo: supervisorB.user.id } });
  assert.equal((await server.call('PATCH', `/api/tasks/${forB.body.task.id}/status`, { token: supervisorA.token, body: { status: 'completed' } })).status, 200);
  const forDriver = await server.call('POST', '/api/tasks', { token: manager, body: { title: 'Fuel van', location: 'Garage', assignedTo: driver.user.id } });
  assert.equal((await server.call('PATCH', `/api/tasks/${forDriver.body.task.id}/status`, { token: supervisorA.token, body: { status: 'completed' } })).status, 403);
});

test('a chat file opens only for the people in that conversation', async () => {
  const upload = await server.call('POST', '/api/attachments', { token: supervisorA.token, body: Buffer.from('hello'), headers: { 'Content-Type': 'text/plain', 'X-File-Name': 'note.txt' } });
  assert.equal(upload.status, 201);
  const fileId = upload.body.attachment.id;
  assert.equal((await server.call('GET', `/api/attachments/${fileId}`, { token: supervisorB.token })).status, 404, 'not shared yet');
  const sent = await server.call('POST', '/api/messages', { token: supervisorA.token, body: { receiverId: supervisorB.user.id, text: 'See the note', attachments: [fileId] } });
  assert.equal(sent.status, 201);
  const opened = await server.call('GET', `/api/attachments/${fileId}`, { token: supervisorB.token });
  assert.equal(opened.status, 200);
  assert.equal(opened.body, 'hello');
  assert.equal((await server.call('GET', `/api/attachments/${fileId}`, { token: driver.token })).status, 404);
  // Someone else cannot pass the file off as their own in another chat.
  assert.equal((await server.call('POST', '/api/messages', { token: driver.token, body: { receiverId: otherDriver.user.id, attachments: [fileId] } })).status, 400);
});

test('private messages stay between the two people', async () => {
  await server.call('POST', '/api/messages', { token: supervisorA.token, body: { receiverId: supervisorB.user.id, text: 'Private note' } });
  const outsider = await server.call('GET', `/api/messages/${supervisorB.user.id}`, { token: driver.token });
  assert.ok(!outsider.body.messages.some((message) => message.text === 'Private note'));
  const receiver = await server.call('GET', `/api/messages/${supervisorA.user.id}`, { token: supervisorB.token });
  assert.ok(receiver.body.messages.some((message) => message.text === 'Private note'));
});
