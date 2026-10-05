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
import webpush from 'web-push';

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
  CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
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
// Express 4 doesn't catch errors from async handlers: one bad request would crash the whole server for everyone.
// Wrap every route handler so thrown errors and rejected promises go to the error handler at the bottom instead.
const forwardErrors = (handler) => (typeof handler !== 'function' || handler.length > 3 ? handler : (req, res, next) => {
  try {
    const result = handler(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (error) {
    next(error);
  }
});
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) => register(route, ...handlers.map(forwardErrors));
}
// Last safety net for anything outside a request (timers, sockets, push): log it, keep serving.
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
app.use(express.json({ limit: '10mb' }));
// Railway and Render sit one proxy in front of the app; without this every request's IP is the proxy's.
app.set('trust proxy', 1);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// A report's line list (entries / trolleys / pantries), skipping anything that isn't a proper line.
const reportLines = (report, key) => (Array.isArray(report?.data?.[key]) ? report.data[key].filter(isPlainObject) : []);
const DEFAULT_STATE = { users: [], messages: [], reports: [], tasks: [], goals: [], attachments: [], settings: [], notifications: [], subscriptions: [] };
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'local-development-secret';
const onlineUsers = new Map(); // userId -> Set of socket ids
const roleReportTypes = {
  supervisor: ['neglected', 'quality', 'trolley_pantry', 'handover', 'guest_interaction'],
  storekeeper: ['tools'],
  driver: ['vehicle'],
  manager: ['neglected', 'quality', 'trolley_pantry', 'handover', 'vehicle', 'tools', 'inspection_rate', 'guest_interaction'],
  assistant_manager: ['neglected', 'quality', 'trolley_pantry', 'handover', 'vehicle', 'tools', 'inspection_rate', 'guest_interaction']
};

