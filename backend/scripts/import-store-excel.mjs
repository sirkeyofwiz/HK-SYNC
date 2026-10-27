// Imports the four Excel store books into a running HK-SYNC through its own API, then checks that the app's monthly
// totals match the books. Usage (from backend/):
//   node scripts/import-store-excel.mjs <api url> <manager email> <chemicals.xlsx> <amenities.xlsx> <minibar.xlsx> <stock.xlsx>
// It asks for the manager's password (or reads HK_PASSWORD), so the password never sits in the command or its history.
// Running it again is safe: items are matched by name and each day sheet is replaced, never added twice.
// Every month is recorded the way the storekeeper would: item prices as that month's sheet had them, one "used" sheet a
// day (chemicals: one a month), deliveries and adjustments, and a stock count where a month's opening stock differs.
import { createRequire } from 'node:module';
const XLSX = createRequire(new URL('../../frontend/package.json', import.meta.url))('xlsx');

const [API, EMAIL, CHEM, AMEN, MINI, STOCK] = process.argv.slice(2);
if (!STOCK) { console.error('Usage: node scripts/import-store-excel.mjs <api> <email> <chemicals> <amenities> <minibar> <stock>'); process.exit(1); }
// Reads the password without showing it on screen.
const askHidden = (question) => new Promise((resolve) => {
  process.stdout.write(question);
  const input = process.stdin; let typed = '';
  input.setRawMode?.(true); input.resume(); input.setEncoding('utf8');
  const onKey = (key) => {
    if (key === '\u0003') process.exit(1);
    if (key === '\r' || key === '\n') { input.setRawMode?.(false); input.pause(); input.off('data', onKey); process.stdout.write('\n'); resolve(typed); return; }
    typed = key === '\u007f' || key === '\b' ? typed.slice(0, -1) : typed + key;
  };
  input.on('data', onKey);
});
const PASSWORD = process.env.HK_PASSWORD || await askHidden(`Password for ${EMAIL}: `);
let token = '';
const call = async (method, route, body) => {
  const res = await fetch(`${API}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route}: ${data.message || res.status}`);
  return data;
};
token = (await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD })).token;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// The books run November 2025 to October 2026.
const monthKey = (name) => { const m = MONTHS.findIndex((month) => name.toLowerCase().startsWith(month.slice(0, 3).toLowerCase())) + 1; return `${m >= 11 ? 2025 : 2026}-${String(m).padStart(2, '0')}`; };
const rowsOf = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
const num = (value) => (value === '' || value === null || value === undefined ? 0 : Number(value) || 0);
const dayOf = (ym, day) => `${ym}-${String(day).padStart(2, '0')}`;
const serialDate = (serial) => new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
const realDay = (ym, day) => day <= new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate();
const skipped = []; // quantities on days the month doesn't have (e.g. a 31st column in November)
const tidy = (name) => String(name).replace(/\s+/g, ' ').trim();

const store = await call('GET', '/store');
const items = new Map(store.items.map((item) => [`${item.book}|${item.name.toLowerCase()}`, item]));
// Creates the item, or sets its price to this month's before recording the month.
async function itemFor(book, name, fields) {
  const key = `${book}|${tidy(name).toLowerCase()}`;
  const existing = items.get(key);
  if (!existing) { const { item } = await call('POST', '/store/items', { book, name: tidy(name), ...fields }); items.set(key, item); return item; }
  if (fields.unitCost !== undefined && Number(fields.unitCost) !== existing.unitCost) { const { item } = await call('PUT', `/store/items/${existing.id}`, { unitCost: fields.unitCost, ...(fields.par !== undefined ? { par: fields.par } : {}) }); items.set(key, item); return item; }
  return existing;
}
const expected = []; // [book, month, field, value] from the books, checked against the app at the end
const occupancy = new Map(); // date -> { minibar, amenities }

