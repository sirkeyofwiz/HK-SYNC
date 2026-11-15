// Reads the monthly stock Excel book ("MONTHLY CONSUMPTION AND STOCK") in the browser for Store availability:
//   Items sheet          each item's category and par stock
//   month sheets         "Nov 2025" … "Oct 2026": per item a Closing Stock column; the latest month is the stock now
// Returns { asOf: 'YYYY-MM-DD', month: 'Oct 2026', items: [{ name, category, par, inStock }] }, or throws with a message.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = (value) => tidy(value).toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const sheetMonth = (name) => { const found = tidy(name).match(/^([a-z]{3})[a-z]*\s+(\d{4})$/i); const m = found ? MONTHS.indexOf(found[1].toLowerCase()) + 1 : 0; return m ? `${found[2]}-${pad(m)}` : null; };
const lastDay = (ym) => `${ym}-${pad(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate())}`;

export function readStockBook(XLSX, workbook) {
  const rows = (name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '' });
  const headerAt = (table, ...words) => table.findIndex((row) => words.every((word) => row.some((cell) => key(cell).includes(word))));

  // Category and par stock from the Items sheet (optional: without it, items come in as "Other" with no par level).
  const master = new Map();
  const itemsSheet = workbook.SheetNames.find((name) => key(name) === 'items');
  if (itemsSheet) {
    const table = rows(itemsSheet);
    const head = headerAt(table, 'item', 'par');
    if (head >= 0) {
      const col = (word) => table[head].findIndex((cell) => key(cell).includes(word));
      const [nameCol, catCol, parCol] = [col('item'), col('category'), col('par')];
      for (const row of table.slice(head + 1)) if (tidy(row[nameCol])) master.set(key(row[nameCol]), { category: tidy(row[catCol]), par: row[parCol] === '' ? null : Number(row[parCol]) });
    }
  }

  // The latest month sheet that has a Closing Stock column.
  const monthSheets = workbook.SheetNames.map((name) => ({ name, ym: sheetMonth(name) })).filter((sheet) => sheet.ym).sort((a, b) => b.ym.localeCompare(a.ym));
  for (const sheet of monthSheets) {
    const table = rows(sheet.name);
    const head = headerAt(table, 'item', 'closing');
    if (head < 0) continue;
    const nameCol = table[head].findIndex((cell) => key(cell) === 'item');
    const closingCol = table[head].findIndex((cell) => key(cell).includes('closing'));
    const items = [];
    for (const row of table.slice(head + 1)) {
      const name = tidy(row[nameCol]);
      if (!name || /^totals?$/i.test(name)) break;
      const info = master.get(key(name)) || {};
      items.push({ name, category: info.category || 'Other', par: Number.isFinite(info.par) ? info.par : null, inStock: Math.max(0, Math.round(Number(row[closingCol]) || 0)) });
    }
    if (!items.length) continue;
    // "Recorded to 15 October 2026" next to the month means the counts are as of that day; otherwise the month's last day.
    const note = table.slice(0, head).flat().map(tidy).find((cell) => /recorded to/i.test(cell));
    const noted = note && new Date(`${note.replace(/.*recorded to/i, '').trim()} 12:00`);
    const asOf = noted && !Number.isNaN(noted.getTime()) ? `${noted.getFullYear()}-${pad(noted.getMonth() + 1)}-${pad(noted.getDate())}` : lastDay(sheet.ym);
    return { asOf, month: sheet.name, items };
  }
  throw new Error('This file has no month sheet with a "Closing Stock" column. Choose the monthly consumption and stock book.');
}