function readState() {
  const tableCounts = ['users', 'messages', 'reports', 'tasks', 'goals', 'attachments', 'settings', 'notifications', 'subscriptions'].map((table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  if (tableCounts.every((count) => count === 0) && fs.existsSync(dataFilePath)) {
    const legacyState = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
    const importState = database.transaction(() => {
      for (const [table, rows] of Object.entries(legacyState)) {
        if (!['users', 'messages', 'reports', 'tasks', 'goals', 'attachments', 'settings', 'notifications', 'subscriptions'].includes(table) || !Array.isArray(rows)) continue;
        const insert = database.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`);
        rows.forEach((row) => insert.run(row.id, JSON.stringify(row)));
      }
    });
    importState();
  }
  const load = (table) => database.prepare(`SELECT data FROM ${table}`).all().map((row) => JSON.parse(row.data));
  return { users: load('users'), messages: load('messages'), reports: load('reports'), tasks: load('tasks'), goals: load('goals'), attachments: load('attachments'), settings: load('settings'), notifications: load('notifications'), subscriptions: load('subscriptions') };
}

let state = readState();

const upsertStatements = Object.fromEntries(['users', 'messages', 'reports', 'tasks', 'goals', 'attachments', 'settings', 'notifications', 'subscriptions'].map((table) => [table, database.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)]));

// Persist only the row that changed; rewriting whole tables on every update gets slow as reports and photos accumulate.
function saveRow(table, row) {
  upsertStatements[table].run(row.id, JSON.stringify(row));
}

const deleteStatements = Object.fromEntries(['messages', 'attachments', 'notifications', 'subscriptions'].map((table) => [table, database.prepare(`DELETE FROM ${table} WHERE id = ?`)]));
function deleteRow(table, id) {
  deleteStatements[table].run(id);
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

// HK Goals Tracker. Managers keep the roster names and SMART targets; every score is calculated from supervisor reports.
const HK_ROSTER = ['Agness Ramadan', 'Abdallah Hassan', 'Amina Abdalla', 'Amina Said', 'Feisal Abdalla', 'Chrisitna Andrea', 'Clementina Mwapopo',
  'Diana Ndanshau', 'Dora Godson', 'Elizabeth Antony', 'Elizabeth Petro', 'Sara Mbise', 'Khairat Juma', 'Hajrat Michael', 'Hapsa Omar', 'Hilda Daniel',
  'Madua Hassan', 'Mariam Khalifan', 'Matilder Richard', 'Anifa', 'Mulfida', 'Mwajuma Seif', 'Mwanaide Ally', 'Nachia Abdallah', 'Nahla Mohammed',
  'Najma Khamis', 'Pili Omar', 'khadija', 'Salome Festo', 'Shamimu Hassan', 'Sharifa Sharif', 'Sophia Amos', 'Teresia Kassim', 'Nehema', 'Yasinta Alfred',
  'Zawadi', 'Dorice Edward', 'Maryam Mohammed', 'Zuwena Ally', 'Christina'];
if (!state.goals.length) {
  const goals = {
    id: 'current',
    smartGoals: [
      { key: 'cleaning_level', label: 'Cleaning Level', target: 98 },
      { key: 'hygiene_standard', label: 'Hygiene Standard', target: 0 },
      { key: 'organization_supplies', label: 'Organization Supplies', target: 0 },
      { key: 'guest_interaction', label: 'Enhance Guest Interaction', target: 0 }
    ],
    hkProgress: HK_ROSTER.map((name) => ({ name }))
  };
  state.goals.push(goals);
  saveRow('goals', goals);
} else {
  // Older rows stored typed-in scores, a Public Area table and SMART rates; keep only names and targets.
  const goals = state.goals.find((entry) => entry.id === 'current');
  if (goals && (goals.paProgress || 'year' in goals || goals.hkProgress.some((row) => Object.keys(row).length > 1) || goals.smartGoals.some((row) => 'rate' in row))) {
    delete goals.paProgress;
    delete goals.year;
    goals.hkProgress = goals.hkProgress.map((row) => ({ name: row.name }));
    goals.smartGoals = goals.smartGoals.map(({ key, label, target }) => ({ key, label, target: Number(target) || 0 }));
    saveRow('goals', goals);
    console.log('Goals: switched to scores calculated from reports (removed typed-in scores and the Public Area table).');
  }
}

// Goals count reports from this financial year only, so the point targets reset each year.
const GOAL_PERIOD = { start: '2026-10-01', end: '2027-09-30' };
const POINTS_TARGETS = { supervisor: 500, hk: 150, deadline: GOAL_PERIOD.end, periodStart: GOAL_PERIOD.start };
const inGoalPeriod = (report) => !report.voided && String(report.date) >= GOAL_PERIOD.start && String(report.date) <= GOAL_PERIOD.end;
const HK_POINT_TYPES = ['quality', 'neglected', 'trolley_pantry'];
const sum = (values) => values.reduce((total, value) => total + value, 0);
const nameKey = (name) => String(name || '').trim().toLowerCase();

// Supervisor points: every room total (out of 50) from Inspection Rate Program reports about them, plus a cumulative history.
function supervisorPoints() {
  const reports = state.reports.filter((report) => report.type === 'inspection_rate' && inGoalPeriod(report))
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
    if (!inGoalPeriod(report) || !HK_POINT_TYPES.includes(report.type)) continue;
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

// Housekeeping progress columns, each an average of 1-10 scores from supervisor reports:
// cleaning = Quality room average + Neglected "Cleaning"; hygiene = Quality bathroom items + Neglected "Hygiene";
// guestInteraction = latest Guest Interaction Check (average of its three criteria); cleaningTime = the Quality Checklist box;
// trolleyPantry = Trolley / Pantry lines.
const BATHROOM_ITEMS = ['Shower', 'Toilet / WC', 'Counter / sink', 'Towel holder', 'Mirror / glass'];
const HK_REVIEW_ITEMS = ['Guest interaction', 'Cleaning time'];
const PROGRESS_COLUMNS = ['cleaning', 'hygiene', 'guestInteraction', 'cleaningTime', 'trolleyPantry'];
const SMART_SOURCES = { cleaning_level: 'cleaning', hygiene_standard: 'hygiene', organization_supplies: 'trolleyPantry' };
const INTERACTION_ITEMS = ['English level', 'Guest approaching', 'Introduction'];
// "Guest-ready" for the SMART goal: the latest check scores 8+ on all three criteria.
const GUEST_READY = 8;
const average = (values) => (values.length ? sum(values) / values.length : null);
const round1 = (value) => (value === null ? null : Number(value.toFixed(1)));
function itemScore(entry, key) {
  const value = entry.scores?.[key];
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const itemScores = (entry, keys) => keys.map((key) => itemScore(entry, key)).filter((value) => value !== null);

function progressValues(report, entry) {
  if (report.type === 'quality') {
    const roomItems = Object.keys(entry.scores || {}).filter((key) => !HK_REVIEW_ITEMS.includes(key));
    return { cleaning: average(itemScores(entry, roomItems)), hygiene: average(itemScores(entry, BATHROOM_ITEMS)), cleaningTime: itemScore(entry, 'Cleaning time') };
  }
  if (report.type === 'neglected') return { cleaning: itemScore(entry, 'Cleaning'), hygiene: itemScore(entry, 'Hygiene') };
  if (report.type === 'trolley_pantry') return { trolleyPantry: average(scoreValues(entry)) };
  return {};
}

// Collects every column value this financial year, per housekeeper (by name) and for the whole team.
function progressTotals() {
  const people = new Map();
  const team = Object.fromEntries(PROGRESS_COLUMNS.map((column) => [column, []]));
  for (const report of state.reports) {
    if (!HK_POINT_TYPES.includes(report.type) || !inGoalPeriod(report)) continue;
    for (const entry of scoredEntries(report)) {
      for (const [column, value] of Object.entries(progressValues(report, entry))) {
        if (value === null || value === undefined) continue;
        team[column].push(value);
        if (!entry.hkName) continue;
        const person = people.get(nameKey(entry.hkName)) || {};
        (person[column] ||= []).push(value);
        people.set(nameKey(entry.hkName), person);
      }
    }
  }
  return { people, team };
}

// Skills improve, so the most recent Guest Interaction Check is the housekeeper's current level.
function latestInteractionChecks() {
  const latest = new Map();
  const reports = state.reports.filter((report) => report.type === 'guest_interaction' && inGoalPeriod(report))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const report of reports) {
    for (const entry of scoredEntries(report)) {
      const scores = Object.fromEntries(INTERACTION_ITEMS.map((item) => [item, itemScore(entry, item)]));
      const values = Object.values(scores).filter((value) => value !== null);
      if (!entry.hkName || !values.length) continue;
      const key = nameKey(entry.hkName);
      latest.set(key, { date: report.date, scores, average: average(values), ready: values.length === INTERACTION_ITEMS.length && values.every((value) => value >= GUEST_READY), checks: (latest.get(key)?.checks || 0) + 1 });
    }
  }
  return latest;
}

function goalsResponse() {
  const goals = state.goals.find((entry) => entry.id === 'current');
  const { people, team } = progressTotals();
  const interaction = latestInteractionChecks();
  const hkProgress = goals.hkProgress.map(({ name }) => {
    const person = people.get(nameKey(name)) || {};
    const check = interaction.get(nameKey(name));
    const scores = Object.fromEntries(PROGRESS_COLUMNS.map((column) => [column, round1(average(person[column] || []))]));
    const counts = Object.fromEntries(PROGRESS_COLUMNS.map((column) => [column, (person[column] || []).length]));
    scores.guestInteraction = check ? round1(check.average) : null;
    counts.guestInteraction = check?.checks || 0;
    return { name, scores, counts, interaction: check ? { date: check.date, scores: check.scores, ready: check.ready } : null };
  });
  const ready = hkProgress.filter((row) => row.interaction?.ready).length;
  const checked = hkProgress.filter((row) => row.interaction).length;
  // SMART rate = the team's average score in that area, as a percentage (8.6/10 -> 86%).
  const smartGoals = goals.smartGoals.map((goal) => {
    if (goal.key === 'guest_interaction') {
      // Share of the whole roster that is guest-ready; anyone never checked counts as not yet.
      return { ...goal, rate: hkProgress.length ? Math.round(ready / hkProgress.length * 100) : 0, samples: hkProgress.length, detail: `${ready} of ${hkProgress.length} HK guest-ready (all three 8+) · ${checked} checked` };
    }
    const values = team[SMART_SOURCES[goal.key]] || [];
    return { ...goal, rate: values.length ? Math.round(average(values) * 10) : 0, samples: values.length };
  });
  return {
    id: goals.id, updatedAt: goals.updatedAt, updatedBy: goals.updatedBy,
    year: `${GOAL_PERIOD.start.slice(0, 4)}/${GOAL_PERIOD.end.slice(2, 4)}`,
    targets: POINTS_TARGETS, smartGoals, hkProgress,
    supervisorPoints: supervisorPoints(), hkPoints: hkPoints(goals.hkProgress)
  };
}

const percent = (value) => Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
const cleanName = (value) => String(value || '').trim().slice(0, 80);
// Only what managers may set: SMART targets (only for goals that already exist) and roster names.
const GOALS_SHAPE = {
  smartGoals: (rows, goals) => goals.smartGoals.map((goal) => ({ ...goal, target: percent(rows.find((row) => row?.key === goal.key)?.target ?? goal.target) })),
  hkProgress: (rows) => rows.map((row) => ({ name: cleanName(row.name) }))
};

// ---------- Housekeeper profiles ----------
// Strength = item averaging 8+, weakness = under 7, each only once scored at least 3 times (user's choice, 2026-10-04).
const PROFILE_MIN_SCORES = 3;
const STRENGTH_AT = 8;
const WEAKNESS_BELOW = 7;
const PROFILE_GROUPS = ['Room quality', 'Neglected areas', 'Trolley', 'Pantry', 'Guest interaction'];
const TYPE_LABELS = { quality: 'Quality Checklist', neglected: 'Neglected Area', trolley_pantry: 'Trolley / Pantry', guest_interaction: 'Guest Interaction Check' };
const inProfilePeriod = (report, period) => (period === 'all' ? !report.voided : inGoalPeriod(report));

// Every scored line about a housekeeper, labelled so items from different report types never mix.
function profileLines(report) {
  const list = (key) => reportLines(report, key);
  switch (report.type) {
    case 'quality': return list('entries').map((entry) => ({ entry, group: 'Room quality', prefix: '', place: entry.room ? `Room ${entry.room}` : '' }));
    case 'neglected': return list('entries').map((entry) => ({ entry, group: 'Neglected areas', prefix: 'Neglected: ', place: entry.room || report.data?.area || '' }));
    case 'trolley_pantry': return [
      ...list('trolleys').map((entry) => ({ entry, group: 'Trolley', prefix: 'Trolley: ', place: entry.block ? `Block ${entry.block}` : 'Trolley' })),
      ...list('pantries').map((entry) => ({ entry, group: 'Pantry', prefix: 'Pantry: ', place: entry.block ? `Block ${entry.block}` : 'Pantry' }))
    ];
    case 'guest_interaction': return list('entries').map((entry) => ({ entry, group: 'Guest interaction', prefix: '', place: '' }));
    default: return [];
  }
}

// One pass over the reports: per-person items, rooms and guest checks, plus team values per item.
function buildProfiles(period) {
  const people = new Map();
  const team = new Map();
  const reports = state.reports.filter((report) => TYPE_LABELS[report.type] && inProfilePeriod(report, period))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const report of reports) {
    for (const line of profileLines(report)) {
      const scored = Object.keys(line.entry?.scores || {}).map((key) => [line.prefix + key, itemScore(line.entry, key)]).filter(([, value]) => value !== null);
      for (const [label, value] of scored) {
        if (!team.has(label)) team.set(label, []);
        team.get(label).push(value);
      }
      if (!line.entry?.hkName || !scored.length) continue;
      const key = nameKey(line.entry.hkName);
      const person = people.get(key) || { items: new Map(), rooms: [], checks: [] };
      for (const [label, value] of scored) {
        const item = person.items.get(label) || { label, group: line.group, values: [] };
        item.values.push(value);
        person.items.set(label, item);
      }
      const lineAverage = round1(average(scored.map(([, value]) => value)));
      if (report.type === 'guest_interaction') {
        person.checks.push({ date: report.date, scores: Object.fromEntries(INTERACTION_ITEMS.map((item) => [item, itemScore(line.entry, item)])), average: lineAverage, note: line.entry.remarks || '' });
      } else {
        person.rooms.push({ reportId: report.id, date: report.date, type: TYPE_LABELS[report.type], place: line.place, average: lineAverage, remarks: line.entry.remarks || '' });
      }
      people.set(key, person);
    }
  }
  return { people, team };
}

function profileFor(name, { people, team }) {
  const person = people.get(nameKey(name)) || { items: new Map(), rooms: [], checks: [] };
  const items = [...person.items.values()].map((item) => ({ label: item.label, group: item.group, average: round1(average(item.values)), count: item.values.length, team: round1(average(team.get(item.label) || [])) }))
    .sort((a, b) => PROFILE_GROUPS.indexOf(a.group) - PROFILE_GROUPS.indexOf(b.group) || a.average - b.average);
  const rated = items.filter((item) => item.count >= PROFILE_MIN_SCORES);
  const months = new Map();
  for (const room of person.rooms) {
    const month = String(room.date).slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(room.average);
  }
  return {
    name,
    rooms: person.rooms.length,
    average: round1(average(person.rooms.map((room) => room.average))),
    lastInspected: person.rooms.at(-1)?.date || null,
    strengths: rated.filter((item) => item.average >= STRENGTH_AT).sort((a, b) => b.average - a.average || b.count - a.count).slice(0, 3),
    weaknesses: rated.filter((item) => item.average < WEAKNESS_BELOW).sort((a, b) => a.average - b.average || b.count - a.count).slice(0, 3),
    items,
    trend: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, values]) => ({ month, average: round1(average(values)), rooms: values.length })),
    flagged: person.rooms.filter((room) => room.average < 6 || room.remarks).reverse().slice(0, 10),
    checks: [...person.checks].reverse().slice(0, 10)
  };
}

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
  const list = (key) => reportLines(report, key);
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
    return average < threshold || entry.status === 'Broken' || (report.type !== 'guest_interaction' && Boolean(entry.remarks));
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
  if (!isPlainObject(data)) return {};
  const strip = (entries) => Array.isArray(entries) ? entries.filter(isPlainObject).map(({ photo, ...entry }) => ({ ...entry, hasPhoto: Boolean(photo) })) : entries;
  return { ...data, entries: strip(data.entries), trolleys: strip(data.trolleys), pantries: strip(data.pantries) };
}

function attachmentView(id) {
  const attachment = state.attachments.find((entry) => entry.id === id);
  return attachment ? { id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size, kind: attachment.kind, duration: attachment.duration || null } : null;
}

function buildMessageEntry(message) {
  const deleted = Boolean(message.deletedAt);
  const replied = message.replyTo ? state.messages.find((entry) => entry.id === message.replyTo) : null;
  return {
    id: message.id,
    senderId: message.senderId,
    receiverId: message.receiverId,
    text: deleted ? '' : message.text,
    createdAt: message.createdAt,
    read: Boolean(message.read),
    editedAt: message.editedAt || null,
    deleted,
    attachments: deleted ? [] : (message.attachments || []).map(attachmentView).filter(Boolean),
    forwardedFrom: deleted ? null : message.forwardedFrom || null,
    replyTo: !deleted && replied ? {
      id: replied.id,
      senderId: replied.senderId,
      deleted: Boolean(replied.deletedAt),
      text: replied.deletedAt ? '' : String(replied.text || '').slice(0, 160),
      attachmentKind: !replied.deletedAt && replied.attachments?.length ? attachmentView(replied.attachments[0])?.kind || null : null,
      shareKind: !replied.deletedAt ? replied.share?.kind || null : null
    } : null,
    reactions: deleted ? {} : message.reactions || {},
    share: deleted ? null : shareView(message.share)
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

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
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
  if (typeof token !== 'string' || !token || typeof password !== 'string' || password.length < 8) {
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
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
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
  if (typeof name !== 'string' || typeof email !== 'string' || !name.trim() || !email.trim() || !password || !allowedRoles.includes(role)) {
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
  const discussions = discussionIndex(req.user.id);
  const reports = state.reports
    .filter((report) => !report.voided)
    .filter((report) => ['manager', 'assistant_manager'].includes(viewer?.role) || report.submittedBy === req.user.id)
    .map((report) => ({
      ...report,
      data: withoutPhotos(report.data),
      submitter: sanitizeUser(state.users.find((user) => user.id === report.submittedBy) || {}),
      ...reportSummary(report),
      discussion: discussions.get(`report:${report.id}`) || null
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ reports });
});

// Full report including photos; the list endpoint above leaves photos out to keep it small.
app.get('/api/reports/:id', authMiddleware, (req, res) => {
  const viewer = currentUser(req);
  const report = state.reports.find((entry) => entry.id === req.params.id && !entry.voided);
  if (!canSeeReport(viewer, report)) return res.status(404).json({ message: 'Report not found.' });
  return res.json({ report: { ...report, submitter: sanitizeUser(state.users.find((user) => user.id === report.submittedBy) || {}), ...reportSummary(report), threshold: FLAG_THRESHOLDS[report.type] ?? 6, discussion: discussionIndex(req.user.id).get(`report:${report.id}`) || null, canManage: isManagerRole(viewer) } });
});

app.post('/api/reports', authMiddleware, (req, res) => {
  const { type, date, data } = req.body || {};
  if (!type || !date || !data) return res.status(400).json({ message: 'Report type, date and data are required.' });
  const problem = reportProblem(date, data);
  if (problem) return res.status(400).json({ message: problem });
  const submitter = currentUser(req);
  if (!roleReportTypes[submitter?.role]?.includes(type)) {
    return res.status(403).json({ message: 'Your role cannot submit this report type.' });
  }
  if (type === 'guest_interaction' && (!Array.isArray(data.entries) || !data.entries.length || data.entries.some((entry) => !String(entry?.hkName || '').trim()))) {
    return res.status(400).json({ message: 'Add the housekeeper being assessed.' });
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
  const summary = reportSummary(report);
  const label = REPORT_LABELS[report.type] || 'Report';
  const place = data.area || data.block || data.vehicleId || '';
  if (summary.flagged) {
    for (const manager of state.users.filter((user) => isManagerRole(user) && user.active !== false)) {
      notify(manager.id, { type: 'report_flagged', fromUserId: req.user.id, title: `Needs attention · ${label}`, body: `${submitter.name}${summary.flaggedCount ? ` · ${summary.flaggedCount} flagged` : ''}${place ? ` · ${place}` : ''}`, link: { page: 'report', id: report.id } });
    }
  }
  if (report.type === 'inspection_rate' && data.supervisorId) {
    notify(data.supervisorId, { type: 'inspected', fromUserId: req.user.id, title: 'You were inspected', body: `${submitter.name} · ${summary.itemCount} room${summary.itemCount === 1 ? '' : 's'}${place ? ` · ${place}` : ''} · average ${summary.average}/10`, link: { page: 'report', id: report.id } });
  }
  return res.status(201).json({ report: { ...report, data: withoutPhotos(report.data), ...summary } });
});

// Reject malformed reports before they are stored: one bad row would otherwise break the report and goals pages for everyone.
const REPORT_LINE_LIMIT = 200;
const REPORT_BACKDATE_DAYS = 7;
// YYYY-MM-DD in the hotel's time zone, offset by whole days.
const dateInAppZone = (offsetDays) => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * 86400000));
function reportProblem(date, data) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return 'Choose a valid report date.';
  // Up to a week back for late paperwork, never ahead (one day of slack for phones on another clock), so points can't be stockpiled.
  // ALLOW_ANY_REPORT_DATE=1 switches this off, e.g. while importing old paper reports or in automated tests.
  const today = dateInAppZone(0);
  if (!process.env.ALLOW_ANY_REPORT_DATE && date > dateInAppZone(1)) return 'A report cannot be dated in the future.';
  if (!process.env.ALLOW_ANY_REPORT_DATE && date < dateInAppZone(-REPORT_BACKDATE_DAYS)) return `Reports can only be dated up to ${REPORT_BACKDATE_DAYS} days back (earliest ${dateInAppZone(-REPORT_BACKDATE_DAYS)}, today is ${today}).`;
  if (!isPlainObject(data)) return 'The report is missing its details.';
  for (const key of ['entries', 'trolleys', 'pantries']) {
    const lines = data[key];
    if (lines === undefined) continue;
    if (!Array.isArray(lines)) return 'Some lines in this report are not valid. Reload the page and try again.';
    if (lines.length > REPORT_LINE_LIMIT) return `A report can have at most ${REPORT_LINE_LIMIT} lines.`;
    if (lines.some((line) => !isPlainObject(line) || (line.scores !== undefined && !isPlainObject(line.scores)))) return 'Some lines in this report are not valid. Reload the page and try again.';
  }
  if (data.vehicle !== undefined && !isPlainObject(data.vehicle)) return 'The vehicle checklist is not valid.';
  return null;
}

const profilePeriod = (req) => (req.query.period === 'all' ? 'all' : 'year');
const currentRoster = () => state.goals.find((entry) => entry.id === 'current').hkProgress;

// Names only, for the "HK name" suggestions on report forms (supervisors fill those but can't open Goals).
app.get('/api/hk-roster', authMiddleware, (req, res) => {
  return res.json({ names: currentRoster().map((row) => row.name) });
});

app.get('/api/hk-profiles', authMiddleware, requireManager, (req, res) => {
  const period = profilePeriod(req);
  const built = buildProfiles(period);
  const profiles = currentRoster().map(({ name }) => {
    const profile = profileFor(name, built);
    return { name, rooms: profile.rooms, average: profile.average, lastInspected: profile.lastInspected, strength: profile.strengths[0] || null, weakness: profile.weaknesses[0] || null };
  });
  return res.json({ period, profiles, rules: { minScores: PROFILE_MIN_SCORES, strengthAt: STRENGTH_AT, weaknessBelow: WEAKNESS_BELOW } });
});

app.get('/api/hk-profiles/:name', authMiddleware, requireManager, (req, res) => {
  const period = profilePeriod(req);
  const name = String(req.params.name || '').trim();
  const goals = goalsResponse();
  const progress = goals.hkProgress.find((row) => nameKey(row.name) === nameKey(name));
  const points = goals.hkPoints.find((row) => nameKey(row.name) === nameKey(name));
  return res.json({
    period,
    profile: { ...profileFor(name, buildProfiles(period)), onRoster: Boolean(progress), progress: progress?.scores || null, interaction: progress?.interaction || null, points: { points: points?.points || 0, target: POINTS_TARGETS.hk, deadline: POINTS_TARGETS.deadline } },
    rules: { minScores: PROFILE_MIN_SCORES, strengthAt: STRENGTH_AT, weaknessBelow: WEAKNESS_BELOW }
  });
});

app.get('/api/goals', authMiddleware, requireManager, (req, res) => {
  return res.json({ goals: goalsResponse() });
});

// Saves SMART targets and roster names only; every score is calculated on read.
app.put('/api/goals', authMiddleware, requireManager, (req, res) => {
  const goals = state.goals.find((entry) => entry.id === 'current');
  for (const [section, clean] of Object.entries(GOALS_SHAPE)) {
    if (req.body?.[section] === undefined) continue;
    if (!Array.isArray(req.body[section])) return res.status(400).json({ message: `${section} must be a list.` });
    if (section !== 'smartGoals') {
      const names = req.body[section].map((row) => cleanName(row?.name));
      if (names.some((name) => !name)) return res.status(400).json({ message: 'Every person needs a name.' });
      const repeated = names.find((name, index) => names.findIndex((other) => nameKey(other) === nameKey(name)) !== index);
      if (repeated) return res.status(400).json({ message: `"${repeated}" is listed twice.` });
    }
    goals[section] = clean(req.body[section], goals);
  }
  // Renaming someone on the roster can also rename them in past reports, so their history stays in one profile.
  let renamedLines = 0;
  const renames = Array.isArray(req.body?.renames) ? req.body.renames.slice(0, 50) : [];
  for (const rename of renames) {
    const fromKey = nameKey(rename?.from);
    const to = cleanName(rename?.to);
    if (!fromKey || !to || fromKey === nameKey(to) || !goals.hkProgress.some((row) => nameKey(row.name) === nameKey(to))) continue;
    for (const report of state.reports) {
      let changed = false;
      for (const list of ['entries', 'trolleys', 'pantries']) {
        for (const entry of Array.isArray(report.data?.[list]) ? report.data[list] : []) {
          if (entry && nameKey(entry.hkName) === fromKey) {
            entry.hkName = to;
            changed = true;
            renamedLines += 1;
          }
        }
      }
      if (changed) {
        report.updatedAt = new Date().toISOString();
        saveRow('reports', report);
      }
    }
  }
  goals.updatedAt = new Date().toISOString();
  goals.updatedBy = req.currentUser.name;
  saveRow('goals', goals);
  return res.json({ goals: goalsResponse(), renamedLines });
});

app.post('/api/reports/:id/sign', authMiddleware, requireManager, (req, res) => {
  const report = state.reports.find((entry) => entry.id === req.params.id);
  if (!report) return res.status(404).json({ message: 'Report not found.' });
  const firstSignature = !report.hodSignedAt;
  report.hodSignature = req.currentUser.name;
  report.hodSignedAt = new Date().toISOString();
  report.updatedAt = new Date().toISOString();
  saveRow('reports', report);
  if (firstSignature) notify(report.submittedBy, { type: 'report_signed', fromUserId: req.user.id, title: `${REPORT_LABELS[report.type] || 'Report'} signed off`, body: `by ${req.currentUser.name} · ${report.date}`, link: { page: 'report', id: report.id } });
  return res.json({ report: { ...report, data: withoutPhotos(report.data) } });
});

app.get('/api/tasks', authMiddleware, (req, res) => {
  const discussions = discussionIndex(req.user.id);
  const tasks = state.tasks.filter((task) => task.assignedTo === req.user.id || ['manager', 'assistant_manager'].includes(state.users.find((user) => user.id === req.user.id)?.role))
    .map((task) => ({ ...task, discussion: discussions.get(`task:${task.id}`) || null }));
  return res.json({ tasks });
});

app.get('/api/tasks/:id', authMiddleware, (req, res) => {
  const viewer = currentUser(req);
  const task = state.tasks.find((entry) => entry.id === req.params.id);
  if (!canSeeTask(viewer, task)) return res.status(404).json({ message: 'Task not found.' });
  const nameOf = (id) => state.users.find((user) => user.id === id)?.name || null;
  return res.json({ task: { ...task, assigneeName: nameOf(task.assignedTo), assignedByName: nameOf(task.assignedBy), discussion: discussionIndex(req.user.id).get(`task:${task.id}`) || null, canUpdate: isManagerRole(viewer) || task.assignedTo === req.user.id } });
});

app.post('/api/tasks', authMiddleware, requireManager, (req, res) => {
  const { title, location, assignedTo, priority = 'medium', dueDate } = req.body || {};
  if (!title || !location) return res.status(400).json({ message: 'Task title and location are required.' });
  const task = { id: randomUUID(), title, location, assignedTo: assignedTo || null, assignedBy: req.user.id, priority, dueDate: dueDate || null, status: 'pending', createdAt: new Date().toISOString() };
  state.tasks.push(task);
  saveRow('tasks', task);
  if (task.assignedTo) notify(task.assignedTo, { type: 'task', fromUserId: req.user.id, urgent: task.priority === 'urgent', title: task.priority === 'urgent' ? 'New urgent task' : 'New task', body: `${task.title} · ${task.location}${task.dueDate ? ` · due ${task.dueDate}` : ''}`, link: { page: 'task', id: task.id } });
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
  const previous = task.status;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  task.completedAt = status === 'completed' ? task.updatedAt : null;
  saveRow('tasks', task);
  if (previous !== status) {
    const actor = userName(req.user.id);
    const link = { page: 'task', id: task.id };
    // The assignee's progress goes to whoever created the task; a manager's change goes to the assignee.
    if (req.user.id === task.assignedTo) {
      notify(task.assignedBy, { type: 'task', fromUserId: req.user.id, title: `${actor} ${{ completed: 'completed', in_progress: 'started', pending: 'moved back to pending' }[status]}`, body: task.title, link });
    } else if (task.assignedTo) {
      notify(task.assignedTo, { type: 'task', fromUserId: req.user.id, title: previous === 'completed' ? 'Task reopened' : status === 'completed' ? 'Task marked completed' : status === 'in_progress' ? 'Task in progress' : 'Task moved back to pending', body: `${task.title} · by ${actor}`, link });
    }
  }
  return res.json({ task });
});

// ---------- Chat attachments ----------
// Files live on the data volume; only the uploader and the people in a conversation that contains the file can open it.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_KINDS = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'application/pdf': 'file', 'application/msword': 'file', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file',
  'application/vnd.ms-excel': 'file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'file', 'text/plain': 'file', 'text/csv': 'file',
  'audio/webm': 'voice', 'audio/ogg': 'voice', 'audio/mp4': 'voice', 'audio/mpeg': 'voice', 'audio/aac': 'voice'
};
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const uploadPath = (id) => path.join(UPLOAD_DIR, id);
const inMessage = (message, userId) => message.senderId === userId || message.receiverId === userId;
const messagesUsing = (attachmentId) => state.messages.filter((message) => !message.deletedAt && message.attachments?.includes(attachmentId));

function canOpenAttachment(attachment, userId) {
  return attachment.ownerId === userId || messagesUsing(attachment.id).some((message) => inMessage(message, userId));
}

function removeAttachment(attachment) {
  fs.rmSync(uploadPath(attachment.id), { force: true });
  state.attachments = state.attachments.filter((entry) => entry.id !== attachment.id);
  deleteRow('attachments', attachment.id);
}

// Uploads that were never sent are removed after a day.
function removeAbandonedUploads() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const attachment of [...state.attachments]) {
    if (new Date(attachment.createdAt).getTime() < cutoff && !messagesUsing(attachment.id).length) removeAttachment(attachment);
  }
}
removeAbandonedUploads();
setInterval(removeAbandonedUploads, 6 * 60 * 60 * 1000).unref();

app.post('/api/attachments', authMiddleware, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const kind = ATTACHMENT_KINDS[type];
  if (!kind) return res.status(400).json({ message: 'Only photos, PDF, Word, Excel, text files and voice notes can be attached.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ message: 'The file is empty.' });
  const rawName = (() => { try { return decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { return ''; } })();
  const attachment = {
    id: randomUUID(),
    ownerId: req.user.id,
    name: rawName.replace(/[\\/\r\n"]/g, '_').slice(0, 120) || (kind === 'voice' ? 'Voice message' : 'Attachment'),
    type,
    size: req.body.length,
    kind,
    duration: kind === 'voice' ? Math.min(600, Math.max(0, Math.round(Number(req.headers['x-duration']) || 0))) : null,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(uploadPath(attachment.id), req.body);
  state.attachments.push(attachment);
  saveRow('attachments', attachment);
  return res.status(201).json({ attachment: attachmentView(attachment.id) });
});

app.get('/api/attachments/:id', authMiddleware, (req, res) => {
  const attachment = state.attachments.find((entry) => entry.id === req.params.id);
  if (!attachment || !canOpenAttachment(attachment, req.user.id) || !fs.existsSync(uploadPath(attachment.id))) {
    return res.status(404).json({ message: 'Attachment not found.' });
  }
  res.set({
    'Content-Type': attachment.type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${attachment.kind === 'file' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`
  });
  return res.sendFile(uploadPath(attachment.id));
});

function emitMessage(event, message) {
  const payload = buildMessageEntry(message);
  io.to(message.receiverId).emit(event, payload);
  io.to(message.senderId).emit(event, payload);
  return payload;
}

function ownMessage(req, res) {
  const message = state.messages.find((entry) => entry.id === req.params.id);
  if (!message || message.senderId !== req.user.id) {
    res.status(404).json({ message: 'Message not found.' });
    return null;
  }
  if (message.deletedAt) {
    res.status(400).json({ message: 'This message was deleted.' });
    return null;
  }
  return message;
}

// ---------- Sharing reports and tasks in chat ----------
// You can open a report or task if it's yours, if you're a manager, or if someone shared it with you in a conversation.
const isManagerRole = (user) => ['manager', 'assistant_manager'].includes(user?.role);
const sharedWith = (kind, id, userId) => state.messages.some((message) => !message.deletedAt && message.share?.kind === kind && message.share.id === id && inMessage(message, userId));
function canSeeReport(user, report) {
  return Boolean(user && report && !report.voided && (isManagerRole(user) || report.submittedBy === user.id || report.data?.supervisorId === user.id || sharedWith('report', report.id, user.id)));
}
function canSeeTask(user, task) {
  return Boolean(user && task && (isManagerRole(user) || task.assignedTo === user.id || sharedWith('task', task.id, user.id)));
}
const LINE_LISTS = ['entries', 'trolleys', 'pantries'];

function lineLabel(report, list, entry, index) {
  if (list === 'trolleys') return entry.block ? `Trolley · Block ${entry.block}` : `Trolley ${index + 1}`;
  if (list === 'pantries') return entry.block ? `Pantry · Block ${entry.block}` : `Pantry ${index + 1}`;
  if (report.type === 'tools') return entry.tool || `Tool ${index + 1}`;
  if (report.type === 'guest_interaction') return entry.hkName || `Housekeeper ${index + 1}`;
  return entry.room ? `Room ${entry.room}` : `Line ${index + 1}`;
}

// What a chat card shows: always the item's current state, not a copy from when it was shared.
function shareView(share) {
  if (!share) return null;
  if (share.kind === 'report') {
    const report = state.reports.find((entry) => entry.id === share.id && !entry.voided);
    if (!report) return { kind: 'report', id: share.id, missing: true };
    const summary = reportSummary(report);
    let line = null;
    const entry = share.line ? report.data?.[share.line.list]?.[share.line.index] : null;
    if (entry) {
      const threshold = FLAG_THRESHOLDS[report.type] ?? 6;
      const scores = Object.keys(entry.scores || {}).map((key) => [key, itemScore(entry, key)]).filter(([, value]) => value !== null);
      line = { ...share.line, label: lineLabel(report, share.line.list, entry, share.line.index), hkName: entry.hkName || null, low: scores.filter(([, value]) => value < threshold).map(([key, value]) => `${key} ${value}`), remarks: entry.remarks || '' };
    }
    return {
      kind: 'report', id: report.id, type: report.type, date: report.date,
      submitterName: state.users.find((user) => user.id === report.submittedBy)?.name || 'Unknown',
      place: report.data?.area || report.data?.block || report.data?.vehicleId || '',
      supervisorName: report.data?.supervisorName || null,
      flagged: summary.flagged, itemCount: summary.itemCount, flaggedCount: summary.flaggedCount, signed: Boolean(report.hodSignedAt), line
    };
  }
  if (share.kind === 'task') {
    const task = state.tasks.find((entry) => entry.id === share.id);
    if (!task) return { kind: 'task', id: share.id, missing: true };
    return { kind: 'task', id: task.id, title: task.title, location: task.location, status: task.status, priority: task.priority, dueDate: task.dueDate, assigneeName: state.users.find((user) => user.id === task.assignedTo)?.name || null };
  }
  return null;
}

// For the 💬 marker: conversations *you* took part in that shared each report or task.
function discussionIndex(userId) {
  const index = new Map();
  for (const message of state.messages) {
    if (message.deletedAt || !message.share || !inMessage(message, userId)) continue;
    const key = `${message.share.kind}:${message.share.id}`;
    const entry = index.get(key) || { count: 0, lastAt: '', withUserId: null, sharedBy: null, sharedAt: '' };
    entry.count += 1;
    // The latest person who sent *you* this item: the natural person to ask back.
    if (message.receiverId === userId && String(message.createdAt) > entry.sharedAt) {
      entry.sharedAt = String(message.createdAt);
      entry.sharedBy = message.senderId;
    }
    if (String(message.createdAt) > entry.lastAt) {
      entry.lastAt = String(message.createdAt);
      entry.withUserId = message.senderId === userId ? message.receiverId : message.senderId;
    }
    index.set(key, entry);
  }
  return index;
}

// ---------- Notifications ----------
// Every alert is stored (for the 🔔 list) and pushed to the person's devices unless they have the app open on screen,
// it's their quiet hours (urgent tasks still come through), or they turned that kind of alert off.
const NOTIFY_CATEGORY = { message: 'messages', question: 'questions', task: 'tasks', report_signed: 'reportSigned', report_flagged: 'reportFlagged', inspected: 'inspected', reaction: 'reactions' };
const DEFAULT_NOTIFY = {
  categories: { messages: true, questions: true, tasks: true, reportSigned: true, reportFlagged: true, inspected: true, reactions: false },
  quietHours: { enabled: true, start: '22:00', end: '06:00' },
  preview: true,
  sound: true
};
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Africa/Dar_es_Salaam';
const REPORT_LABELS = { neglected: 'Neglected Area', quality: 'Quality Checklist', trolley_pantry: 'Trolley / Pantry', handover: 'Shift Handover', vehicle: 'Vehicle Checklist', tools: 'Tools Control', inspection_rate: 'Inspection Rate Program', guest_interaction: 'Guest Interaction Check' };
const NOTIFICATION_DAYS = 60;

function notifySettings(user) {
  const saved = user?.notify || {};
  return { ...DEFAULT_NOTIFY, ...saved, categories: { ...DEFAULT_NOTIFY.categories, ...(saved.categories || {}) }, quietHours: { ...DEFAULT_NOTIFY.quietHours, ...(saved.quietHours || {}) } };
}

// Push keys are made on first start and kept in the database (env vars override), so there's nothing to configure.
function vapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  let row = state.settings.find((entry) => entry.id === 'vapid');
  if (!row) {
    row = { id: 'vapid', ...webpush.generateVAPIDKeys(), createdAt: new Date().toISOString() };
    state.settings.push(row);
    saveRow('settings', row);
  }
  return { publicKey: row.publicKey, privateKey: row.privateKey };
}
const VAPID = vapidKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || (APP_URL.startsWith('https://') ? APP_URL : 'mailto:hk-sync@example.com'), VAPID.publicKey, VAPID.privateKey);

// The app tells the server whether it's on screen and which chat is open.
const openSockets = (userId) => [...(onlineUsers.get(userId) || [])].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
const hasAppOnScreen = (userId) => openSockets(userId).some((socket) => socket.data.visible);
const isReadingChat = (userId, otherId) => openSockets(userId).some((socket) => socket.data.visible && socket.data.chatWith === otherId);

function inQuietHours(settings) {
  if (!settings.quietHours.enabled) return false;
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const { start, end } = settings.quietHours;
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

async function sendPush(userId, notification, onlyEndpoint = null) {
  const payload = JSON.stringify({ id: notification.id, title: notification.title, body: notification.body, link: notification.link, tag: notification.link ? JSON.stringify(notification.link) : notification.id });
  let delivered = 0;
  for (const subscription of state.subscriptions.filter((entry) => entry.userId === userId && (!onlyEndpoint || entry.endpoint === onlyEndpoint))) {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, { TTL: 24 * 60 * 60, urgency: notification.urgent ? 'high' : 'normal' });
      delivered += 1;
    } catch (error) {
      // 404/410 = the browser dropped this registration; forget it.
      if ([404, 410].includes(error.statusCode)) {
        state.subscriptions = state.subscriptions.filter((entry) => entry.id !== subscription.id);
        deleteRow('subscriptions', subscription.id);
      } else {
        console.error('Push failed:', error.statusCode || error.message);
      }
    }
  }
  return delivered;
}