// ---------- Chemicals & tools: one total a month, guests and season in the sheet ----------
{
  const wb = XLSX.readFile(CHEM);
  for (const name of wb.SheetNames.filter((sheet) => sheet !== 'Dashboard')) {
    const ym = monthKey(name); const rows = rowsOf(wb, name);
    const lines = {};
    for (const row of rows.slice(3)) {
      if (/^TOTAL MONTHLY COST/i.test(row[0])) { expected.push(['chemicals', ym, 'totalCost', num(row[5])]); break; }
      if (!row[0]) continue;
      const item = await itemFor('chemicals', row[0], { category: row[1] || 'Chemical', unit: row[3] === '-' ? '' : row[3], unitCost: num(row[2]) });
      if (num(row[4])) lines[item.id] = num(row[4]);
    }
    await call('PUT', '/store/sheet', { book: 'chemicals', date: `${ym}-01`, kind: 'use', lines, note: 'Imported: month total from the Excel book' });
    const guests = rows.find((row) => /Number of Monthly Guests/i.test(row[0]));
    await call('PUT', `/store/months/${ym}`, { guests: guests ? Math.round(num(guests[4])) : null, season: /Low Season/i.test(rows[1][0]) ? 'low' : 'high' });
  }
  console.log('Chemicals & Tools imported.');
}

// ---------- Amenities and minibar: a quantity per item per day, occupied rooms per day ----------
for (const [book, file] of [['minibar', MINI], ['amenities', AMEN]]) {
  const wb = XLSX.readFile(file);
  for (const name of wb.SheetNames.filter((sheet) => sheet !== 'Dashboard')) {
    const ym = monthKey(name); const rows = rowsOf(wb, name);
    const header = rows[2]; const priceCol = header.indexOf('Price/Pcs'); const dayCols = header.map((cell, index) => [cell, index]).filter(([cell]) => Number.isInteger(cell));
    const perDay = new Map();
    for (const row of rows.slice(3)) {
      if (/^TOTAL MONTHLY COST/i.test(row[0])) { expected.push([book, ym, 'totalCost', num(row[row.length - 1])]); continue; }
      if (/^Occupied Rooms/i.test(row[0])) { for (const [day, index] of dayCols) if (row[index] !== '' && realDay(ym, day)) { const date = dayOf(ym, day); occupancy.set(date, { ...(occupancy.get(date) || {}), [book]: num(row[index]) }); } continue; }
      if (!row[0] || /^(Average|Daily|Cost on)/i.test(row[0])) continue;
      const item = await itemFor(book, row[0], { category: row[1], unit: 'pcs', unitCost: num(row[priceCol]) });
      for (const [day, index] of dayCols) if (num(row[index]) && !realDay(ym, day)) skipped.push({ where: `${book} ${ym} day ${day}`, cost: num(row[index]) * num(row[priceCol]) }); else if (num(row[index])) { if (!perDay.has(day)) perDay.set(day, {}); perDay.get(day)[item.id] = num(row[index]); }
    }
    for (const [day, lines] of perDay) await call('PUT', '/store/sheet', { book, date: dayOf(ym, day), kind: 'use', lines });
  }
  console.log(`${book === 'minibar' ? 'Minibar' : 'Amenities & Stationery'} imported.`);
}

