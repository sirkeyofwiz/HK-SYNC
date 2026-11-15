// Store availability: what the housekeeping store has on the shelf right now (room equipment, glassware, bathroom
// bottles, bins and brushes...), so supervisors know what they can ask for. Kept apart from the Store (store.js), which
// is switched off: this list has its own table and works whether or not the Store is on.
//
// Each item: name, category, the number in the store now and its par level (the number the store should always have).
//   Out of stock   nothing left
//   Running low    fewer than the par level
//   Available      at or above the par level (or no par level set)
// Supervisors and managers see the list; the store team and managers update it (counts, new items, an Excel import of
// the monthly stock book, which takes each item's latest closing stock).
import { randomUUID } from 'node:crypto';

const VIEW_ROLES = ['supervisor', 'manager', 'assistant_manager', 'storekeeper', 'store_supervisor'];
const EDIT_ROLES = ['manager', 'assistant_manager', 'storekeeper', 'store_supervisor'];
const MAX_QTY = 100000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (value, max = 60) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const nameKey = (name) => clean(name).toLowerCase();
// Item names arrive in capitals from the Excel book; show them as "Bottle opener".
const tidyName = (name) => { const text = clean(name); return text === text.toUpperCase() ? text.charAt(0) + text.slice(1).toLowerCase() : text; };
const status = (item) => (item.inStock <= 0 ? 'out' : item.par !== null && item.inStock < item.par ? 'low' : 'available');

export function registerAvailability(app, { database, authMiddleware, findUser, broadcast = () => {}, now = () => Date.now() }) {
  database.exec('CREATE TABLE IF NOT EXISTS stock_items (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const items = new Map(database.prepare('SELECT data FROM stock_items').all().map((row) => JSON.parse(row.data)).map((row) => [row.id, row]));
  const save = (item) => database.prepare('INSERT OR REPLACE INTO stock_items (id, data) VALUES (?, ?)').run(item.id, JSON.stringify(item));
  const iso = () => new Date(now()).toISOString();

  const access = (roles, message) => (req, res, next) => {
    const user = findUser(req.user.id);
    if (!user || user.active === false || !roles.includes(user.role)) return res.status(403).json({ message });
    req.stockUser = user;
    next();
  };
  const canView = access(VIEW_ROLES, 'Only supervisors, the store team and managers can see store availability.');
  const canEdit = access(EDIT_ROLES, 'Only the store team and managers can update store availability.');
  const shape = (item) => ({ ...item, status: status(item) });
  const list = () => [...items.values()].sort((a, b) => a.category.localeCompare(b.category) || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));

  // A whole number from 0 up; '' or null for "no par level" where that is allowed.
  const count = (value, { optional = false } = {}) => {
    if (optional && (value === '' || value === null || value === undefined)) return { value: null };
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > MAX_QTY) return { error: 'Enter a whole number, 0 or more.' };
    return { value: number };
  };

  app.get('/api/availability', authMiddleware, canView, (req, res) => {
    const rows = list().map(shape);
    const updatedAt = rows.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), '');
    return res.json({ items: rows, updatedAt: updatedAt || null, canEdit: EDIT_ROLES.includes(req.stockUser.role) });
  });

  app.post('/api/availability/items', authMiddleware, canEdit, (req, res) => {
    const body = req.body || {};
    const name = tidyName(body.name);
    if (!name) return res.status(400).json({ message: 'Enter the item name.' });
    if ([...items.values()].some((item) => nameKey(item.name) === nameKey(name))) return res.status(409).json({ message: `${name} is already on the list.` });
    const stock = count(body.inStock); if (stock.error) return res.status(400).json({ message: stock.error });
    const par = count(body.par, { optional: true }); if (par.error) return res.status(400).json({ message: `Par level: ${par.error}` });
    const at = iso();
    const item = { id: randomUUID(), name, category: clean(body.category) || 'Other', inStock: stock.value, par: par.value, order: items.size, createdAt: at, updatedAt: at, updatedByName: req.stockUser.name };
    items.set(item.id, item); save(item); broadcast();
    return res.status(201).json({ item: shape(item) });
  });

  // Update the count (the usual change), or fix the name, category or par level.
  app.patch('/api/availability/items/:id', authMiddleware, canEdit, (req, res) => {
    const item = items.get(req.params.id);
    if (!item) return res.status(404).json({ message: 'That item was not found.' });
    const body = req.body || {};
    const change = {};
    if ('name' in body) {
      change.name = tidyName(body.name);
      if (!change.name) return res.status(400).json({ message: 'Enter the item name.' });
      if ([...items.values()].some((other) => other.id !== item.id && nameKey(other.name) === nameKey(change.name))) return res.status(409).json({ message: `${change.name} is already on the list.` });
    }
    if ('category' in body) change.category = clean(body.category) || 'Other';
    if ('inStock' in body) { const stock = count(body.inStock); if (stock.error) return res.status(400).json({ message: stock.error }); change.inStock = stock.value; }
    if ('par' in body) { const par = count(body.par, { optional: true }); if (par.error) return res.status(400).json({ message: `Par level: ${par.error}` }); change.par = par.value; }
    Object.assign(item, change, { updatedAt: iso(), updatedByName: req.stockUser.name });
    save(item); broadcast();
    return res.json({ item: shape(item) });
  });

  app.delete('/api/availability/items/:id', authMiddleware, canEdit, (req, res) => {
    if (!items.delete(req.params.id)) return res.status(404).json({ message: 'That item was not found.' });
    database.prepare('DELETE FROM stock_items WHERE id = ?').run(req.params.id);
    broadcast();
    return res.json({ ok: true });
  });

  // From the monthly stock Excel book (read in the browser): { asOf: 'YYYY-MM-DD', items: [{ name, category, par, inStock }] }.
  // An item already on the list (same name) gets the new count, category and par; a new one is added. Nothing is removed.
  app.post('/api/availability/import', authMiddleware, canEdit, (req, res) => {
    const rows = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!rows || !rows.length || rows.length > 500) return res.status(400).json({ message: 'No items found in the file.' });
    const asOf = DATE.test(req.body?.asOf || '') ? req.body.asOf : null;
    const at = asOf ? `${asOf}T12:00:00.000Z` : iso();
    const ready = [];
    for (const raw of rows) {
      const name = tidyName(raw?.name);
      if (!name) continue;
      const stock = count(Math.max(0, Math.round(Number(raw.inStock) || 0)));
      const par = count(raw.par === '' || raw.par === null || raw.par === undefined ? null : Math.round(Number(raw.par)), { optional: true });
      if (stock.error || par.error) return res.status(400).json({ message: `${name}: the numbers could not be read.` });
      ready.push({ name, category: clean(raw.category) || 'Other', inStock: stock.value, par: par.value });
    }
    if (!ready.length) return res.status(400).json({ message: 'No items found in the file.' });
    let added = 0; let updated = 0;
    ready.forEach((row, index) => {
      const existing = [...items.values()].find((item) => nameKey(item.name) === nameKey(row.name));
      const item = existing ? Object.assign(existing, row) : { id: randomUUID(), ...row, order: index, createdAt: iso() };
      Object.assign(item, { updatedAt: at, updatedByName: `${req.stockUser.name} (Excel import)` });
      if (existing) updated += 1; else { added += 1; items.set(item.id, item); }
      save(item);
    });
    broadcast();
    return res.json({ added, updated, total: items.size });
  });
}