function notify(userId, { type, title, body = '', link = null, urgent = false, fromUserId = null }) {
  const user = state.users.find((entry) => entry.id === userId && entry.active !== false);
  if (!user || userId === fromUserId) return null;
  const settings = notifySettings(user);
  if (NOTIFY_CATEGORY[type] && settings.categories[NOTIFY_CATEGORY[type]] === false) return null;
  // Nothing to tell someone who is reading that very conversation.
  if ((type === 'message' || type === 'question') && fromUserId && isReadingChat(userId, fromUserId)) return null;
  const notification = { id: randomUUID(), userId, type, title: String(title).slice(0, 120), body: String(body || '').slice(0, 240), link, urgent: Boolean(urgent), createdAt: new Date().toISOString(), readAt: null };
  state.notifications.push(notification);
  saveRow('notifications', notification);
  io.to(userId).emit('notification', notification);
  if (!hasAppOnScreen(userId) && !(inQuietHours(settings) && !urgent)) {
    const hideText = !settings.preview && (type === 'message' || type === 'question');
    sendPush(userId, hideText ? { ...notification, body: 'New message' } : notification).catch(() => {});
  }
  return notification;
}

function markNotificationsRead(userId, matches) {
  const now = new Date().toISOString();
  const ids = [];
  for (const notification of state.notifications) {
    if (notification.userId !== userId || notification.readAt || !matches(notification)) continue;
    notification.readAt = now;
    saveRow('notifications', notification);
    ids.push(notification.id);
  }
  if (ids.length) io.to(userId).emit('notifications:read', { ids });
  return ids.length;
}

