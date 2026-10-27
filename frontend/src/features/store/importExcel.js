// Reads the four Excel store books in the browser and turns them into one import for POST /api/store/import, plus the
// books' own monthly totals so the app can check its figures against them afterwards. Each file is recognised by what
// is inside it, so they can be chosen in any order and with any name.
//   Chemicals & Tools       a month a sheet, "Qty Used" per item (one total for the month), guests and season
//   Amenities / Minibar     a month a sheet, a quantity per item per day, occupied rooms per day
//   Monthly stock (equipment)  an "Items" sheet with prices and par, and per month opening, received, adjustment, daily use
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const num = (value) => (value === '' || value === null || value === undefined ? 0 : Number(value) || 0);
const tidy = (name) => String(name).replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const realDay = (ym, day) => day <= new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate();
const serialDate = (serial) => new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
const dayBefore = (ym) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

export const BOOK_FILES = { chemicals: 'Chemical & Tools', amenities: 'Amenities & Stationery', minibar: 'Minibar', equipment: 'Monthly consumption & stock' };

// Which book a workbook is, from its sheets.
export function recognise(XLSX, workbook) {
  const rows = (name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '' });
  if (workbook.SheetNames.includes('Items') && workbook.SheetNames.some((name) => /\d{4}$/.test(name))) return 'equipment';
  const title = String(rows(workbook.SheetNames[0])[0]?.[0] || '');
  if (/minibar/i.test(title)) return 'minibar';
  if (/amenit/i.test(title)) return 'amenities';
  if (/chemical/i.test(title)) return 'chemicals';
  return null;
}

// The books run from November to October; a month sheet named "November" belongs to the year the book starts.
const bookMonth = (name, startYear) => { const m = MONTHS.indexOf(name.trim().slice(0, 3).toLowerCase()) + 1; return m ? `${m >= 11 ? startYear : startYear + 1}-${pad(m)}` : null; };
const startYearOf = (rows) => { const found = String(rows[1]?.[0] || '').match(/(20\d\d)/); return found ? Number(found[1]) : null; };

