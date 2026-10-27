// Housekeeping store: the four store books (chemicals & tools, amenities & stationery, minibar, room equipment &
// glassware), what is used / received / adjusted / counted each day, occupancy and budgets, and the monthly and season
// consumption reports the Excel books used to give. The storekeeper and managers record (stock, occupied rooms and
// monthly guests); only managers set budgets.
//
// Data model. Everything that moves stock is a "day sheet": one per book, date and kind, holding a quantity per item and
// the unit price at the time (so a later price change never rewrites history):
//   use      what was used that day, for every book (history imported from the chemicals book is one sheet a month,
//            as that book only kept month totals)
//   receive  deliveries
//   adjust   losses and corrections (+/-)
//   count    a stock count: the stock at the end of that day, whatever the running figure said
// Stock = last count + received + adjustments − used. Reports add the sheets up; nothing is kept as a running total.
import express from 'express';
import { randomUUID } from 'node:crypto';

export const STORE_BOOKS = {
  chemicals: { name: 'Chemicals & Tools', short: 'Chemicals', kpi: 'guests', stock: false, categories: ['Chemical', 'Tool/Consumable'] },
  amenities: { name: 'Amenities & Stationery', short: 'Amenities', kpi: 'roomNights', stock: false, categories: ['Bathroom Amenity', 'Guest Stationery', 'Healing Earth Range', 'Tea/Coffee Station'] },
  minibar: { name: 'Minibar', short: 'Minibar', kpi: 'roomNights', stock: false, categories: ['Beer', 'Soft Drink', 'Juice', 'Tea/Coffee'] },
  equipment: { name: 'Room Equipment & Glassware', short: 'Equipment', kpi: 'stock', stock: true, categories: ['Room Equipment', 'Glassware & Crockery', 'Bathroom Bottles', 'Bins & Brushes'] }
};
const KINDS = ['receive', 'adjust', 'use', 'count']; // also the order they apply within one day
// Budgets as the Excel books set them: chemicals USD 0.35 per guest, or a fixed USD 9,000 (high season) / 6,700 (low
// season) a month; equipment USD 1,200 of purchases a month. High season: July to February.
const DEFAULT_SETTINGS = { exchangeRate: 2400, highSeasonMonths: [1, 2, 7, 8, 9, 10, 11, 12], chemicals: { perGuestUsd: 0.35, highSeasonUsd: 9000, lowSeasonUsd: 6700 }, equipment: { monthlyPurchaseUsd: 1200 } };
// The store supervisor runs the store: everything a manager can do here, budgets and importing past months included.
const STORE_ROLES = ['storekeeper', 'store_supervisor', 'manager', 'assistant_manager'];
const MANAGER_ROLES = ['manager', 'assistant_manager', 'store_supervisor'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// A real calendar day: 2025-11-31 is refused rather than read as 1 December.
const isDate = (value) => typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max = 80) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (value) => Math.round(value * 100) / 100;
const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const shiftMonth = (ym, by) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + by, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

