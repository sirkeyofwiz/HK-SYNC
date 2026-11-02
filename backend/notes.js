// Notes for the manager: a supervisor adds a note to a report or task ("Room 214 guest asked for late cleaning",
// "Waiting for maintenance to fix the tap") for managers to read. It stays on the report or task, managers are told,
// and the note count shows on the lists. Anyone who can open the report or task can read its notes and add one.
import { randomUUID } from 'node:crypto';

const KINDS = ['report', 'task'];
const cleanNote = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

export function registerNotes(app, { database, authMiddleware, who, findItem, canSee, describe, managers, notify, userName, isManagerRole }) {
  database.exec('CREATE TABLE IF NOT EXISTS item_notes (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const notes = new Map(database.prepare('SELECT data FROM item_notes').all().map((row) => JSON.parse(row.data)).map((row) => [row.id, row]));
  const save = (row) => database.prepare('INSERT OR REPLACE INTO item_notes (id, data) VALUES (?, ?)').run(row.id, JSON.stringify(row));
  const view = (row, viewer) => ({ ...row, byName: userName(row.createdBy), canDelete: row.createdBy === viewer.id || isManagerRole(viewer) });
  const forItem = (kind, id) => [...notes.values()].filter((row) => row.kind === kind && row.itemId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // The item, if this person may open it; otherwise a 404 as for the item itself.
  const open = (req, res, kind, id) => {
    if (!KINDS.includes(kind)) { res.status(400).json({ message: 'Choose a report or task.' }); return null; }
    const item = findItem(kind, id);
    if (!canSee(who(req), kind, item)) { res.status(404).json({ message: `${kind === 'report' ? 'Report' : 'Task'} not found.` }); return null; }
    return item;
  };

  app.get('/api/notes', authMiddleware, (req, res) => {
    const { kind, id } = req.query;
    if (!open(req, res, kind, id)) return;
    res.json({ notes: forItem(kind, id).map((row) => view(row, who(req))) });
  });

  app.post('/api/notes', authMiddleware, (req, res) => {
    const { kind, id } = req.body || {};
    const item = open(req, res, kind, id);
    if (!item) return;
    const text = cleanNote(req.body.text, 2000);
    if (!text) return res.status(400).json({ message: 'Write the note first.' });
    const row = { id: randomUUID(), kind, itemId: id, text, createdAt: new Date().toISOString(), createdBy: who(req).id };
    notes.set(row.id, row); save(row);
    const about = describe(kind, item);
    for (const manager of managers()) notify(manager.id, { type: 'note', fromUserId: who(req).id, title: `Note from ${who(req).name}`, body: `${about} · ${text}`, link: { page: kind, id } });
    res.status(201).json({ note: view(row, who(req)) });
  });

  app.delete('/api/notes/:id', authMiddleware, (req, res) => {
    const row = notes.get(req.params.id);
    if (!row || !canSee(who(req), row.kind, findItem(row.kind, row.itemId))) return res.status(404).json({ message: 'Note not found.' });
    if (row.createdBy !== who(req).id && !isManagerRole(who(req))) return res.status(403).json({ message: 'Only the writer or a manager can delete a note.' });
    notes.delete(row.id);
    database.prepare('DELETE FROM item_notes WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  return {
    // How many notes a report or task has, for the lists.
    count: (kind, id) => forItem(kind, id).length
  };
}
