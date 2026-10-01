import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Use Railway's mounted volume in production, local ./data folder in dev
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');

// Make sure the directory exists (Railway volume starts empty)
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dataFilePath = path.join(DATA_DIR, 'db.json');
const databasePath = path.join(DATA_DIR, 'bahari.sqlite');
const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, data TEXT NOT NULL);
`);
const app = express();
const allowedOrigins = [...new Set([
  ...(process.env.CLIENT_URL || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()).filter(Boolean),
  'https://bahari-operations-web-production.up.railway.app'
])];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
// Railway and Render sit one proxy in front of the app; without this every request's IP is the proxy's.
app.set('trust proxy', 1);

const DEFAULT_STATE = { users: [], messages: [], reports: [], tasks: [], goals: [] };
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'local-development-secret';
const onlineUsers = new Map(); // userId -> Set of socket ids
const roleReportTypes = {
  supervisor: ['neglected', 'quality', 'trolley_pantry', 'handover'],
  storekeeper: ['tools'],
  driver: ['vehicle'],
  manager: ['neglected', 'quality', 'trolley_pantry', 'handover', 'vehicle', 'tools', 'inspection_rate'],
  assistant_manager: ['neglected', 'quality', 'trolley_pantry', 'handover', 'vehicle', 'tools', 'inspection_rate']
};

function readState() {
  const tableCounts = ['users', 'messages', 'reports', 'tasks', 'goals'].map((table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  if (tableCounts.every((count) => count === 0) && fs.existsSync(dataFilePath)) {
    const legacyState = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
    const importState = database.transaction(() => {
      for (const [table, rows] of Object.entries(legacyState)) {
        if (!['users', 'messages', 'reports', 'tasks', 'goals'].includes(table) || !Array.isArray(rows)) continue;
        const insert = database.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`);
        rows.forEach((row) => insert.run(row.id, JSON.stringify(row)));
      }
    });
    importState();
  }
  const load = (table) => database.prepare(`SELECT data FROM ${table}`).all().map((row) => JSON.parse(row.data));
  return { users: load('users'), messages: load('messages'), reports: load('reports'), tasks: load('tasks'), goals: load('goals') };
}

let state = readState();

const upsertStatements = Object.fromEntries(['users', 'messages', 'reports', 'tasks', 'goals'].map((table) => [table, database.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)]));

// Persist only the row that changed; rewriting whole tables on every update gets slow as reports and photos accumulate.
function saveRow(table, row) {
  upsertStatements[table].run(row.id, JSON.stringify(row));
}

if (!state.users || state.users.length === 0) {
  // Never seed a publicly known password in production: use SEED_MANAGER_PASSWORD, or generate one and print it once.
  const seedPassword = process.env.SEED_MANAGER_PASSWORD || (process.env.NODE_ENV === 'production' ? randomBytes(12).toString('base64url') : 'password123');
  state.users = [{
    id: randomUUID(),
    name: 'Manager',
    email: 'manager@bahari.local',
    avatar: 'https://ui-avatars.com/api/?name=Manager&background=2563eb&color=fff',
    role: 'manager',
    password: await bcrypt.hash(seedPassword, 10),
    active: true,
    status: 'offline',
    createdAt: new Date().toISOString(),
  }];
  saveRow('users', state.users[0]);
  console.log(process.env.SEED_MANAGER_PASSWORD
    ? 'Seeded default manager: manager@bahari.local (password from SEED_MANAGER_PASSWORD)'
    : `Seeded default manager: manager@bahari.local / ${seedPassword}`);
}

