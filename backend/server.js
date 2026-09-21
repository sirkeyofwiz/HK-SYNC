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
import { createHash, randomBytes } from 'node:crypto';

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
`);
const app = express();
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
const server = app.listen(process.env.PORT || 5000, () => {
  console.log(`HK SYNC backend running on port ${process.env.PORT || 5000}`);
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

const DEFAULT_STATE = { users: [], messages: [], reports: [], tasks: [] };
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'local-development-secret';
const onlineUsers = new Map();
const roleReportTypes = {
  supervisor: ['neglected', 'quality', 'trolley_pantry', 'handover'],
  storekeeper: ['tools'],
  driver: ['vehicle'],
  manager: ['neglected', 'quality', 'trolley_pantry', 'handover', 'vehicle', 'tools'],
  assistant_manager: ['neglected', 'quality', 'trolley_pantry', 'handover', 'vehicle', 'tools']
};

function readState() {
  const tableCounts = ['users', 'messages', 'reports', 'tasks'].map((table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  if (tableCounts.every((count) => count === 0) && fs.existsSync(dataFilePath)) {
    const legacyState = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
    const importState = database.transaction(() => {
      for (const [table, rows] of Object.entries(legacyState)) {
        if (!['users', 'messages', 'reports', 'tasks'].includes(table) || !Array.isArray(rows)) continue;
        const insert = database.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`);
        rows.forEach((row) => insert.run(row.id, JSON.stringify(row)));
      }
    });
    importState();
  }
  const load = (table) => database.prepare(`SELECT data FROM ${table}`).all().map((row) => JSON.parse(row.data));
  return { users: load('users'), messages: load('messages'), reports: load('reports'), tasks: load('tasks') };
}

let state = readState();