function removeOldNotifications() {
  const cutoff = Date.now() - NOTIFICATION_DAYS * 24 * 60 * 60 * 1000;
  for (const notification of state.notifications.filter((entry) => new Date(entry.createdAt).getTime() < cutoff)) deleteRow('notifications', notification.id);
  state.notifications = state.notifications.filter((entry) => new Date(entry.createdAt).getTime() >= cutoff);
}
removeOldNotifications();
setInterval(removeOldNotifications, 24 * 60 * 60 * 1000).unref();

const messageSummary = (message) => message.text || (message.share ? (message.share.kind === 'task' ? '✓ Task' : '📋 Report') : '') || ({ image: '📷 Photo', file: '📎 File', voice: '🎤 Voice message' }[attachmentView(message.attachments?.[0])?.kind] || 'New message');
const userName = (id) => state.users.find((user) => user.id === id)?.name || 'Someone';
function shareTitle(share) {
  if (share.kind === 'task') return `task "${state.tasks.find((task) => task.id === share.id)?.title || ''}"`;
  const report = state.reports.find((entry) => entry.id === share.id);
  if (!report) return 'a report';
  return `${report.submittedBy === share.receiverId ? 'your' : 'the'} ${REPORT_LABELS[report.type] || 'report'}`;
}

app.get('/api/notifications', authMiddleware, (req, res) => {
  const mine = state.notifications.filter((entry) => entry.userId === req.user.id);
  return res.json({ notifications: mine.slice(-50).reverse(), unread: mine.filter((entry) => !entry.readAt).length });
});

