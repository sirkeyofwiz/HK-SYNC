// Odd or hostile request bodies get a quick answer and never tie up the server for everyone else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { startServer } from './helpers.js';

let server;
before(async () => { server = await startServer(); });
after(() => server?.stop());

const send = (body, headers) => fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(5000) });

test('a compressed sign-in still works', async () => {
  const response = await send(gzipSync(JSON.stringify({ email: 'nobody@test.local', password: 'wrong-password' })), { 'Content-Encoding': 'gzip' });
  assert.equal(response.status, 401);
});

test('junk sent together with a compressed body is refused', async () => {
  const body = Buffer.concat([gzipSync(JSON.stringify({ email: 'a@b.c', password: 'x' })), Buffer.alloc(512 * 1024, 0x41)]);
  const response = await send(body, { 'Content-Encoding': 'gzip' });
  assert.equal(response.status, 400);
});

// GHSA-27r3-jxmh-p828: in body-parser before 1.20.9, bytes arriving after a complete compressed body could make the
// finished decoder throw outside any request, which stops the server. On Node 24 this test did not trigger it with the
// old version either (gzip and deflate, sent at once or late); it stays as a guard in case that changes.
test('junk arriving after a compressed body does not stop the server', async () => {
  const frame = gzipSync(JSON.stringify({ email: 'a@b.c', password: 'x' }));
  const trailing = Buffer.from('trailing junk');
  await new Promise((resolve) => {
    const request = http.request(`${server.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': frame.length + trailing.length } }, (response) => { response.resume(); response.on('end', resolve); });
    request.on('error', resolve);
    request.write(frame);
    setTimeout(() => request.end(trailing), 300);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const health = await fetch(`${server.url}/api/health`, { signal: AbortSignal.timeout(3000) });
  assert.equal(health.status, 200);
  assert.doesNotMatch(server.output(), /Uncaught exception/);
});

test('a compressed body that is huge once unpacked is refused', async () => {
  // About 20 KB on the wire, 20 MB unpacked: over the 1 MB limit for sign-in.
  const bomb = gzipSync(Buffer.from(`{"email":"${'a'.repeat(20 * 1024 * 1024)}"}`));
  const response = await send(bomb, { 'Content-Encoding': 'gzip' });
  assert.equal(response.status, 413);
});

test('broken JSON gets a clear message, not an error page', async () => {
  const response = await send('{"email": ', {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, 'Invalid request body.');
});