// ---------- Room equipment & glassware: opening stock, deliveries, adjustments, daily use ----------
{
  const wb = XLSX.readFile(STOCK);
  const master = new Map(rowsOf(wb, 'Items').slice(3).filter((row) => row[1]).map((row) => [tidy(row[1]).toLowerCase(), { category: row[2], unitCost: num(row[3]), par: num(row[4]) }]));
  let previousClosing = null;
  for (const name of wb.SheetNames.filter((sheet) => /\d{4}$/.test(sheet))) {
    const rows = rowsOf(wb, name);
    const header = rows[4]; const dayCols = header.map((cell, index) => [cell, index]).filter(([cell, index]) => index >= 5 && Number.isFinite(cell) && cell > 40000);
    const ym = serialDate(dayCols[0][0]).slice(0, 7);
    const costCol = header.findIndex((cell) => /Unit Cost/i.test(cell)); const usageCol = header.findIndex((cell) => /Usage Cost/i.test(cell)); const closingCol = header.findIndex((cell) => /Closing/i.test(cell));
    const opening = {}; const received = {}; const adjust = {}; const perDay = new Map(); const closing = {};
    for (const row of rows.slice(5)) {
      // Item rows carry a serial number; the totals, stock value and the note under the table don't.
      if (/^TOTALS/i.test(row[1])) { expected.push(['equipment', ym, 'totalCost', num(row[usageCol])]); continue; }
      if (!row[1] || typeof row[0] !== 'number') continue;
      const info = master.get(tidy(row[1]).toLowerCase()) || {};
      const item = await itemFor('equipment', row[1], { category: info.category || 'Room Equipment', unit: 'pcs', unitCost: num(row[costCol]) || info.unitCost || 0, par: info.par ?? null });
      opening[item.id] = num(row[2]); if (num(row[3])) received[item.id] = num(row[3]); if (num(row[4])) adjust[item.id] = num(row[4]); closing[item.id] = num(row[closingCol]);
      for (const [serial, index] of dayCols) if (num(row[index])) { const date = serialDate(serial); if (!perDay.has(date)) perDay.set(date, {}); perDay.get(date)[item.id] = num(row[index]); }
    }
    // A count the day before the month whenever the sheet's opening stock isn't what last month closed at (and for the first month).
    const before = (() => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
    const recount = Object.fromEntries(Object.entries(opening).filter(([id, qty]) => !previousClosing || (previousClosing[id] ?? 0) !== qty));
    if (Object.keys(recount).length) await call('PUT', '/store/sheet', { book: 'equipment', date: before, kind: 'count', lines: recount, note: previousClosing ? 'Imported: opening stock differs from last month closing' : 'Imported: opening stock' });
    if (previousClosing && Object.keys(recount).length) console.log(`  ${ym}: opening stock differs from last month's closing for ${Object.keys(recount).length} item(s) — recorded as a stock count.`);
    if (Object.keys(received).length) await call('PUT', '/store/sheet', { book: 'equipment', date: `${ym}-01`, kind: 'receive', lines: received, note: 'Imported: month deliveries' });
    if (Object.keys(adjust).length) await call('PUT', '/store/sheet', { book: 'equipment', date: `${ym}-01`, kind: 'adjust', lines: adjust, note: 'Imported: month adjustments' });
    for (const [date, lines] of perDay) await call('PUT', '/store/sheet', { book: 'equipment', date, kind: 'use', lines });
    expected.push(['equipment', ym, 'closingQty', Object.values(closing).reduce((sum, qty) => sum + qty, 0)]);
    previousClosing = closing;
  }
  console.log('Room Equipment & Glassware imported.');
}

// ---------- Occupancy: one figure per day for the hotel ----------
// The amenities and minibar books each carry their own occupied-rooms row; where both have a day, the minibar figure is
// used (it is the more complete row), and days where the two disagree are listed.
const differences = [];
const daysToSave = {};
for (const [date, { minibar, amenities }] of [...occupancy.entries()].sort()) {
  daysToSave[date] = minibar ?? amenities;
  if (minibar !== undefined && amenities !== undefined && minibar !== amenities) differences.push(`${date}: minibar ${minibar}, amenities ${amenities}`);
}
await call('PUT', '/store/occupancy', { days: daysToSave });
console.log(`Occupancy imported for ${Object.keys(daysToSave).length} days; the two books disagree on ${differences.length} day(s).`);
if (differences.length) console.log(`  e.g. ${differences.slice(0, 5).join(' · ')}`);

if (skipped.length) {
  const byMonth = new Map();
  for (const { where, cost } of skipped) byMonth.set(where, (byMonth.get(where) || 0) + cost);
  console.log(`Left out ${skipped.length} quantities on days the month doesn't have: ${[...byMonth].map(([where, cost]) => `${where} (TZS ${Math.round(cost).toLocaleString('en')})`).join(', ')}.`);
}

// ---------- Check the app against the books ----------
let mismatches = 0;
for (const [book, ym, field, value] of expected) {
  const { report } = await call('GET', `/store/report?book=${book}&month=${ym}`);
  const got = field === 'closingQty' ? report.items.reduce((sum, row) => sum + row.closing, 0) : report.totalCost;
  const ok = Math.abs(got - value) < 1;
  if (!ok) mismatches++;
  console.log(`${ok ? 'MATCH   ' : 'MISMATCH'} ${book.padEnd(10)} ${ym} ${field.padEnd(10)} book ${Math.round(value).toLocaleString('en')}  app ${Math.round(got).toLocaleString('en')}`);
}
console.log(mismatches ? `${mismatches} figure(s) differ from the books.` : 'Every monthly figure matches the books.');