app.post('/api/notifications/read', authMiddleware, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const count = markNotificationsRead(req.user.id, (entry) => req.body?.all || ids?.includes(entry.id));
  return res.json({ updated: count });
});

app.get('/api/push/key', authMiddleware, (req, res) => res.json({ publicKey: VAPID.publicKey }));

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const subscription = req.body?.subscription;
  const endpoint = String(subscription?.endpoint || '');
  if (!endpoint.startsWith('https://') || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ message: 'This browser did not provide a valid push registration.' });
  const id = createHash('sha256').update(endpoint).digest('hex');
  // A shared device belongs to whoever registered it last.
  const entry = { id, userId: req.user.id, endpoint, keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) }, userAgent: String(req.headers['user-agent'] || '').slice(0, 200), createdAt: new Date().toISOString() };
  state.subscriptions = [...state.subscriptions.filter((item) => item.id !== id), entry];
  saveRow('subscriptions', entry);
  return res.status(201).json({ ok: true, devices: state.subscriptions.filter((item) => item.userId === req.user.id).length });
});

app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  const id = createHash('sha256').update(String(req.body?.endpoint || '')).digest('hex');
  const found = state.subscriptions.find((item) => item.id === id && item.userId === req.user.id);
  if (found) {
    state.subscriptions = state.subscriptions.filter((item) => item.id !== id);
    deleteRow('subscriptions', id);
  }
  return res.json({ ok: true });
});