// HK Goals Tracker, seeded from the department's tracker workbook. Managers edit it on the Goals page.
if (!state.goals.length) {
  const goals = {
    id: 'current',
    year: 2026,
    smartGoals: [
      { key: 'cleaning_level', label: 'Cleaning Level', target: 98, rate: 144 },
      { key: 'hygiene_standard', label: 'Hygiene Standard', target: 0, rate: 26 },
      { key: 'organization_supplies', label: 'Organization Supplies', target: 0, rate: 20 },
      { key: 'guest_interaction', label: 'Enhance Guest Interaction', target: 0, rate: 40 }
    ],
    // HK scores are 1-10 per area; 0 or missing = not yet rated.
    hkProgress: [
      { name: 'Agness Ramadan' }, { name: 'Abdallah Hassan' }, { name: 'Amina Abdalla' }, { name: 'Amina Said' },
      { name: 'Feisal Abdalla' }, { name: 'Chrisitna Andrea' }, { name: 'Clementina Mwapopo' }, { name: 'Diana Ndanshau' },
      { name: 'Dora Godson', cleaning: 10 }, { name: 'Elizabeth Antony' }, { name: 'Elizabeth Petro' }, { name: 'Sara Mbise' },
      { name: 'Khairat Juma', cleaning: 8 }, { name: 'Hajrat Michael' }, { name: 'Hapsa Omar' }, { name: 'Hilda Daniel' },
      { name: 'Madua Hassan' }, { name: 'Mariam Khalifan' }, { name: 'Matilder Richard' }, { name: 'Anifa' },
      { name: 'Mulfida' }, { name: 'Mwajuma Seif' }, { name: 'Mwanaide Ally' }, { name: 'Nachia Abdallah' },
      { name: 'Nahla Mohammed' }, { name: 'Najma Khamis' }, { name: 'Pili Omar' }, { name: 'khadija' },
      { name: 'Salome Festo' }, { name: 'Shamimu Hassan' }, { name: 'Sharifa Sharif', cleaning: 9 }, { name: 'Sophia Amos' },
      { name: 'Teresia Kassim' }, { name: 'Nehema' }, { name: 'Yasinta Alfred', cleaning: 8 }, { name: 'Zawadi' },
      { name: 'Dorice Edward' }, { name: 'Maryam Mohammed' }, { name: 'Zuwena Ally' }, { name: 'Christina' }
    ],
    // Public Area numbers are tally counts, not 1-10 scores.
    paProgress: [
      { name: 'Abdallah Mberwa', cleaning: 34, hygiene: 7, farewellLounge: 7 },
      { name: 'Abubakar Jaala', cleaning: 33, hygiene: 16, guestInteraction: 11 },
      { name: 'Amir Seif', cleaning: 21, hygiene: 12, farewellLounge: 15, weakness: 'FL drainage, shelf. Library shelf, soap dispenser, hair dryer' },
      { name: 'Adil', cleaning: 18 },
      { name: 'Hussein Hatibu', cleaning: 22, guestInteraction: 8, weakness: 'soap dispense, wall tiles, door handle' },
      { name: 'Innocent', cleaning: 27, guestInteraction: 7 },
      { name: 'Isaya Peter', cleaning: 29 },
      { name: 'Nurudinin Yussuf', cleaning: 23, hygiene: 6, farewellLounge: 7, weakness: 'FL drainage, shelf.' },
      { name: 'Suleiman Amer', cleaning: 16, guestInteraction: 3, weakness: 'needs to study english' },
      { name: 'Twa Hamid', cleaning: 18, hygiene: 9, guestInteraction: 4, weakness: 'english need practice' },
      { name: 'Yahya Juma', cleaning: 32, hygiene: 6, farewellLounge: 8, weakness: 'shelf, door handle' },
      { name: 'Yussuf Amour', cleaning: 8, hygiene: 9 }
    ]
  };
  state.goals.push(goals);
  saveRow('goals', goals);
}

const POINTS_TARGETS = { supervisor: 500, hk: 150, deadline: '2027-09-30' };
const HK_POINT_TYPES = ['quality', 'neglected', 'trolley_pantry'];
const sum = (values) => values.reduce((total, value) => total + value, 0);
const nameKey = (name) => String(name || '').trim().toLowerCase();

// Supervisor points: every room total (out of 50) from Inspection Rate Program reports about them, plus a cumulative history.
function supervisorPoints() {
  const reports = state.reports.filter((report) => report.type === 'inspection_rate' && !report.voided)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return state.users.filter((user) => user.role === 'supervisor' && user.active !== false).map((supervisor) => {
    let points = 0;
    const history = [];
    for (const report of reports.filter((entry) => entry.data?.supervisorId === supervisor.id)) {
      points += sum(scoredEntries(report).map((entry) => sum(scoreValues(entry))));
      history.push({ date: report.date, points });
    }
    return { id: supervisor.id, name: supervisor.name, points, sessions: history.length, history };
  });
}

