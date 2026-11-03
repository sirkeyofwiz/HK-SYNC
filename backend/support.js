// Support plan: what a manager did to help a housekeeper or supervisor who needs attention (a coaching talk, training,
// a follow-up inspection…), what it was for, when to check again and how it turned out. Shown on each profile, where
// the problems themselves are worked out from the person's scores and remarks. Managers and assistant managers only.
import { randomUUID } from 'node:crypto';

export const SUPPORT_ACTIONS = ['Coaching talk', 'Training', 'Follow-up inspection', 'Re-clean with supervisor', 'Written warning', 'Other'];
export const SUPPORT_STATUSES = ['in_progress', 'improved', 'not_improved', 'closed'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value) => typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanNote = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
// Housekeepers are known by name (as on the roster and in reports), supervisors by their account.
const personKey = (kind, ref) => (kind === 'hk' ? `hk:${clean(ref, 120).toLowerCase()}` : `sup:${clean(ref, 80)}`);

export function registerSupport(app, { database, authMiddleware, requireManager, userName, today }) {
  database.exec('CREATE TABLE IF NOT EXISTS support_actions (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const actions = new Map(database.prepare('SELECT data FROM support_actions').all().map((row) => JSON.parse(row.data)).map((row) => [row.id, row]));
  const save = (row) => database.prepare('INSERT OR REPLACE INTO support_actions (id, data) VALUES (?, ?)').run(row.id, JSON.stringify(row));
  const view = (row) => ({ ...row, byName: userName(row.createdBy), updatedByName: row.updatedBy ? userName(row.updatedBy) : null });

  // The fields a manager sets; `existing` keeps what isn't sent.
  const read = (body, existing = {}) => {
    const date = body.date ?? existing.date;
    if (!isDate(date) || date > today()) return { error: 'Choose today or an earlier date.' };
    const action = body.action ?? existing.action;
    if (!SUPPORT_ACTIONS.includes(action)) return { error: 'Choose what was done.' };
    const problem = clean(body.problem ?? existing.problem, 200);
    if (!problem) return { error: 'Say what the action was for.' };
    const followUp = body.followUp === undefined ? existing.followUp ?? null : body.followUp || null;
    if (followUp !== null && (!isDate(followUp) || followUp < date)) return { error: 'The follow-up date must be on or after the action date.' };
    const status = body.status ?? existing.status ?? 'in_progress';
    if (!SUPPORT_STATUSES.includes(status)) return { error: 'Choose how it turned out.' };
    return { fields: { date, action, problem, notes: cleanNote(body.notes ?? existing.notes, 1000), followUp, status } };
  };

  app.get('/api/support-actions', authMiddleware, requireManager, (req, res) => {
    const { kind, ref } = req.query;
    if (!['hk', 'sup'].includes(kind) || !clean(ref, 120)) return res.status(400).json({ message: 'Choose a housekeeper or supervisor.' });
    const key = personKey(kind, ref);
    res.json({ actions: [...actions.values()].filter((row) => row.person === key).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt))).map(view), choices: { actions: SUPPORT_ACTIONS, statuses: SUPPORT_STATUSES } });
  });

  app.post('/api/support-actions', authMiddleware, requireManager, (req, res) => {
    const { kind, ref, name } = req.body || {};
    if (!['hk', 'sup'].includes(kind) || !clean(ref, 120)) return res.status(400).json({ message: 'Choose a housekeeper or supervisor.' });
    const { fields, error } = read(req.body || {});
    if (error) return res.status(400).json({ message: error });
    const row = { id: randomUUID(), person: personKey(kind, ref), kind, name: clean(name || ref, 120), ...fields, createdAt: new Date().toISOString(), createdBy: req.currentUser.id };
    actions.set(row.id, row); save(row);
    res.status(201).json({ action: view(row) });
  });

  app.patch('/api/support-actions/:id', authMiddleware, requireManager, (req, res) => {
    const existing = actions.get(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Action not found.' });
    const { fields, error } = read(req.body || {}, existing);
    if (error) return res.status(400).json({ message: error });
    const row = { ...existing, ...fields, updatedAt: new Date().toISOString(), updatedBy: req.currentUser.id };
    actions.set(row.id, row); save(row);
    res.json({ action: view(row) });
  });

  app.delete('/api/support-actions/:id', authMiddleware, requireManager, (req, res) => {
    if (!actions.has(req.params.id)) return res.status(404).json({ message: 'Action not found.' });
    actions.delete(req.params.id);
    database.prepare('DELETE FROM support_actions WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  return {
    // A housekeeper renamed on Goals (with "update past reports") keeps their support history.
    renameHousekeeper(fromName, toName) {
      const from = personKey('hk', fromName);
      for (const row of actions.values()) if (row.person === from) { row.person = personKey('hk', toName); row.name = clean(toName, 120); save(row); }
    }
  };
}