app.post('/api/push/test', authMiddleware, async (req, res) => {
  const endpoint = req.body?.endpoint || null;
  if (!state.subscriptions.some((item) => item.userId === req.user.id && (!endpoint || item.endpoint === endpoint))) return res.status(400).json({ message: 'Notifications are not turned on for this device yet.' });
  const delivered = await sendPush(req.user.id, { id: randomUUID(), title: 'HK SYNC test notification', body: 'Notifications are working on this device. 🎉', link: { page: 'account' }, urgent: true }, endpoint);
  return delivered ? res.json({ ok: true }) : res.status(502).json({ message: 'The notification could not be delivered. Try turning notifications off and on again.' });
});

app.get('/api/users/me/notify', authMiddleware, (req, res) => {
  return res.json({ settings: notifySettings(currentUser(req)), devices: state.subscriptions.filter((item) => item.userId === req.user.id).length, timezone: APP_TIMEZONE });
});

app.put('/api/users/me/notify', authMiddleware, (req, res) => {
  const user = currentUser(req);
  const body = req.body || {};
  const current = notifySettings(user);
  const time = (value, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : fallback);
  user.notify = {
    categories: Object.fromEntries(Object.keys(DEFAULT_NOTIFY.categories).map((key) => [key, typeof body.categories?.[key] === 'boolean' ? body.categories[key] : current.categories[key]])),
    quietHours: { enabled: typeof body.quietHours?.enabled === 'boolean' ? body.quietHours.enabled : current.quietHours.enabled, start: time(body.quietHours?.start, current.quietHours.start), end: time(body.quietHours?.end, current.quietHours.end) },
    preview: typeof body.preview === 'boolean' ? body.preview : current.preview,
    sound: typeof body.sound === 'boolean' ? body.sound : current.sound
  };
  saveRow('users', user);
  return res.json({ settings: notifySettings(user) });
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
  markNotificationsRead(req.user.id, (entry) => entry.link?.page === 'messages' && entry.link.userId === req.params.userId);
  if (updated) {
    io.to(req.user.id).emit('messages:read', { userId: req.params.userId });
    io.to(req.params.userId).emit('messages:seen', { by: req.user.id });
  }
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
  const { receiverId, text, replyTo, share } = req.body || {};
  const attachmentIds = Array.isArray(req.body?.attachments) ? [...new Set(req.body.attachments)].slice(0, 10) : [];

  if (!receiverId || (!String(text || '').trim() && !attachmentIds.length && !share)) {
    return res.status(400).json({ message: 'Write a message or add an attachment.' });
  }
  if (attachmentIds.some((id) => state.attachments.find((entry) => entry.id === id)?.ownerId !== req.user.id)) {
    return res.status(400).json({ message: 'One of the attachments could not be found. Try adding it again.' });
  }
  let cleanShare = null;
  if (share) {
    const viewer = currentUser(req);
    if (share.kind === 'report') {
      const report = state.reports.find((entry) => entry.id === share.id);
      if (!canSeeReport(viewer, report)) return res.status(404).json({ message: 'Report not found.' });
      cleanShare = { kind: 'report', id: report.id };
      if (share.line) {
        const index = Number(share.line.index);
        if (!LINE_LISTS.includes(share.line.list) || !Number.isInteger(index) || !report.data?.[share.line.list]?.[index]) return res.status(400).json({ message: 'That line is not in this report.' });
        cleanShare.line = { list: share.line.list, index };
      }
    } else if (share.kind === 'task') {
      const task = state.tasks.find((entry) => entry.id === share.id);
      if (!canSeeTask(viewer, task)) return res.status(404).json({ message: 'Task not found.' });
      cleanShare = { kind: 'task', id: task.id };
    } else {
      return res.status(400).json({ message: 'Only reports and tasks can be shared.' });
    }
  }
  const repliedTo = replyTo ? state.messages.find((entry) => entry.id === replyTo) : null;
  if (replyTo && (!repliedTo || !inMessage(repliedTo, req.user.id) || !inMessage(repliedTo, receiverId))) {
    return res.status(400).json({ message: 'You can only reply to a message in this conversation.' });
  }

  const receiver = state.users.find((user) => user.id === receiverId);
  if (!receiver || receiver.active === false) {
    return res.status(404).json({ message: 'Recipient user not found.' });
  }
  if (receiverId === req.user.id) {
    return res.status(400).json({ message: 'You cannot message yourself.' });
  }
  if (String(text || '').trim().length > 2000) {
    return res.status(400).json({ message: 'Messages can be at most 2000 characters.' });
  }

  const message = {
    id: randomUUID(),
    senderId: req.user.id,
    receiverId,
    text: String(text || '').trim(),
    attachments: attachmentIds,
    replyTo: repliedTo?.id || null,
    share: cleanShare,
    reactions: {},
    createdAt: new Date().toISOString(),
    read: false
  };

  state.messages.push(message);
  saveRow('messages', message);
  const sender = userName(req.user.id);
  notify(receiverId, cleanShare
    ? { type: 'question', fromUserId: req.user.id, title: `${sender} · question about ${shareTitle({ ...cleanShare, receiverId })}`, body: message.text || 'Tap to see what it is about.', link: { page: 'messages', userId: req.user.id } }
    : { type: 'message', fromUserId: req.user.id, title: sender, body: messageSummary(message), link: { page: 'messages', userId: req.user.id } });
  return res.status(201).json({ message: emitMessage('new-message', message) });
});