export function registerStore(app, { database, authMiddleware, findUser, today }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS store_items (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS store_sheets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS store_days (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS store_months (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS store_meta (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  const load = (table) => new Map(database.prepare(`SELECT data FROM ${table}`).all().map((row) => JSON.parse(row.data)).map((row) => [row.id, row]));
  const items = load('store_items');
  const sheets = load('store_sheets');
  const days = load('store_days');
  const months = load('store_months');
  let settings = { ...DEFAULT_SETTINGS, ...(load('store_meta').get('settings') || {}) };
  const tables = { items: 'store_items', sheets: 'store_sheets', days: 'store_days', months: 'store_months', meta: 'store_meta' };
  const save = (kind, row) => database.prepare(`INSERT OR REPLACE INTO ${tables[kind]} (id, data) VALUES (?, ?)`).run(row.id, JSON.stringify(row));
  const remove = (kind, id) => database.prepare(`DELETE FROM ${tables[kind]} WHERE id = ?`).run(id);

  const storeAccess = (req, res, next) => {
    const user = findUser(req.user.id);
    if (!user || !STORE_ROLES.includes(user.role)) return res.status(403).json({ message: 'Only the store team and managers can open the store.' });
    req.storeUser = user;
    next();
  };
  const canManage = (user) => MANAGER_ROLES.includes(user?.role);
  const bookOf = (key) => (Object.hasOwn(STORE_BOOKS, key) ? STORE_BOOKS[key] : null);
  const bookItems = (book) => [...items.values()].filter((item) => item.book === book).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const sheetId = (book, date, kind) => `${book}|${date}|${kind}`;
  const currentMonth = () => today().slice(0, 7);
  const seasonOf = (ym) => months.get(ym)?.season || (settings.highSeasonMonths.includes(Number(ym.slice(5))) ? 'high' : 'low');

  // ---------- Items ----------
  const readItem = (body, existing = null) => {
    const book = existing?.book || body.book;
    if (!bookOf(book)) return { error: 'Choose which store book the item belongs to.' };
    const name = cleanText(body.name ?? existing?.name);
    if (!name) return { error: 'Give the item a name.' };
    const clash = bookItems(book).find((item) => item.id !== existing?.id && item.name.toLowerCase() === name.toLowerCase());
    if (clash) return { error: `"${name}" is already in ${STORE_BOOKS[book].name}.` };
    const unitCost = Number(body.unitCost ?? existing?.unitCost ?? 0);
    if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 1e9) return { error: 'The unit cost must be a number of shillings.' };
    let par = existing?.par ?? null;
    if (body.par !== undefined) par = body.par === '' || body.par === null ? null : Number(body.par);
    if (par !== null && (!Number.isFinite(par) || par < 0)) return { error: 'The par stock must be a number.' };
    return { item: {
      ...(existing || { id: randomUUID(), book, createdAt: new Date().toISOString(), order: bookItems(book).length }),
      name, category: cleanText(body.category ?? existing?.category) || STORE_BOOKS[book].categories[0], unit: cleanText(body.unit ?? existing?.unit, 30),
      unitCost: money(unitCost), par, active: body.active === undefined ? existing?.active !== false : body.active !== false
    } };
  };

  // ---------- Reports ----------
  // One pass over a book's sheets for a month: usage per item and day, deliveries, adjustments, and (for stock books)
  // opening and closing stock with the difference any stock count found.
  function monthReport(bookKey, ym) {
    const book = STORE_BOOKS[bookKey];
    const dayCount = daysIn(ym);
    const start = `${ym}-01`;
    const end = `${ym}-${String(dayCount).padStart(2, '0')}`;
    const rows = new Map(bookItems(bookKey).map((item) => [item.id, { id: item.id, name: item.name, category: item.category, unit: item.unit, unitCost: item.unitCost, par: item.par, active: item.active !== false, used: 0, cost: 0, daily: Array(dayCount).fill(0), received: 0, receivedValue: 0, adjust: 0, countDiff: 0, opening: 0, closing: 0 }]));
    const dailyCost = Array(dayCount).fill(0);
    const stock = new Map();
    let opened = false;
    const ordered = [...sheets.values()].filter((sheet) => sheet.book === bookKey && sheet.date <= end).sort((a, b) => a.date.localeCompare(b.date) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
    const openStock = () => { if (!opened) { for (const row of rows.values()) row.opening = stock.get(row.id) || 0; opened = true; } };
    for (const sheet of ordered) {
      if (sheet.date >= start) openStock();
      const inMonth = sheet.date >= start;
      for (const [id, line] of Object.entries(sheet.lines)) {
        const row = rows.get(id);
        if (!row) continue;
        const before = stock.get(id) || 0;
        if (sheet.kind === 'use') {
          stock.set(id, before - line.qty);
          if (inMonth) { const day = Number(sheet.date.slice(8)) - 1; row.used += line.qty; row.cost += line.qty * line.price; row.daily[day] += line.qty; dailyCost[day] += line.qty * line.price; }
        } else if (sheet.kind === 'receive') {
          stock.set(id, before + line.qty);
          if (inMonth) { row.received += line.qty; row.receivedValue += line.qty * line.price; }
        } else if (sheet.kind === 'adjust') {
          stock.set(id, before + line.qty);
          if (inMonth) row.adjust += line.qty;
        } else if (sheet.kind === 'count') {
          stock.set(id, line.qty);
          if (inMonth) row.countDiff += line.qty - before;
        }
      }
    }
    openStock();
    for (const row of rows.values()) row.closing = stock.get(row.id) || 0;
    const list = [...rows.values()].filter((row) => row.active || row.used || row.received || row.adjust || row.countDiff || row.opening || row.closing)
      .map((row) => ({ ...row, cost: money(row.cost), receivedValue: money(row.receivedValue), reorder: book.stock && row.par !== null && row.par !== undefined ? row.closing < row.par : false }));
    const totalCost = money(list.reduce((sum, row) => sum + row.cost, 0));
    // Occupancy: cost per occupied room-night counts only the days whose occupied rooms were entered, as the Excel books did.
    const occupied = Array.from({ length: dayCount }, (_, index) => days.get(`${ym}-${String(index + 1).padStart(2, '0')}`)?.rooms ?? null);
    const recorded = occupied.map((rooms, index) => [rooms, index]).filter(([rooms]) => rooms !== null);
    const roomNights = recorded.reduce((sum, [rooms]) => sum + rooms, 0);
    const costOnOccupiedDays = recorded.reduce((sum, [, index]) => sum + dailyCost[index], 0);
    // This month's budgets count only the days gone so far, as the Excel books pro-rated a part month.
    const share = ym === currentMonth() ? Number(today().slice(8)) / dayCount : ym > currentMonth() ? 0 : 1;
    const rate = settings.exchangeRate;
    const season = seasonOf(ym);
    const guests = months.get(ym)?.guests ?? null;
    const occupancyBudget = guests !== null ? money(guests * settings.chemicals.perGuestUsd * rate) : null;
    const fixedBudget = money((season === 'high' ? settings.chemicals.highSeasonUsd : settings.chemicals.lowSeasonUsd) * rate * share);
    const purchaseBudget = money(settings.equipment.monthlyPurchaseUsd * rate * share);
    const receivedValue = money(list.reduce((sum, row) => sum + row.receivedValue, 0));
    const value = (field) => money(list.reduce((sum, row) => sum + Math.max(0, row[field]) * row.unitCost, 0));
    return {
      book: bookKey, month: ym, days: dayCount, items: list, totalCost, dailyCost: dailyCost.map(money), occupied,
      kpis: {
        roomNights, daysWithData: recorded.length, avgRooms: recorded.length ? money(roomNights / recorded.length) : null,
        costPerRoomNight: roomNights ? money(costOnOccupiedDays / roomNights) : null,
        guests, season, costPerGuest: guests ? money(totalCost / guests) : null,
        occupancyBudget, occupancyVariance: occupancyBudget !== null ? money(totalCost - occupancyBudget) : null,
        fixedBudget, fixedVariance: money(totalCost - fixedBudget),
        purchaseBudget, receivedValue, receivedVsBudget: money(receivedValue - purchaseBudget),
        openingValue: value('opening'), closingValue: value('closing'), itemsToReorder: list.filter((row) => row.reorder).length
      },
      categories: STORE_BOOKS[bookKey].categories.concat([...new Set(list.map((row) => row.category))].filter((category) => !STORE_BOOKS[bookKey].categories.includes(category)))
        .map((category) => ({ category, cost: money(list.filter((row) => row.category === category).reduce((sum, row) => sum + row.cost, 0)) })).filter((entry) => entry.cost || list.some((row) => row.category === entry.category))
    };
  }

  // Twelve months ending `to`: one line per month, the top items and the cost by category, like the Excel dashboards.
  function seasonReport(bookKey, to) {
    const list = Array.from({ length: 12 }, (_, index) => shiftMonth(to, index - 11));
    const reports = list.map((ym) => monthReport(bookKey, ym));
    const byItem = new Map();
    const byCategory = new Map();
    for (const report of reports) for (const row of report.items) {
      byItem.set(row.name, (byItem.get(row.name) || 0) + row.cost);
      byCategory.set(row.category, (byCategory.get(row.category) || 0) + row.cost);
    }
    const months = reports.map((report) => ({ month: report.month, totalCost: report.totalCost, used: report.items.reduce((sum, row) => sum + row.used, 0), ...report.kpis }));
    const sum = (field) => money(months.reduce((total, month) => total + (month[field] || 0), 0));
    const roomNights = sum('roomNights');
    return {
      book: bookKey, from: list[0], to, months,
      totals: { totalCost: sum('totalCost'), guests: sum('guests'), occupancyBudget: sum('occupancyBudget'), fixedBudget: sum('fixedBudget'), purchaseBudget: sum('purchaseBudget'), receivedValue: sum('receivedValue'), roomNights, costPerRoomNight: roomNights ? money(reports.reduce((total, report) => total + report.dailyCost.reduce((s, cost, index) => s + (report.occupied[index] !== null ? cost : 0), 0), 0) / roomNights) : null, costPerGuest: sum('guests') ? money(sum('totalCost') / sum('guests')) : null },
      topItems: [...byItem.entries()].map(([name, cost]) => ({ name, cost: money(cost) })).filter((entry) => entry.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 10),
      categories: [...byCategory.entries()].map(([category, cost]) => ({ category, cost: money(cost) })).sort((a, b) => b.cost - a.cost)
    };
  }

  // ---------- Routes ----------
  app.get('/api/store', authMiddleware, storeAccess, (req, res) => {
    res.json({ books: STORE_BOOKS, items: [...items.values()].sort((a, b) => a.book.localeCompare(b.book) || (a.order ?? 0) - (b.order ?? 0)), settings, canManage: canManage(req.storeUser), today: today() });
  });

  app.post('/api/store/items', authMiddleware, storeAccess, (req, res) => {
    const { item, error } = readItem(req.body || {});
    if (error) return res.status(400).json({ message: error });
    items.set(item.id, item); save('items', item);
    res.status(201).json({ item });
  });

  app.put('/api/store/items/:id', authMiddleware, storeAccess, (req, res) => {
    const existing = items.get(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Item not found.' });
    const { item, error } = readItem(req.body || {}, existing);
    if (error) return res.status(400).json({ message: error });
    items.set(item.id, { ...item, updatedAt: new Date().toISOString(), updatedBy: req.storeUser.id }); save('items', items.get(item.id));
    res.json({ item: items.get(item.id) });
  });

  // Everything recorded for one book on one day, plus that day's occupied rooms.
  app.get('/api/store/day', authMiddleware, storeAccess, (req, res) => {
    const { book, date } = req.query;
    if (!bookOf(book) || !isDate(date)) return res.status(400).json({ message: 'Choose a store book and a date.' });
    const found = Object.fromEntries(KINDS.map((kind) => [kind, sheets.get(sheetId(book, date, kind)) || null]));
    res.json({ sheets: found, rooms: days.get(date)?.rooms ?? null });
  });

  app.put('/api/store/sheet', authMiddleware, storeAccess, (req, res) => {
    const { book, date, kind, lines = {}, note = '' } = req.body || {};
    if (!bookOf(book)) return res.status(400).json({ message: 'Choose a store book.' });
    if (!isDate(date) || date > today()) return res.status(400).json({ message: 'Choose today or a past date.' });
    if (!KINDS.includes(kind)) return res.status(400).json({ message: 'Choose used, received, adjustment or stock count.' });
    if (!isPlainObject(lines)) return res.status(400).json({ message: 'The quantities are not valid.' });
    const clean = {};
    for (const [id, raw] of Object.entries(lines)) {
      const item = items.get(id);
      if (!item || item.book !== book) return res.status(400).json({ message: 'One of the items is not in this book. Reload and try again.' });
      if (raw === '' || raw === null || raw === undefined) continue;
      const qty = Number(raw);
      if (!Number.isFinite(qty) || Math.abs(qty) > 1e6) return res.status(400).json({ message: `The quantity for ${item.name} must be a number.` });
      if (qty < 0 && kind !== 'adjust') return res.status(400).json({ message: `Only an adjustment can be below zero (${item.name}).` });
      if (qty === 0 && kind !== 'count') continue;
      // Keep the price of the day the sheet was first recorded, unless the item is new on this sheet.
      const previous = sheets.get(sheetId(book, date, kind))?.lines?.[id];
      clean[id] = { qty: Math.round(qty * 1000) / 1000, price: previous?.price ?? item.unitCost };
    }
    const id = sheetId(book, date, kind);
    if (!Object.keys(clean).length) {
      if (sheets.has(id)) { sheets.delete(id); remove('sheets', id); }
      return res.json({ sheet: null });
    }
    const sheet = { ...(sheets.get(id) || { createdAt: new Date().toISOString(), createdBy: req.storeUser.id }), id, book, date, kind, lines: clean, note: cleanText(note, 300), updatedAt: new Date().toISOString(), updatedBy: req.storeUser.id };
    sheets.set(id, sheet); save('sheets', sheet);
    res.json({ sheet });
  });

  // Occupied rooms per day (null clears a day), and guests / season per month.
  app.put('/api/store/occupancy', authMiddleware, storeAccess, (req, res) => {
    const entries = isPlainObject(req.body?.days) ? Object.entries(req.body.days) : [];
    if (!entries.length || entries.length > 400) return res.status(400).json({ message: 'Send the days to update.' });
    for (const [date, raw] of entries) {
      if (!isDate(date)) return res.status(400).json({ message: `${date} is not a date.` });
      if (raw === '' || raw === null) { if (days.has(date)) { days.delete(date); remove('days', date); } continue; }
      const rooms = Number(raw);
      if (!Number.isInteger(rooms) || rooms < 0 || rooms > 5000) return res.status(400).json({ message: `Occupied rooms on ${date} must be a whole number.` });
      const row = { id: date, rooms, updatedAt: new Date().toISOString(), updatedBy: req.storeUser.id };
      days.set(date, row); save('days', row);
    }
    res.json({ ok: true });
  });

  app.get('/api/store/occupancy', authMiddleware, storeAccess, (req, res) => {
    const { month } = req.query;
    if (!MONTH.test(month || '')) return res.status(400).json({ message: 'Choose a month.' });
    res.json({ month, days: Object.fromEntries([...days.values()].filter((row) => row.id.startsWith(month)).map((row) => [row.id, row.rooms])), guests: months.get(month)?.guests ?? null, season: seasonOf(month), seasonSet: Boolean(months.get(month)?.season) });
  });

  app.put('/api/store/months/:month', authMiddleware, storeAccess, (req, res) => {
    const { month } = req.params;
    if (!MONTH.test(month)) return res.status(400).json({ message: 'Choose a month.' });
    const row = { ...(months.get(month) || {}), id: month };
    if (req.body?.guests !== undefined) {
      if (req.body.guests === '' || req.body.guests === null) delete row.guests;
      else { const guests = Number(req.body.guests); if (!Number.isInteger(guests) || guests < 0) return res.status(400).json({ message: 'Guests must be a whole number.' }); row.guests = guests; }
    }
    if (req.body?.season !== undefined) { if (['high', 'low'].includes(req.body.season)) row.season = req.body.season; else delete row.season; }
    months.set(month, row); save('months', row);
    res.json({ month: row });
  });

  app.put('/api/store/settings', authMiddleware, storeAccess, (req, res) => {
    if (!canManage(req.storeUser)) return res.status(403).json({ message: 'Only managers and the store supervisor can change store budgets.' });
    const body = req.body || {};
    const number = (value, fallback) => { const n = Number(value); return value === undefined ? fallback : Number.isFinite(n) && n >= 0 ? n : NaN; };
    const next = {
      exchangeRate: number(body.exchangeRate, settings.exchangeRate),
      highSeasonMonths: Array.isArray(body.highSeasonMonths) ? [...new Set(body.highSeasonMonths.map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b) : settings.highSeasonMonths,
      chemicals: { perGuestUsd: number(body.chemicals?.perGuestUsd, settings.chemicals.perGuestUsd), highSeasonUsd: number(body.chemicals?.highSeasonUsd, settings.chemicals.highSeasonUsd), lowSeasonUsd: number(body.chemicals?.lowSeasonUsd, settings.chemicals.lowSeasonUsd) },
      equipment: { monthlyPurchaseUsd: number(body.equipment?.monthlyPurchaseUsd, settings.equipment.monthlyPurchaseUsd) }
    };
    const numbers = [next.exchangeRate, next.chemicals.perGuestUsd, next.chemicals.highSeasonUsd, next.chemicals.lowSeasonUsd, next.equipment.monthlyPurchaseUsd];
    if (numbers.some((n) => Number.isNaN(n)) || !next.exchangeRate) return res.status(400).json({ message: 'Budgets and the exchange rate must be numbers.' });
    settings = next; save('meta', { id: 'settings', ...settings });
    res.json({ settings });
  });

  app.get('/api/store/report', authMiddleware, storeAccess, (req, res) => {
    const { book, month } = req.query;
    if (!bookOf(book) || !MONTH.test(month || '')) return res.status(400).json({ message: 'Choose a store book and a month.' });
    res.json({ report: monthReport(book, month) });
  });

  app.get('/api/store/season', authMiddleware, storeAccess, (req, res) => {
    const { to } = req.query;
    if (!MONTH.test(to || '')) return res.status(400).json({ message: 'Choose the last month.' });
    if (req.query.book === 'all') {
      const books = Object.keys(STORE_BOOKS).map((key) => seasonReport(key, to));
      return res.json({ season: { book: 'all', from: books[0].from, to, books: books.map((entry) => ({ book: entry.book, months: entry.months.map(({ month, totalCost }) => ({ month, totalCost })), totalCost: entry.totals.totalCost })) } });
    }
    if (!bookOf(req.query.book)) return res.status(400).json({ message: 'Choose a store book.' });
    res.json({ season: seasonReport(req.query.book, to) });
  });

  // Past months from the Excel store books, read in the browser (features/store/importExcel.js) and sent in one go by a
  // signed-in manager. Items are matched by book and name; each day sheet keeps the price the book had that month and
  // replaces any sheet for the same book, day and kind, so importing again never adds anything twice.
  app.post('/api/store/import', authMiddleware, express.json({ limit: '20mb' }), storeAccess, (req, res) => {
    if (!canManage(req.storeUser)) return res.status(403).json({ message: 'Only managers and the store supervisor can import past months.' });
    const { items: incoming, sheets: incomingSheets, days: incomingDays = {}, months: incomingMonths = {} } = req.body || {};
    if (!Array.isArray(incoming) || !Array.isArray(incomingSheets) || incoming.length > 2000 || incomingSheets.length > 20000 || !isPlainObject(incomingDays) || !isPlainObject(incomingMonths)) return res.status(400).json({ message: 'The import is not in the expected shape.' });
    const now = new Date().toISOString();
    const ids = new Map();
    const problem = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
    const run = database.transaction(() => {
      for (const raw of incoming) {
        if (!isPlainObject(raw) || !bookOf(raw.book)) problem('An item has no store book.');
        const name = cleanText(raw.name);
        const unitCost = Number(raw.unitCost);
        if (!name || !Number.isFinite(unitCost) || unitCost < 0) problem(`The item "${name || '?'}" needs a name and a price.`);
        const existing = bookItems(raw.book).find((item) => item.name.toLowerCase() === name.toLowerCase());
        const par = raw.par === null || raw.par === undefined || raw.par === '' ? existing?.par ?? null : Number(raw.par);
        const item = { ...(existing || { id: randomUUID(), book: raw.book, createdAt: now, order: bookItems(raw.book).length, active: true }), name, category: cleanText(raw.category) || existing?.category || STORE_BOOKS[raw.book].categories[0], unit: cleanText(raw.unit, 30) || existing?.unit || '', unitCost: money(unitCost), par: Number.isFinite(par) ? par : null, updatedAt: now, updatedBy: req.storeUser.id };
        items.set(item.id, item); save('items', item);
        ids.set(String(raw.key), item.id);
      }
      for (const raw of incomingSheets) {
        if (!isPlainObject(raw) || !bookOf(raw.book) || !KINDS.includes(raw.kind) || !isPlainObject(raw.lines)) problem('A day in the import is not valid.');
        if (!isDate(raw.date) || raw.date > today()) problem(`${raw.date} is not a past date.`);
        const lines = {};
        for (const [key, line] of Object.entries(raw.lines)) {
          const id = ids.get(key);
          const qty = Number(line?.qty); const price = Number(line?.price);
          if (!id || items.get(id).book !== raw.book) problem(`An item on ${raw.date} is not in the import's item list.`);
          if (!Number.isFinite(qty) || !Number.isFinite(price) || price < 0 || (qty < 0 && raw.kind !== 'adjust')) problem(`A quantity on ${raw.date} is not valid.`);
          lines[id] = { qty: Math.round(qty * 1000) / 1000, price: money(price) };
        }
        const id = sheetId(raw.book, raw.date, raw.kind);
        if (!Object.keys(lines).length) { if (sheets.has(id)) { sheets.delete(id); remove('sheets', id); } continue; }
        const sheet = { ...(sheets.get(id) || { createdAt: now, createdBy: req.storeUser.id }), id, book: raw.book, date: raw.date, kind: raw.kind, lines, note: cleanText(raw.note, 300), updatedAt: now, updatedBy: req.storeUser.id, imported: true };
        sheets.set(id, sheet); save('sheets', sheet);
      }
      for (const [date, raw] of Object.entries(incomingDays)) {
        const rooms = Number(raw);
        if (!isDate(date) || !Number.isInteger(rooms) || rooms < 0) problem(`Occupied rooms on ${date} are not valid.`);
        const row = { id: date, rooms, updatedAt: now, updatedBy: req.storeUser.id };
        days.set(date, row); save('days', row);
      }
      for (const [month, raw] of Object.entries(incomingMonths)) {
        if (!MONTH.test(month) || !isPlainObject(raw)) problem(`${month} is not a month.`);
        const row = { ...(months.get(month) || {}), id: month };
        if (Number.isInteger(raw.guests) && raw.guests >= 0) row.guests = raw.guests;
        if (['high', 'low'].includes(raw.season)) row.season = raw.season;
        months.set(month, row); save('months', row);
      }
    });
    // The in-memory copy is changed alongside the database; if anything is refused, reload both from the database.
    try { run(); } catch (error) {
      for (const [map, table] of [[items, 'store_items'], [sheets, 'store_sheets'], [days, 'store_days'], [months, 'store_months']]) { map.clear(); for (const [id, row] of load(table)) map.set(id, row); }
      return res.status(error.status || 500).json({ message: error.status ? error.message : 'The import could not be saved.' });
    }
    res.json({ items: incoming.length, sheets: incomingSheets.length, days: Object.keys(incomingDays).length, months: Object.keys(incomingMonths).length });
  });
}