// HK points: each inspected room adds its average score (max 10), whichever report type it came from,
// so a 17-box Quality Checklist room counts the same as a 3-box Neglected Area room.
function hkPoints(roster) {
  const totals = new Map();
  for (const report of state.reports) {
    if (report.voided || !HK_POINT_TYPES.includes(report.type)) continue;
    for (const entry of scoredEntries(report)) {
      const values = scoreValues(entry);
      if (!entry.hkName || !values.length) continue;
      const key = nameKey(entry.hkName);
      const current = totals.get(key) || { name: String(entry.hkName).trim(), points: 0, rooms: 0 };
      current.points += sum(values) / values.length;
      current.rooms += 1;
      totals.set(key, current);
    }
  }
  const rows = roster.map((person) => {
    const found = totals.get(nameKey(person.name));
    totals.delete(nameKey(person.name));
    return { name: person.name, points: Number((found?.points || 0).toFixed(1)), rooms: found?.rooms || 0, onRoster: true };
  });
  // Names typed in reports that don't match the roster (often typos) are listed separately, not counted in the pass rate.
  const unmatched = [...totals.values()].map((entry) => ({ ...entry, points: Number(entry.points.toFixed(1)), onRoster: false }));
  return [...rows, ...unmatched];
}

function goalsResponse() {
  const goals = state.goals.find((entry) => entry.id === 'current');
  return { ...goals, targets: POINTS_TARGETS, supervisorPoints: supervisorPoints(), hkPoints: hkPoints(goals.hkProgress) };
}

const clampScore = (value) => Math.min(10, Math.max(0, Math.round(Number(value) || 0)));
const tally = (value) => Math.max(0, Math.round(Number(value) || 0));
const cleanName = (value) => String(value || '').trim().slice(0, 80);
const GOALS_SHAPE = {
  smartGoals: (rows) => rows.filter((row) => row && row.key).map((row) => ({ key: String(row.key).slice(0, 60), label: cleanName(row.label) || String(row.key), target: tally(row.target), rate: tally(row.rate) })),
  hkProgress: (rows) => rows.filter((row) => cleanName(row?.name)).map((row) => ({ name: cleanName(row.name), ...Object.fromEntries(['cleaning', 'hygiene', 'guestInteraction', 'cleaningTime', 'trolleyPantry'].map((key) => [key, clampScore(row[key])])) })),
  paProgress: (rows) => rows.filter((row) => cleanName(row?.name)).map((row) => ({ name: cleanName(row.name), ...Object.fromEntries(['cleaning', 'hygiene', 'guestInteraction', 'farewellLounge'].map((key) => [key, tally(row[key])])), weakness: String(row.weakness || '').slice(0, 300) }))
};

const server = app.listen(process.env.PORT || 5000, () => {
  console.log(`HK SYNC backend running on port ${process.env.PORT || 5000}`);
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || 'supervisor',
    active: user.active !== false,
    avatar: user.avatar,
    status: user.status,
    createdAt: user.createdAt,
    isOnline: (onlineUsers.get(user.id)?.size || 0) > 0
  };
}

function requireManager(req, res, next) {
  const user = state.users.find((entry) => entry.id === req.user.id);
  if (!user || !['manager', 'assistant_manager'].includes(user.role)) {
    return res.status(403).json({ message: 'Manager access required.' });
  }
  req.currentUser = user;
  next();
}

function currentUser(req) {
  return state.users.find((user) => user.id === req.user.id);
}

function scoreValues(entry) {
  if (!entry || !entry.scores) return [];
  // Blank fields are "not scored", not zero.
  return Object.values(entry.scores).filter((score) => score !== '' && score !== null).map(Number).filter((score) => Number.isFinite(score));
}

// Inspection Rate Program rooms under 40/50 (average below 8) must be re-cleaned before check-in.
const FLAG_THRESHOLDS = { inspection_rate: 8 };