// Forward to one or more colleagues; the copy credits the original author.
app.post('/api/messages/forward', authMiddleware, (req, res) => {
  const original = state.messages.find((entry) => entry.id === req.body?.messageId);
  if (!original || original.deletedAt || !inMessage(original, req.user.id)) return res.status(404).json({ message: 'Message not found.' });
  const receiverIds = Array.isArray(req.body?.receiverIds) ? [...new Set(req.body.receiverIds)].slice(0, 20) : [];
  const receivers = receiverIds.map((id) => state.users.find((user) => user.id === id && user.active !== false && user.id !== req.user.id));
  if (!receivers.length || receivers.some((user) => !user)) return res.status(400).json({ message: 'Choose who to forward it to.' });
  const author = original.forwardedFrom || { senderId: original.senderId, name: state.users.find((user) => user.id === original.senderId)?.name || 'Unknown' };
  const sent = receivers.map((receiver) => {
    const message = { id: randomUUID(), senderId: req.user.id, receiverId: receiver.id, text: original.text, attachments: [...(original.attachments || [])], share: original.share || null, replyTo: null, forwardedFrom: author, reactions: {}, createdAt: new Date().toISOString(), read: false };
    state.messages.push(message);
    saveRow('messages', message);
    notify(receiver.id, { type: 'message', fromUserId: req.user.id, title: userName(req.user.id), body: `Forwarded: ${messageSummary(message)}`, link: { page: 'messages', userId: req.user.id } });
    return emitMessage('new-message', message);
  });
  return res.status(201).json({ messages: sent });
});

