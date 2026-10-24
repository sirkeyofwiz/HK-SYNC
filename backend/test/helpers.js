// Starts a throwaway copy of the real API (server.js, unchanged) on a free port with an empty database in a temporary
// folder, so tests talk to it exactly the way the app does. Nothing touches backend/data or the live server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANAGER = { email: 'manager@bahari.local', password: 'test-manager-password' };

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

export async function startServer(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-sync-test-'));
  const port = await freePort();
  const env = { ...process.env };
  // Never let a developer's own settings (live bucket, email, Firebase) reach a test server.
  for (const name of Object.keys(env)) if (/^(BACKUP_|RESTORE_BACKUP|RESEND_|EMAIL_FROM|FIREBASE_|VAPID_|RAILWAY_|LOGIN_|ALLOW_ANY_REPORT_DATE)/.test(name)) delete env[name];
  Object.assign(env, {
    NODE_ENV: 'test',
    PORT: String(port),
    RAILWAY_VOLUME_MOUNT_PATH: dataDir,
    JWT_SECRET: 'test-secret',
    SEED_MANAGER_PASSWORD: MANAGER.password,
    ...extraEnv
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The test server did not start within 20 seconds:\n${output}`)), 20000);
    child.stdout.on('data', () => { if (output.includes('backend running on port')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`The test server stopped (exit ${code}):\n${output}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    output: () => output,
    async stop() {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    // call('GET', '/api/reports', { token }) -> { status, body }
    async call(method, route, { token, body, headers = {} } = {}) {
      const raw = Buffer.isBuffer(body);
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
      });
      const text = await response.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* files come back as-is */ }
      return { status: response.status, body: parsed };
    }
  };
}

export async function login(server, email, password) {
  const { status, body } = await server.call('POST', '/api/auth/login', { body: { email, password } });
  if (status !== 200) throw new Error(`Sign-in as ${email} failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

let staffCount = 0;
// Creates an account through the manager (the only way in) and signs in as it.
export async function createStaff(server, managerToken, role, name = `${role} ${++staffCount}`) {
  const email = `${role}.${staffCount}.${Date.now()}@test.local`;
  const password = 'staff-password-1';
  const { status, body } = await server.call('POST', '/api/users/staff', { token: managerToken, body: { name, email, password, role } });
  if (status !== 201) throw new Error(`Creating a ${role} failed (${status}): ${JSON.stringify(body)}`);
  return { user: body.user, email, password, token: await login(server, email, password) };
}

// Today's date on the hotel's clock, offset by whole days (the server's report-date rule uses the same clock).
export const hotelDate = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86400000));

// A Quality Checklist with one room; `score` goes in every box.
export const qualityReport = (score = 9, extra = {}) => ({
  type: 'quality',
  date: hotelDate(),
  data: { area: 'Block A', entries: [{ room: '101', hkName: 'Test Housekeeper', scores: { Shower: score, 'Bed / phone': score }, remarks: '', ...extra }] }
});

// A tiny valid PNG, as the app sends a photo taken on the phone.
export const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