// Older reports carry a placeholder `entries` item on every type, so only read the lists that belong to the report type.
function scoredEntries(report) {
  const list = (key) => (Array.isArray(report.data?.[key]) ? report.data[key] : []);
  if (report.type === 'trolley_pantry') return [...list('trolleys'), ...list('pantries')];
  return ['vehicle', 'handover'].includes(report.type) ? [] : list('entries');
}

function reportSummary(report) {
  const entries = scoredEntries(report);
  const threshold = FLAG_THRESHOLDS[report.type] ?? 6;
  const scores = entries.flatMap(scoreValues);
  const hasBadVehicle = Object.values(report.data?.vehicle || {}).includes('Not OK');
  const flaggedEntries = entries.filter((entry) => {
    const values = scoreValues(entry);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 10;
    return average < threshold || entry.status === 'Broken' || Boolean(entry.remarks);
  });
  return {
    itemCount: entries.length || (report.data?.items ? report.data.items.length : 0),
    average: scores.length ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(1)) : 0,
    flagged: Boolean(hasBadVehicle || flaggedEntries.length || report.data?.notes),
    flaggedCount: flaggedEntries.length + (hasBadVehicle ? 1 : 0)
  };
}

function withoutPhotos(data) {
  if (!data) return data;
  const strip = (entries) => Array.isArray(entries) ? entries.map(({ photo, ...entry }) => ({ ...entry, hasPhoto: Boolean(photo) })) : entries;
  return { ...data, entries: strip(data.entries), trolleys: strip(data.trolleys), pantries: strip(data.pantries) };
}

function buildMessageEntry(message) {
  return {
    id: message.id,
    senderId: message.senderId,
    receiverId: message.receiverId,
    text: message.text,
    createdAt: message.createdAt,
    read: Boolean(message.read)
  };
}

// JWT iat has one-second precision, so compare at that precision.
function issuedBeforePasswordChange(decoded, user) {
  return Boolean(user.passwordChangedAt) && decoded.iat < Math.floor(user.passwordChangedAt / 1000);
}

function setPassword(user, hashedPassword) {
  user.password = hashedPassword;
  user.passwordChangedAt = Date.now();
  delete user.resetTokenHash;
  delete user.resetTokenExpiresAt;
}

// Password reset links point at the frontend; APP_URL overrides, otherwise the first CLIENT_URL origin.
const APP_URL = (process.env.APP_URL || (process.env.CLIENT_URL || '').split(',')[0].trim()
  || (process.env.NODE_ENV === 'production' ? 'https://bahari-operations-web-production.up.railway.app' : 'http://localhost:5173')).replace(/\/+$/, '');
const emailConfigured = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
// Without email in production nobody could receive a self-service link, so staff are pointed to a manager instead.
// Development keeps the flow on (the link comes back in the response) so it can be tested locally.
const selfServiceReset = emailConfigured || process.env.NODE_ENV !== 'production';

function issueResetLink(user, ttlMs) {
  const resetToken = randomBytes(32).toString('hex');
  user.resetTokenHash = createHash('sha256').update(resetToken).digest('hex');
  user.resetTokenExpiresAt = Date.now() + ttlMs;
  saveRow('users', user);
  return { resetToken, resetLink: `${APP_URL}/?reset=${resetToken}` };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Sends through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email); no SDK needed.