app.patch('/api/messages/:id', authMiddleware, (req, res) => {
  const message = ownMessage(req, res);
  if (!message) return undefined;
  const text = String(req.body?.text || '').trim();
  if (!text && !message.attachments?.length) return res.status(400).json({ message: 'A message cannot be empty.' });
  if (text.length > 2000) return res.status(400).json({ message: 'Messages can be at most 2000 characters.' });
  if (text !== message.text) {
    message.text = text;
    message.editedAt = new Date().toISOString();
    saveRow('messages', message);
  }
  return res.json({ message: emitMessage('message-updated', message) });
});

// Deleting removes the message and its files for both people (files stay if a forwarded copy still uses them).
app.delete('/api/messages/:id', authMiddleware, (req, res) => {
  const message = ownMessage(req, res);
  if (!message) return undefined;
  const attachmentIds = message.attachments || [];
  message.deletedAt = new Date().toISOString();
  message.text = '';
  message.attachments = [];
  message.reactions = {};
  delete message.forwardedFrom;
  saveRow('messages', message);
  for (const id of attachmentIds) {
    const attachment = state.attachments.find((entry) => entry.id === id);
    if (attachment && !messagesUsing(id).length) removeAttachment(attachment);
  }
  return res.json({ message: emitMessage('message-updated', message) });
});

// One reaction per person: choosing the same emoji again removes it.
app.post('/api/messages/:id/reactions', authMiddleware, (req, res) => {
  const message = state.messages.find((entry) => entry.id === req.params.id);
  if (!message || message.deletedAt || !inMessage(message, req.user.id)) return res.status(404).json({ message: 'Message not found.' });
  const emoji = req.body?.emoji;
  if (!REACTIONS.includes(emoji)) return res.status(400).json({ message: 'Unknown reaction.' });
  const reactions = message.reactions || {};
  const had = reactions[emoji]?.includes(req.user.id);
  for (const key of Object.keys(reactions)) {
    reactions[key] = reactions[key].filter((id) => id !== req.user.id);
    if (!reactions[key].length) delete reactions[key];
  }
  if (!had) reactions[emoji] = [...(reactions[emoji] || []), req.user.id];
  message.reactions = reactions;
  saveRow('messages', message);
  if (!had) notify(message.senderId, { type: 'reaction', fromUserId: req.user.id, title: `${userName(req.user.id)} reacted ${emoji}`, body: messageSummary(message), link: { page: 'messages', userId: req.user.id } });
  return res.json({ message: emitMessage('message-updated', message) });
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

  socket.data.visible = false;
  socket.data.chatWith = null;
  socket.on('client-state', (clientState) => {
    socket.data.visible = Boolean(clientState?.visible);
    socket.data.chatWith = typeof clientState?.chatWith === 'string' ? clientState.chatWith : null;
  });

  // "typing…" is relayed only to an active colleague; nothing is stored.
  socket.on('typing', (to) => {
    if (typeof to === 'string' && to !== userId && state.users.some((user) => user.id === to && user.active !== false)) io.to(to).emit('typing', { from: userId });
  });

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