export function buildImport(XLSX, workbooks) {
  const items = new Map(); // key -> item (unitCost ends as the latest month's price)
  const sheets = [];
  const expected = []; // { book, month, value } monthly totals as the books have them
  const skipped = []; // quantities on days a month doesn't have
  const occupancy = new Map(); // date -> { minibar, amenities }
  const months = {};
  const rowsOf = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
  const item = (book, name, fields) => {
    const key = `${book}|${tidy(name).toLowerCase()}`;
    items.set(key, { ...(items.get(key) || {}), key, book, name: tidy(name), ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== '')) });
    return key;
  };

  if (workbooks.chemicals) {
    const wb = workbooks.chemicals;
    const startYear = startYearOf(rowsOf(wb, wb.SheetNames[0])) || 2025;
    for (const name of wb.SheetNames.filter((sheet) => sheet !== 'Dashboard')) {
      const ym = bookMonth(name, startYear); if (!ym) continue;
      const rows = rowsOf(wb, name); const lines = {};
      for (const row of rows.slice(3)) {
        if (/^TOTAL MONTHLY COST/i.test(row[0])) { expected.push({ book: 'chemicals', month: ym, value: num(row[5]) }); break; }
        if (!row[0]) continue;
        const key = item('chemicals', row[0], { category: row[1] || 'Chemical', unit: row[3] === '-' ? '' : row[3], unitCost: num(row[2]) });
        if (num(row[4])) lines[key] = { qty: num(row[4]), price: num(row[2]) };
      }
      sheets.push({ book: 'chemicals', date: `${ym}-01`, kind: 'use', lines, note: 'Imported: month total from the Excel book' });
      const guests = rows.find((row) => /Number of Monthly Guests/i.test(row[0]));
      months[ym] = { ...(guests ? { guests: Math.round(num(guests[4])) } : {}), season: /Low Season/i.test(rows[1]?.[0]) ? 'low' : 'high' };
    }
  }

  for (const book of ['minibar', 'amenities']) {
    const wb = workbooks[book]; if (!wb) continue;
    const startYear = startYearOf(rowsOf(wb, wb.SheetNames[0])) || 2025;
    for (const name of wb.SheetNames.filter((sheet) => sheet !== 'Dashboard')) {
      const ym = bookMonth(name, startYear); if (!ym) continue;
      const rows = rowsOf(wb, name);
      const header = rows[2] || []; const priceCol = header.indexOf('Price/Pcs'); const dayCols = header.map((cell, index) => [cell, index]).filter(([cell]) => Number.isInteger(cell));
      const perDay = new Map();
      for (const row of rows.slice(3)) {
        if (/^TOTAL MONTHLY COST/i.test(row[0])) { expected.push({ book, month: ym, value: num(row[row.length - 1]) }); continue; }
        if (/^Occupied Rooms/i.test(row[0])) { for (const [day, index] of dayCols) if (row[index] !== '' && realDay(ym, day)) { const date = `${ym}-${pad(day)}`; occupancy.set(date, { ...(occupancy.get(date) || {}), [book]: num(row[index]) }); } continue; }
        if (!row[0] || /^(Average|Daily|Cost on)/i.test(row[0])) continue;
        const price = num(row[priceCol]);
        const key = item(book, row[0], { category: row[1], unit: 'pcs', unitCost: price });
        for (const [day, index] of dayCols) {
          if (!num(row[index])) continue;
          if (!realDay(ym, day)) { skipped.push({ book, month: ym, day, cost: num(row[index]) * price }); continue; }
          if (!perDay.has(day)) perDay.set(day, {});
          perDay.get(day)[key] = { qty: num(row[index]), price };
        }
      }
      for (const [day, lines] of perDay) sheets.push({ book, date: `${ym}-${pad(day)}`, kind: 'use', lines });
    }
  }

  if (workbooks.equipment) {
    const wb = workbooks.equipment;
    const master = new Map(rowsOf(wb, 'Items').slice(3).filter((row) => row[1]).map((row) => [tidy(row[1]).toLowerCase(), { category: row[2], unitCost: num(row[3]), par: num(row[4]) }]));
    let previousClosing = null;
    for (const name of wb.SheetNames.filter((sheet) => /\d{4}$/.test(sheet))) {
      const rows = rowsOf(wb, name);
      const header = rows[4] || []; const dayCols = header.map((cell, index) => [cell, index]).filter(([cell, index]) => index >= 5 && Number.isFinite(cell) && cell > 40000);
      if (!dayCols.length) continue;
      const ym = serialDate(dayCols[0][0]).slice(0, 7);
      const costCol = header.findIndex((cell) => /Unit Cost/i.test(cell)); const usageCol = header.findIndex((cell) => /Usage Cost/i.test(cell)); const closingCol = header.findIndex((cell) => /Closing/i.test(cell));
      const opening = {}; const received = {}; const adjust = {}; const perDay = new Map(); const closing = {};
      for (const row of rows.slice(5)) {
        // Item rows carry a serial number; the totals, stock value and the note under the table don't.
        if (/^TOTALS/i.test(row[1])) { expected.push({ book: 'equipment', month: ym, value: num(row[usageCol]) }); continue; }
        if (!row[1] || typeof row[0] !== 'number') continue;
        const info = master.get(tidy(row[1]).toLowerCase()) || {};
        const price = num(row[costCol]) || info.unitCost || 0;
        const key = item('equipment', row[1], { category: info.category || 'Room Equipment', unit: 'pcs', unitCost: price, par: info.par });
        opening[key] = { qty: num(row[2]), price }; closing[key] = num(row[closingCol]);
        if (num(row[3])) received[key] = { qty: num(row[3]), price };
        if (num(row[4])) adjust[key] = { qty: num(row[4]), price };
        for (const [serial, index] of dayCols) if (num(row[index])) { const date = serialDate(serial); if (!perDay.has(date)) perDay.set(date, {}); perDay.get(date)[key] = { qty: num(row[index]), price }; }
      }
      // A stock count the day before the month, for the first month and whenever its opening isn't what last month closed at.
      const recount = Object.fromEntries(Object.entries(opening).filter(([key, line]) => !previousClosing || (previousClosing[key] ?? 0) !== line.qty));
      if (Object.keys(recount).length) sheets.push({ book: 'equipment', date: dayBefore(ym), kind: 'count', lines: recount, note: previousClosing ? 'Imported: opening stock differs from last month closing' : 'Imported: opening stock' });
      if (Object.keys(received).length) sheets.push({ book: 'equipment', date: `${ym}-01`, kind: 'receive', lines: received, note: 'Imported: month deliveries' });
      if (Object.keys(adjust).length) sheets.push({ book: 'equipment', date: `${ym}-01`, kind: 'adjust', lines: adjust, note: 'Imported: month adjustments' });
      for (const [date, lines] of perDay) sheets.push({ book: 'equipment', date, kind: 'use', lines });
      previousClosing = closing;
    }
  }

  // One occupancy figure a day: the minibar book's where it has one (its row is the more complete), else the amenities book's.
  const days = {}; const disagreements = [];
  for (const [date, { minibar, amenities }] of [...occupancy.entries()].sort()) {
    days[date] = minibar ?? amenities;
    if (minibar !== undefined && amenities !== undefined && minibar !== amenities) disagreements.push({ date, minibar, amenities });
  }
  return { payload: { items: [...items.values()], sheets, days, months }, expected, skipped, disagreements };
}