async function sendResetEmail(user, resetLink, validFor) {
  if (!emailConfigured) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [user.email],
      subject: 'Reset your HK SYNC password',
      text: `Hello ${user.name},\n\nUse this link to set a new HK SYNC password (valid for ${validFor}):\n${resetLink}\n\nIf you didn't ask for this, you can ignore this email.`,
      html: `<p>Hello ${escapeHtml(user.name)},</p><p><a href="${resetLink}">Set a new HK SYNC password</a> (valid for ${validFor}).</p><p>If you didn't ask for this, you can ignore this email.</p>`
    })
  });
  if (!response.ok) throw new Error(`Resend responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return true;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = state.users.find((entry) => entry.id === decoded.id);
    if (!user || user.active === false || issuedBeforePasswordChange(decoded, user)) {
      return res.status(401).json({ message: 'This account is no longer active.' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'HK SYNC backend is running.' });
});

// Brute-force protection: count failed sign-ins per account and per client IP in a fixed window.
// The IP limit is generous because staff on the hotel Wi-Fi share one public address.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMITS = { account: 5, ip: 50 };
const loginFailures = new Map();

function failuresFor(key) {
  const entry = loginFailures.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    loginFailures.delete(key);
    return null;
  }
  return entry;
}

function recordLoginFailure(key) {
  const entry = failuresFor(key);
  if (entry) entry.count += 1;
  else loginFailures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
}

setInterval(() => loginFailures.forEach((entry, key) => failuresFor(key)), LOGIN_WINDOW_MS).unref();

// Railway's edge documents X-Real-IP as the client address; elsewhere (Render, local) rely on trust proxy + req.ip.
function clientIp(req) {
  return (process.env.RAILWAY_ENVIRONMENT && req.get('x-real-ip')) || req.ip;
}

app.post('/api/auth/login', async (req, res) => {
  const accountKey = `account:${String(req.body?.email || '').trim().toLowerCase()}`;
  const ipKey = `ip:${clientIp(req)}`;
  const blocked = [[accountKey, LOGIN_LIMITS.account], [ipKey, LOGIN_LIMITS.ip]]
    .map(([key, limit]) => failuresFor(key)?.count >= limit ? failuresFor(key) : null)
    .find(Boolean);
  if (blocked) {
    const minutes = Math.ceil((blocked.resetAt - Date.now()) / 60000);
    res.set('Retry-After', String(Math.ceil((blocked.resetAt - Date.now()) / 1000)));
    return res.status(429).json({ message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const user = state.users.find((entry) => entry.email.toLowerCase() === String(email).toLowerCase());
  if (!user || !(await bcrypt.compare(String(password), user.password))) {
    recordLoginFailure(accountKey);
    recordLoginFailure(ipKey);
    return res.status(401).json({ message: 'Invalid email or password.' });
  }
  loginFailures.delete(accountKey);
  if (user.active === false) {
    return res.status(403).json({ message: 'This account is inactive. Contact a manager.' });
  }

  user.status = 'online';
  saveRow('users', user);

  const token = createToken(user);
  return res.json({ token, user: sanitizeUser(user) });
});

app.get('/api/auth/options', (req, res) => {
  res.json({ emailReset: selfServiceReset });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  if (!selfServiceReset) return res.json({ message: "Password reset by email isn't set up. Ask a manager to send you a reset link." });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const response = { message: "If that account exists, we've emailed a link to reset the password. Ask a manager if it doesn't arrive." };
  const emailKey = `forgot:${email}`;
  const ipKey = `forgot-ip:${clientIp(req)}`;
  if ((failuresFor(ipKey)?.count || 0) >= 10) {
    return res.status(429).json({ message: 'Too many reset requests. Try again later.' });
  }
  recordLoginFailure(ipKey);
  // Cap emails per address so the form can't be used to flood someone's inbox; the response doesn't change.
  if ((failuresFor(emailKey)?.count || 0) >= 3) return res.json(response);
  recordLoginFailure(emailKey);

  const user = state.users.find((entry) => entry.email === email && entry.active !== false);
  if (user) {
    const { resetToken, resetLink } = issueResetLink(user, 60 * 60 * 1000);
    try {
      await sendResetEmail(user, resetLink, '1 hour');
    } catch (error) {
      console.error('Password reset email failed:', error.message);
    }
    if (process.env.NODE_ENV !== 'production') response.resetToken = resetToken;
  }
  return res.json(response);
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'A reset token and password of at least 8 characters are required.' });
  }
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const user = state.users.find((entry) => entry.resetTokenHash === tokenHash && Number(entry.resetTokenExpiresAt) > Date.now());
  if (!user) return res.status(400).json({ message: 'This reset link is invalid or expired.' });
  setPassword(user, await bcrypt.hash(password, 10));
  saveRow('users', user);
  io.in(user.id).disconnectSockets(true);
  return res.json({ message: 'Password reset successfully. You can now sign in.' });
});

app.get('/api/users/me', authMiddleware, (req, res) => {
  const user = state.users.find((entry) => entry.id === req.user.id);

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/users/me/password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ message: 'Your current password and a new password of at least 8 characters are required.' });
  }
  const user = currentUser(req);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    return res.status(400).json({ message: 'Your current password is incorrect.' });
  }
  setPassword(user, await bcrypt.hash(newPassword, 10));
  saveRow('users', user);
  // Other sessions (other devices, or someone with the old password) are now signed out; this one gets a fresh token.
  io.in(user.id).disconnectSockets(true);
  return res.json({ message: 'Password changed. Other devices have been signed out.', token: createToken(user) });
});

app.get('/api/users', authMiddleware, (req, res) => {
  const { q = '' } = req.query;
  const term = String(q).trim().toLowerCase();

  const results = state.users
    .filter((user) => user.id !== req.user.id)
    .filter((user) => !term || user.name.toLowerCase().includes(term) || user.email.toLowerCase().includes(term))
    .map(sanitizeUser);

  return res.json({ users: results });
});

app.get('/api/users/all', authMiddleware, (req, res) => {
  return res.json({ users: state.users.map(sanitizeUser) });
});

// Managers can manage everyone else; assistant managers only field staff, so they can't lock out the manager or each other.
const FIELD_STAFF_ROLES = ['supervisor', 'driver', 'storekeeper'];
function canManageRole(actor, role) {
  return actor.role === 'manager' ? role !== 'manager' : FIELD_STAFF_ROLES.includes(role);
}

app.post('/api/users/staff', authMiddleware, requireManager, async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const allowedRoles = [...FIELD_STAFF_ROLES, 'assistant_manager'];
  if (!name || !email || !password || !allowedRoles.includes(role)) {
    return res.status(400).json({ message: 'Name, email, password, and a valid staff role are required.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'The temporary password must be at least 8 characters.' });
  }
  if (!canManageRole(req.currentUser, role)) {
    return res.status(403).json({ message: 'Only the manager can create assistant manager accounts.' });
  }
  if (state.users.some((user) => user.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ message: 'A user with that email already exists.' });
  }
  const staffUser = {
    id: randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role,
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name.trim())}&background=147d55&color=fff`,
    password: await bcrypt.hash(password, 10),
    active: true,
    status: 'offline',
    createdAt: new Date().toISOString()
  };
  state.users.push(staffUser);
  saveRow('users', staffUser);
  return res.status(201).json({ user: sanitizeUser(staffUser) });
});