function saveState() {
  const persist = database.transaction(() => {
    for (const table of ['users', 'messages', 'reports', 'tasks']) {
      database.prepare(`DELETE FROM ${table}`).run();
      const insert = database.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`);
      state[table].forEach((row) => insert.run(row.id, JSON.stringify(row)));
    }
  });
  persist();
}

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
    isOnline: Boolean(onlineUsers.get(user.id))
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
  return Object.values(entry.scores).map(Number).filter((score) => Number.isFinite(score));
}

function reportSummary(report) {
  const entries = [
    ...(Array.isArray(report.data?.entries) ? report.data.entries : []),
    ...(Array.isArray(report.data?.trolleys) ? report.data.trolleys : []),
    ...(Array.isArray(report.data?.pantries) ? report.data.pantries : [])
  ];
  const scores = entries.flatMap(scoreValues);
  const hasBadVehicle = Object.values(report.data?.vehicle || {}).includes('Not OK');
  const flaggedEntries = entries.filter((entry) => {
    const values = scoreValues(entry);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 10;
    return average < 6 || entry.status === 'Broken' || Boolean(entry.remarks);
  });
  return {
    itemCount: entries.length || (report.data?.items ? report.data.items.length : 0),
    average: scores.length ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(1)) : 0,
    flagged: Boolean(hasBadVehicle || flaggedEntries.length || report.data?.notes),
    flaggedCount: flaggedEntries.length + (hasBadVehicle ? 1 : 0)
  };
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

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'HK SYNC backend is running.' });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, avatar, role } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  const existingUser = state.users.find((user) => user.email.toLowerCase() === String(email).toLowerCase());
  if (existingUser) {
    return res.status(409).json({ message: 'A user with that email already exists.' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    avatar: avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name.trim())}&background=2563eb&color=fff`,
    role: role || 'supervisor',
    password: hashedPassword,
    active: true,
    status: 'online',
    createdAt: new Date().toISOString()
  };

  state.users.push(newUser);
  saveState();

  const token = createToken(newUser);
  return res.status(201).json({ token, user: sanitizeUser(newUser) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const user = state.users.find((entry) => entry.email.toLowerCase() === String(email).toLowerCase());
  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }
  if (user.active === false) {
    return res.status(403).json({ message: 'This account is inactive. Contact a manager.' });
  }

  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  user.status = 'online';
  saveState();

  const token = createToken(user);
  return res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = state.users.find((entry) => entry.email === email && entry.active !== false);
  const response = { message: 'If that account exists, a password reset link has been created.' };
  if (user) {
    const resetToken = randomBytes(32).toString('hex');
    user.resetTokenHash = createHash('sha256').update(resetToken).digest('hex');
    user.resetTokenExpiresAt = Date.now() + 15 * 60 * 1000;
    saveState();
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
  user.password = await bcrypt.hash(password, 10);
  delete user.resetTokenHash;
  delete user.resetTokenExpiresAt;
  saveState();
  return res.json({ message: 'Password reset successfully. You can now sign in.' });
});

app.get('/api/users/me', authMiddleware, (req, res) => {
  const user = state.users.find((entry) => entry.id === req.user.id);

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  return res.json({ user: sanitizeUser(user) });
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

app.post('/api/users/staff', authMiddleware, requireManager, async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const allowedRoles = ['supervisor', 'driver', 'storekeeper', 'assistant_manager'];
  if (!name || !email || !password || !allowedRoles.includes(role)) {
    return res.status(400).json({ message: 'Name, email, password, and a valid staff role are required.' });
  }
  if (state.users.some((user) => user.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ message: 'A user with that email already exists.' });
  }
  const staffUser = {
    id: crypto.randomUUID(),
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
  saveState();
  return res.status(201).json({ user: sanitizeUser(staffUser) });
});

app.patch('/api/users/:id/status', authMiddleware, requireManager, (req, res) => {
  const user = state.users.find((entry) => entry.id === req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (user.id === req.currentUser.id) return res.status(400).json({ message: 'You cannot deactivate your own account.' });
  user.active = Boolean(req.body?.active);
  saveState();
  return res.json({ user: sanitizeUser(user) });
});

app.post('/api/users/:id/reset-password', authMiddleware, requireManager, async (req, res) => {
  const user = state.users.find((entry) => entry.id === req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const resetToken = randomBytes(32).toString('hex');
  user.resetTokenHash = createHash('sha256').update(resetToken).digest('hex');
  user.resetTokenExpiresAt = Date.now() + 15 * 60 * 1000;
  saveState();
  const response = { message: 'A password reset link has been created.' };
  if (process.env.NODE_ENV !== 'production') response.resetToken = resetToken;
  return res.json(response);
});

app.get('/api/reports', authMiddleware, (req, res) => {
  const viewer = currentUser(req);
  const reports = state.reports
    .filter((report) => !report.voided)
    .filter((report) => ['manager', 'assistant_manager'].includes(viewer?.role) || report.submittedBy === req.user.id)
    .map((report) => ({
      ...report,
      submitter: sanitizeUser(state.users.find((user) => user.id === report.submittedBy) || {}),
      ...reportSummary(report)
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ reports });
});

app.post('/api/reports', authMiddleware, (req, res) => {
  const { type, date, data } = req.body || {};
  if (!type || !date || !data) return res.status(400).json({ message: 'Report type, date and data are required.' });
  const submitter = currentUser(req);
  if (!roleReportTypes[submitter?.role]?.includes(type)) {
    return res.status(403).json({ message: 'Your role cannot submit this report type.' });
  }
  const report = {
    id: crypto.randomUUID(), type, date, data, submittedBy: req.user.id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hodSignature: null
  };
  state.reports.push(report);
  saveState();
  return res.status(201).json({ report: { ...report, ...reportSummary(report) } });
});

app.post('/api/reports/:id/sign', authMiddleware, requireManager, (req, res) => {
  const report = state.reports.find((entry) => entry.id === req.params.id);
  if (!report) return res.status(404).json({ message: 'Report not found.' });
  report.hodSignature = req.currentUser.name;
  report.hodSignedAt = new Date().toISOString();
  report.updatedAt = new Date().toISOString();
  saveState();
  return res.json({ report });
});

app.get('/api/tasks', authMiddleware, (req, res) => {
  const tasks = state.tasks.filter((task) => task.assignedTo === req.user.id || ['manager', 'assistant_manager'].includes(state.users.find((user) => user.id === req.user.id)?.role));
  return res.json({ tasks });
});

app.post('/api/tasks', authMiddleware, requireManager, (req, res) => {
  const { title, location, assignedTo, priority = 'medium', dueDate } = req.body || {};
  if (!title || !location) return res.status(400).json({ message: 'Task title and location are required.' });
  const task = { id: crypto.randomUUID(), title, location, assignedTo: assignedTo || null, assignedBy: req.user.id, priority, dueDate: dueDate || null, status: 'pending', createdAt: new Date().toISOString() };
  state.tasks.push(task);
  saveState();
  return res.status(201).json({ task });
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
  if (!receiver) {
    return res.status(404).json({ message: 'Recipient user not found.' });
  }

  const message = {
    id: crypto.randomUUID(),
    senderId: req.user.id,
    receiverId,
    text: String(text).trim(),
    createdAt: new Date().toISOString(),
    read: false
  };

  state.messages.push(message);
  saveState();

  const payload = buildMessageEntry(message);
  io.to(receiverId).emit('new-message', payload);
  io.to(req.user.id).emit('new-message', payload);

  return res.status(201).json({ message: payload });
});

io.on('connection', (socket) => {
  socket.on('register-user', (userId) => {
    if (!userId) return;

    onlineUsers.set(userId, socket.id);
    socket.join(userId);
    socket.userId = userId;

    const user = state.users.find((entry) => entry.id === userId);
    if (user) {
      user.status = 'online';
      saveState();
    }

    io.emit('presence:update', { userId, isOnline: true });
  });

  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (userId) {
      onlineUsers.delete(userId);
      const user = state.users.find((entry) => entry.id === userId);
      if (user) {
        user.status = 'offline';
        saveState();
      }
      io.emit('presence:update', { userId, isOnline: false });
    }
  });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Not found.' });
});

export default server;