app.patch('/api/users/:id/status', authMiddleware, requireManager, (req, res) => {
  const user = state.users.find((entry) => entry.id === req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (user.id === req.currentUser.id) return res.status(400).json({ message: 'You cannot deactivate your own account.' });
  if (!canManageRole(req.currentUser, user.role)) return res.status(403).json({ message: 'You cannot change this account.' });
  user.active = Boolean(req.body?.active);
  saveRow('users', user);
  if (!user.active) io.in(user.id).disconnectSockets(true);
  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/users/:id/reset-password', authMiddleware, requireManager, async (req, res) => {
  const user = state.users.find((entry) => entry.id === req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (!canManageRole(req.currentUser, user.role)) return res.status(403).json({ message: "You cannot reset this account's password." });
  const { resetLink } = issueResetLink(user, 24 * 60 * 60 * 1000);
  let emailed = false;
  try {
    emailed = await sendResetEmail(user, resetLink, '24 hours');
  } catch (error) {
    console.error('Password reset email failed:', error.message);
  }
  return res.json({ resetLink, emailed, message: emailed ? `Reset link emailed to ${user.email}.` : 'Reset link created.' });
});

app.get('/api/reports', authMiddleware, (req, res) => {
  const viewer = currentUser(req);
  const reports = state.reports
    .filter((report) => !report.voided)
    .filter((report) => ['manager', 'assistant_manager'].includes(viewer?.role) || report.submittedBy === req.user.id)
    .map((report) => ({
      ...report,
      data: withoutPhotos(report.data),
      submitter: sanitizeUser(state.users.find((user) => user.id === report.submittedBy) || {}),
      ...reportSummary(report)
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ reports });
});

// Full report including photos; the list endpoint above leaves photos out to keep it small.
app.get('/api/reports/:id', authMiddleware, (req, res) => {
  const viewer = currentUser(req);
  const report = state.reports.find((entry) => entry.id === req.params.id && !entry.voided);
  if (!report || (!['manager', 'assistant_manager'].includes(viewer?.role) && report.submittedBy !== req.user.id)) {
    return res.status(404).json({ message: 'Report not found.' });
  }
  return res.json({ report: { ...report, submitter: sanitizeUser(state.users.find((user) => user.id === report.submittedBy) || {}), ...reportSummary(report) } });
});

app.post('/api/reports', authMiddleware, (req, res) => {
  const { type, date, data } = req.body || {};
  if (!type || !date || !data) return res.status(400).json({ message: 'Report type, date and data are required.' });
  const submitter = currentUser(req);
  if (!roleReportTypes[submitter?.role]?.includes(type)) {
    return res.status(403).json({ message: 'Your role cannot submit this report type.' });
  }
  if (type === 'inspection_rate') {
    const evaluated = state.users.find((user) => user.id === data.supervisorId && user.role === 'supervisor' && user.active !== false);
    if (!evaluated) return res.status(400).json({ message: 'Choose the supervisor being evaluated.' });
    data.supervisorName = evaluated.name;
  }
  const report = {
    id: randomUUID(), type, date, data, submittedBy: req.user.id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hodSignature: null
  };
  state.reports.push(report);
  saveRow('reports', report);
  return res.status(201).json({ report: { ...report, data: withoutPhotos(report.data), ...reportSummary(report) } });
});

app.get('/api/goals', authMiddleware, requireManager, (req, res) => {
  return res.json({ goals: goalsResponse() });
});

// Replaces only the manager-entered sections that are posted; points are always computed, never stored.
app.put('/api/goals', authMiddleware, requireManager, (req, res) => {
  const goals = state.goals.find((entry) => entry.id === 'current');
  for (const [section, clean] of Object.entries(GOALS_SHAPE)) {
    if (req.body?.[section] === undefined) continue;
    if (!Array.isArray(req.body[section])) return res.status(400).json({ message: `${section} must be a list.` });
    goals[section] = clean(req.body[section]);
  }
  goals.updatedAt = new Date().toISOString();
  goals.updatedBy = req.currentUser.name;
  saveRow('goals', goals);
  return res.json({ goals: goalsResponse() });
});

app.post('/api/reports/:id/sign', authMiddleware, requireManager, (req, res) => {
  const report = state.reports.find((entry) => entry.id === req.params.id);
  if (!report) return res.status(404).json({ message: 'Report not found.' });
  report.hodSignature = req.currentUser.name;
  report.hodSignedAt = new Date().toISOString();
  report.updatedAt = new Date().toISOString();
  saveRow('reports', report);
  return res.json({ report: { ...report, data: withoutPhotos(report.data) } });
});

app.get('/api/tasks', authMiddleware, (req, res) => {
  const tasks = state.tasks.filter((task) => task.assignedTo === req.user.id || ['manager', 'assistant_manager'].includes(state.users.find((user) => user.id === req.user.id)?.role));
  return res.json({ tasks });
});

app.post('/api/tasks', authMiddleware, requireManager, (req, res) => {
  const { title, location, assignedTo, priority = 'medium', dueDate } = req.body || {};
  if (!title || !location) return res.status(400).json({ message: 'Task title and location are required.' });
  const task = { id: randomUUID(), title, location, assignedTo: assignedTo || null, assignedBy: req.user.id, priority, dueDate: dueDate || null, status: 'pending', createdAt: new Date().toISOString() };
  state.tasks.push(task);
  saveRow('tasks', task);
  return res.status(201).json({ task });
});

app.patch('/api/tasks/:id/status', authMiddleware, (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'in_progress', 'completed'].includes(status)) {
    return res.status(400).json({ message: 'Status must be pending, in_progress or completed.' });
  }
  const task = state.tasks.find((entry) => entry.id === req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found.' });
  const isManager = ['manager', 'assistant_manager'].includes(currentUser(req)?.role);
  if (!isManager && task.assignedTo !== req.user.id) {
    return res.status(403).json({ message: 'Only the assigned staff member or a manager can update this task.' });
  }
  task.status = status;
  task.updatedAt = new Date().toISOString();
  task.completedAt = status === 'completed' ? task.updatedAt : null;
  saveRow('tasks', task);
  return res.json({ task });
});

// One summary per person you have messaged: last message and how many of theirs you haven't read.
app.get('/api/messages', authMiddleware, (req, res) => {
  const summaries = new Map();
  for (const msg of state.messages) {
    if (msg.senderId !== req.user.id && msg.receiverId !== req.user.id) continue;
    const otherId = msg.senderId === req.user.id ? msg.receiverId : msg.senderId;
    const summary = summaries.get(otherId) || { userId: otherId, lastMessage: null, unread: 0 };
    if (!summary.lastMessage || new Date(msg.createdAt) > new Date(summary.lastMessage.createdAt)) summary.lastMessage = buildMessageEntry(msg);
    if (msg.receiverId === req.user.id && !msg.read) summary.unread += 1;
    summaries.set(otherId, summary);
  }
  return res.json({ conversations: [...summaries.values()] });
});

app.post('/api/messages/:userId/read', authMiddleware, (req, res) => {
  let updated = 0;
  for (const msg of state.messages) {
    if (msg.senderId === req.params.userId && msg.receiverId === req.user.id && !msg.read) {
      msg.read = true;
      saveRow('messages', msg);
      updated += 1;
    }
  }
  if (updated) io.to(req.user.id).emit('messages:read', { userId: req.params.userId });
  return res.json({ updated });
});

app.get('/api/messages/:userId', authMiddleware, (req, res) => {
  const withUserId = req.params.userId;
  const messages = state.messages
    .filter((msg) =>
      (msg.senderId === req.user.id && msg.receiverId === withUserId) ||
      (msg.senderId === withUserId && msg.receiverId === req.user.id)
    )
    .map(buildMessageEntry)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return res.json({ messages });
});

app.post('/api/messages', authMiddleware, (req, res) => {
  const { receiverId, text } = req.body || {};

  if (!receiverId || !text || !String(text).trim()) {
    return res.status(400).json({ message: 'Receiver and message text are required.' });
  }

  const receiver = state.users.find((user) => user.id === receiverId);
  if (!receiver || receiver.active === false) {
    return res.status(404).json({ message: 'Recipient user not found.' });
  }
  if (receiverId === req.user.id) {
    return res.status(400).json({ message: 'You cannot message yourself.' });
  }
  if (String(text).trim().length > 2000) {
    return res.status(400).json({ message: 'Messages can be at most 2000 characters.' });
  }

  const message = {
    id: randomUUID(),
    senderId: req.user.id,
    receiverId,
    text: String(text).trim(),
    createdAt: new Date().toISOString(),
    read: false
  };

  state.messages.push(message);
  saveRow('messages', message);

  const payload = buildMessageEntry(message);
  io.to(receiverId).emit('new-message', payload);
  io.to(req.user.id).emit('new-message', payload);

  return res.status(201).json({ message: payload });
});

// Sockets must present a valid JWT (socket.io-client: `io(url, { auth: { token } })`); the user id always comes from the token, never from the client.
io.use((socket, next) => {
  try {
    const decoded = jwt.verify(socket.handshake.auth?.token || '', JWT_SECRET);
    const user = state.users.find((entry) => entry.id === decoded.id);
    if (!user || user.active === false || issuedBeforePasswordChange(decoded, user)) return next(new Error('Unauthorized'));
    socket.authUserId = user.id;
    next();
  } catch (error) {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.authUserId;
  socket.join(userId);
  const sockets = onlineUsers.get(userId) || new Set();
  sockets.add(socket.id);
  onlineUsers.set(userId, sockets);
  if (sockets.size === 1) io.emit('presence:update', { userId, isOnline: true });

  socket.on('register-user', () => {});

  socket.on('disconnect', () => {
    const remaining = onlineUsers.get(userId);
    remaining?.delete(socket.id);
    if (!remaining?.size) {
      onlineUsers.delete(userId);
      io.emit('presence:update', { userId, isOnline: false });
    }
  });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Not found.' });
});

// Body-parser errors (oversized uploads, malformed JSON) otherwise come back as HTML pages.
app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ message: 'Upload is too large. Try fewer or smaller photos.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid request body.' });
  console.error(error);
  return res.status(500).json({ message: 'Something went wrong on the server.' });
});

export default server;
