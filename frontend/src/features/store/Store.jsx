import { useEffect, useMemo, useState } from 'react';
import { Empty } from '../../components/ui';
import { buildImport, recognise } from './importExcel';

// Housekeeping store: the four store books the team kept in Excel, recorded day by day in the app, with the same
// monthly and season reports. The server (backend/store.js) does every calculation; these screens record and show.
const KINDS = [['use', 'Used'], ['receive', 'Received'], ['adjust', 'Adjustment ±'], ['count', 'Stock count']];
const KIND_HELP = {
  use: 'What left the store today. Leave an item empty if none was used.',
  receive: 'Deliveries that came in today, at the price on the item.',
  adjust: 'Losses, breakages and corrections. Use a minus for items gone, e.g. -2.',
  count: 'What is on the shelf at the end of today. The app sets the stock to this and shows any difference.'
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const tzs = (value) => (value === null || value === undefined ? '—' : Math.round(value).toLocaleString('en-US'));
const qtyText = (value) => (value ? (Math.round(value * 100) / 100).toLocaleString('en-US') : '–');
const monthLabel = (ym) => `${MONTH_NAMES[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
const shortMonth = (ym) => `${MONTH_NAMES[Number(ym.slice(5)) - 1].slice(0, 3)} ${ym.slice(2, 4)}`;
const shiftMonth = (ym, by) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + by, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const pct = (value) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`);
// "12% over" / "3% under" for a cost against its budget.
const overUnder = (cost, budget) => (budget ? `${Math.abs(Math.round(((cost - budget) / budget) * 100))}% ${cost > budget ? 'over' : 'under'}` : '');

function BookPicker({ books, book, setBook, all = false }) {
  return <div className="segmented store-books" role="tablist" aria-label="Store book">{[...(all ? [['all', { short: 'All books' }]] : []), ...Object.entries(books)].map(([key, info]) => <button type="button" role="tab" key={key} aria-selected={book === key} className={book === key ? 'active' : ''} onClick={() => setBook(key)}>{info.short}</button>)}</div>;
}
function MonthPicker({ month, setMonth, max }) {
  return <div className="store-month"><button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button><input type="month" value={month} max={max} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" /><button type="button" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= max} aria-label="Next month">›</button></div>;
}
function Tile({ label, value, note, tone = '' }) {
  return <div className="store-tile"><small>{label}</small><strong className={tone}>{value}</strong>{note && <small>{note}</small>}</div>;
}
const excel = async (sheets, name, saveExport) => {
  const { utils, write } = await import('xlsx');
  const workbook = utils.book_new();
  for (const [title, rows] of sheets) utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), title.slice(0, 31));
  await saveExport(new Blob([write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
};

// ---------- Record: one book, one day, one kind of movement ----------
function RecordTab({ config, book, request, flash }) {
  const [date, setDate] = useState(config.today);
  const [kind, setKind] = useState('use');
  const [day, setDay] = useState(null);
  const [lines, setLines] = useState({});
  const [rooms, setRooms] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const items = config.items.filter((item) => item.book === book && item.active !== false);
  const load = async () => { const data = await request(`/store/day?book=${book}&date=${date}`); setDay(data); setRooms(data.rooms ?? ''); };
  useEffect(() => { setDay(null); load().catch((error) => flash(error.message)); }, [book, date]);
  useEffect(() => { const saved = day?.sheets?.[kind]?.lines || {}; setLines(Object.fromEntries(Object.entries(saved).map(([id, line]) => [id, String(line.qty)]))); }, [day, kind]);
  const saved = day?.sheets?.[kind];
  const dirty = JSON.stringify(Object.fromEntries(Object.entries(lines).filter(([, value]) => value !== ''))) !== JSON.stringify(Object.fromEntries(Object.entries(saved?.lines || {}).map(([id, line]) => [id, String(line.qty)]))) || String(rooms) !== String(day?.rooms ?? '');
  const shown = items.filter((item) => !search || item.name.toLowerCase().includes(search.toLowerCase()));
  const categories = [...new Set(shown.map((item) => item.category))];
  const value = items.reduce((sum, item) => sum + (Number(lines[item.id]) || 0) * item.unitCost, 0);
  const entered = items.filter((item) => lines[item.id] !== undefined && lines[item.id] !== '').length;
  const save = async () => {
    setBusy(true);
    try {
      await request('/store/sheet', { method: 'PUT', body: JSON.stringify({ book, date, kind, lines }) });
      if (String(rooms) !== String(day?.rooms ?? '')) await request('/store/occupancy', { method: 'PUT', body: JSON.stringify({ days: { [date]: rooms === '' ? null : Number(rooms) } }) });
      await load(); flash(`${KINDS.find(([key]) => key === kind)[1]} saved for ${new Date(`${date}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })}.`);
    } catch (error) { flash(error.message); } finally { setBusy(false); }
  };
  const kinds = KINDS.filter(([key]) => config.books[book].stock || !['count'].includes(key));
  return <section className="panel store-record">
    <div className="store-record-top">
      <label>Date<input type="date" value={date} max={config.today} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
      <label>Occupied rooms that day<input type="number" min="0" inputMode="numeric" value={rooms} onChange={(e) => setRooms(e.target.value)} placeholder="e.g. 152" /></label>
      <div className="segmented store-kinds" role="tablist" aria-label="What are you recording">{kinds.map(([key, label]) => <button type="button" role="tab" key={key} aria-selected={kind === key} className={kind === key ? 'active' : ''} onClick={() => setKind(key)}>{label}{day?.sheets?.[key] ? ' ●' : ''}</button>)}</div>
    </div>
    <p className="muted store-help">{KIND_HELP[kind]}</p>
    {!day ? <Empty text="Loading…" /> : !items.length ? <Empty text="No items in this book yet. Add them under Items." /> : <>
      <input className="store-search" type="search" placeholder={`Search ${items.length} items`} value={search} onChange={(e) => setSearch(e.target.value)} />
      {categories.map((category) => <div key={category} className="store-group"><p className="kicker">{category}</p>{shown.filter((item) => item.category === category).map((item) => <label key={item.id} className={`store-line ${lines[item.id] ? 'has' : ''}`}><span><b>{item.name}</b><small>{[item.unit, `TZS ${tzs(item.unitCost)}`].filter(Boolean).join(' · ')}</small></span><input type="number" inputMode="decimal" step="any" min={kind === 'adjust' ? undefined : 0} value={lines[item.id] ?? ''} placeholder="0" aria-label={`${item.name} quantity`} onChange={(e) => setLines({ ...lines, [item.id]: e.target.value })} /></label>)}</div>)}
      <div className="store-save"><span>{entered} {entered === 1 ? 'item' : 'items'}{kind === 'use' || kind === 'receive' ? ` · TZS ${tzs(value)}` : ''}{saved ? ` · last saved ${new Date(saved.updatedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span><button type="button" className="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
    </>}
  </section>;
}

// ---------- Month report ----------
function MonthTab({ config, book, request, flash, saveExport }) {
  const [month, setMonth] = useState(config.today.slice(0, 7));
  const [report, setReport] = useState(null);
  const [grid, setGrid] = useState(false);
  useEffect(() => { setReport(null); request(`/store/report?book=${book}&month=${month}`).then((data) => setReport(data.report)).catch((error) => flash(error.message)); }, [book, month]);
  const info = config.books[book];
  const stock = info.stock;
  const k = report?.kpis;
  const exportMonth = () => {
    const head = ['Item', 'Category', 'Unit', 'Unit cost (TZS)', ...(stock ? ['Opening', 'Received', 'Adjustment'] : []), 'Qty used', 'Cost (TZS)', ...(stock ? ['Closing', 'Par', 'Status'] : [])];
    const rows = report.items.map((row) => [row.name, row.category, row.unit, row.unitCost, ...(stock ? [row.opening, row.received, row.adjust + row.countDiff] : []), row.used, row.cost, ...(stock ? [row.closing, row.par ?? '', row.reorder ? 'REORDER' : 'OK'] : [])]);
    const days = Array.from({ length: report.days }, (_, index) => index + 1);
    const daily = [['Item', ...days, 'Total'], ...report.items.map((row) => [row.name, ...row.daily.map((value) => value || ''), row.used]), ['Daily cost (TZS)', ...report.dailyCost, report.totalCost], ['Occupied rooms', ...report.occupied.map((value) => value ?? '')]];
    excel([[`${info.short} ${month}`, [[`${info.name} — ${monthLabel(month)}`], [], head, ...rows, ['TOTAL', '', '', '', ...(stock ? ['', '', ''] : []), '', report.totalCost]]], ['Day by day', daily]], `hk-sync-${book}-${month}.xlsx`, saveExport).catch((error) => flash(error.message));
  };
  return <section className="panel store-report">
    <div className="store-bar"><MonthPicker month={month} setMonth={setMonth} max={config.today.slice(0, 7)} /><div className="store-bar-actions">{report && <button type="button" className={`secondary ${grid ? 'on' : ''}`} onClick={() => setGrid(!grid)}>{grid ? 'Item totals' : 'Day by day'}</button>}{report && <button type="button" className="secondary" onClick={exportMonth}>↓ Excel</button>}</div></div>
    {!report || report.book !== book || report.month !== month ? <Empty text="Loading…" /> : <>
      <div className="store-tiles">
        <Tile label="Total cost" value={`TZS ${tzs(report.totalCost)}`} note={monthLabel(month)} />
        {info.kpi === 'guests' && <><Tile label="Cost per guest" value={k.costPerGuest ? `TZS ${tzs(k.costPerGuest)}` : '—'} note={k.guests ? `${tzs(k.guests)} guests` : 'Enter guests under Occupancy'} /><Tile label="Guest budget" value={k.occupancyBudget !== null ? `TZS ${tzs(k.occupancyBudget)}` : '—'} note={k.occupancyBudget ? overUnder(report.totalCost, k.occupancyBudget) : `USD ${config.settings.chemicals.perGuestUsd} per guest`} tone={k.occupancyVariance > 0 ? 'red-text' : 'green-text'} /><Tile label={`Fixed budget · ${k.season} season`} value={`TZS ${tzs(k.fixedBudget)}`} note={overUnder(report.totalCost, k.fixedBudget)} tone={k.fixedVariance > 0 ? 'red-text' : 'green-text'} /></>}
        {info.kpi === 'roomNights' && <><Tile label="Cost per occupied room-night" value={k.costPerRoomNight ? `TZS ${tzs(k.costPerRoomNight)}` : '—'} note={k.daysWithData ? `${k.daysWithData} of ${report.days} days with occupancy` : 'Enter occupied rooms'} /><Tile label="Average occupied rooms" value={k.avgRooms ?? '—'} note={`${tzs(k.roomNights)} room-nights`} /><Tile label="Biggest category" value={[...report.categories].sort((a, b) => b.cost - a.cost)[0]?.category || '—'} note={`TZS ${tzs([...report.categories].sort((a, b) => b.cost - a.cost)[0]?.cost)}`} /></>}
        {info.kpi === 'stock' && <><Tile label="Stock value" value={`TZS ${tzs(k.closingValue)}`} note={`opened at TZS ${tzs(k.openingValue)}`} /><Tile label="Bought this month" value={`TZS ${tzs(k.receivedValue)}`} note={`budget TZS ${tzs(k.purchaseBudget)}${k.purchaseBudget ? ` · ${overUnder(k.receivedValue, k.purchaseBudget)}` : ''}`} tone={k.receivedVsBudget > 0 ? 'red-text' : ''} /><Tile label="Items to reorder" value={k.itemsToReorder} note="closing stock below par" tone={k.itemsToReorder ? 'red-text' : 'green-text'} /></>}
      </div>
      <div className="store-cats">{report.categories.filter((entry) => entry.cost).map((entry) => <span key={entry.category}>{entry.category} <b>TZS {tzs(entry.cost)}</b></span>)}</div>
      {!grid ? <div className="store-table-wrap"><table className="store-table">
        <thead><tr><th>Item</th><th className="num">Unit cost</th>{stock && <><th className="num">Opening</th><th className="num">Received</th><th className="num">Adj.</th></>}<th className="num">Used</th><th className="num">Cost (TZS)</th>{stock && <><th className="num">Closing</th><th className="num">Par</th><th>Status</th></>}</tr></thead>
        <tbody>{report.items.map((row) => <tr key={row.id} className={row.used ? '' : 'quiet'}><td><b>{row.name}</b><small>{[row.category, row.unit].filter(Boolean).join(' · ')}</small></td><td className="num">{tzs(row.unitCost)}</td>{stock && <><td className="num">{qtyText(row.opening)}</td><td className="num">{qtyText(row.received)}</td><td className="num">{qtyText(row.adjust + row.countDiff)}</td></>}<td className="num"><b>{qtyText(row.used)}</b></td><td className="num">{tzs(row.cost)}</td>{stock && <><td className="num">{qtyText(row.closing)}</td><td className="num">{row.par ?? '—'}</td><td>{row.par !== null && row.par !== undefined ? <span className={`badge ${row.reorder ? 'danger' : 'good'}`}>{row.reorder ? 'Reorder' : 'OK'}</span> : ''}</td></>}</tr>)}</tbody>
        <tfoot><tr><td>Total</td><td />{stock && <><td className="num">{qtyText(report.items.reduce((s, r) => s + r.opening, 0))}</td><td className="num">{qtyText(report.items.reduce((s, r) => s + r.received, 0))}</td><td /></>}<td className="num">{qtyText(report.items.reduce((s, r) => s + r.used, 0))}</td><td className="num">{tzs(report.totalCost)}</td>{stock && <><td className="num">{qtyText(report.items.reduce((s, r) => s + r.closing, 0))}</td><td /><td /></>}</tr></tfoot>
      </table></div> : <div className="store-table-wrap"><table className="store-table store-grid">
        <thead><tr><th>Item</th>{report.dailyCost.map((_, index) => <th key={index} className="num">{index + 1}</th>)}<th className="num">Total</th></tr></thead>
        <tbody>{report.items.filter((row) => row.used).map((row) => <tr key={row.id}><td><b>{row.name}</b></td>{row.daily.map((value, index) => <td key={index} className="num">{value || ''}</td>)}<td className="num"><b>{qtyText(row.used)}</b></td></tr>)}</tbody>
        <tfoot><tr><td>Daily cost</td>{report.dailyCost.map((value, index) => <td key={index} className="num">{value ? tzs(value / 1000) + 'k' : ''}</td>)}<td className="num">{tzs(report.totalCost)}</td></tr><tr><td>Occupied rooms</td>{report.occupied.map((value, index) => <td key={index} className="num">{value ?? ''}</td>)}<td /></tr></tfoot>
      </table></div>}
    </>}
  </section>;
}

// ---------- Season: twelve months, like the Excel dashboards ----------
function SeasonTab({ config, book, request, flash, saveExport }) {
  const [to, setTo] = useState(config.today.slice(0, 7));
  const [season, setSeason] = useState(null);
  useEffect(() => { setSeason(null); request(`/store/season?book=${book}&to=${to}`).then((data) => setSeason(data.season)).catch((error) => flash(error.message)); }, [book, to]);
  // Until the newly chosen book's figures arrive, the previous book's (a different shape for All books) aren't drawn.
  if (!season || season.book !== book || season.to !== to) return <section className="panel"><MonthPicker month={to} setMonth={setTo} max={config.today.slice(0, 7)} /><Empty text="Loading…" /></section>;
  const range = `${shortMonth(season.from)} – ${shortMonth(season.to)}`;
  if (book === 'all') {
    const months = season.books[0].months.map((entry) => entry.month);
    const totals = months.map((_, index) => season.books.reduce((sum, entry) => sum + entry.months[index].totalCost, 0));
    const peak = Math.max(1, ...totals);
    return <section className="panel store-report"><div className="store-bar"><MonthPicker month={to} setMonth={setTo} max={config.today.slice(0, 7)} /><span className="muted">{range}</span></div>
      <div className="store-bars stacked">{months.map((month, index) => <div key={month} title={`${monthLabel(month)}: TZS ${tzs(totals[index])}`}><span className="stack" style={{ height: `${(totals[index] / peak) * 100}%` }}>{season.books.map((entry, b) => <i key={entry.book} className={`book-${b}`} style={{ flex: entry.months[index].totalCost || 0 }} />)}</span><small>{shortMonth(month).slice(0, 3)}</small></div>)}</div>
      <div className="store-legend">{season.books.map((entry, b) => <span key={entry.book}><i className={`book-${b}`} />{config.books[entry.book].short}</span>)}</div>
      <div className="store-table-wrap"><table className="store-table"><thead><tr><th>Month</th>{season.books.map((entry) => <th key={entry.book} className="num">{config.books[entry.book].short}</th>)}<th className="num">All books</th></tr></thead>
        <tbody>{months.map((month, index) => <tr key={month}><td><b>{monthLabel(month)}</b></td>{season.books.map((entry) => <td key={entry.book} className="num">{tzs(entry.months[index].totalCost)}</td>)}<td className="num"><b>{tzs(totals[index])}</b></td></tr>)}</tbody>
        <tfoot><tr><td>Total</td>{season.books.map((entry) => <td key={entry.book} className="num">{tzs(entry.totalCost)}</td>)}<td className="num">{tzs(totals.reduce((a, b) => a + b, 0))}</td></tr></tfoot></table></div>
    </section>;
  }
  const info = config.books[book];
  const peak = Math.max(1, ...season.months.map((m) => Math.max(m.totalCost, info.kpi === 'guests' ? m.occupancyBudget || 0 : 0)));
  const columns = info.kpi === 'guests' ? [['Guests', (m) => tzs(m.guests)], ['Guest budget', (m) => tzs(m.occupancyBudget)], ['vs budget', (m) => (m.occupancyBudget ? pct(m.occupancyVariance / m.occupancyBudget) : '—'), (m) => (m.occupancyVariance > 0 ? 'red-text' : 'green-text')], ['Cost / guest', (m) => tzs(m.costPerGuest)]]
    : info.kpi === 'roomNights' ? [['Room-nights', (m) => tzs(m.roomNights)], ['Avg rooms', (m) => m.avgRooms ?? '—'], ['Cost / room-night', (m) => tzs(m.costPerRoomNight)]]
      : [['Bought', (m) => tzs(m.receivedValue)], ['Purchase budget', (m) => tzs(m.purchaseBudget)], ['Stock value', (m) => tzs(m.closingValue)], ['To reorder', (m) => m.itemsToReorder]];
  const exportSeason = () => excel([[`${info.short} season`, [[`${info.name} — ${range}`], [], ['Month', 'Cost (TZS)', ...columns.map(([label]) => label)], ...season.months.map((m) => [monthLabel(m.month), m.totalCost, ...columns.map(([, value]) => value(m))]), ['TOTAL', season.totals.totalCost], [], ['Top 10 items', 'Cost (TZS)'], ...season.topItems.map((entry) => [entry.name, entry.cost]), [], ['Category', 'Cost (TZS)'], ...season.categories.map((entry) => [entry.category, entry.cost])]]], `hk-sync-${book}-season-${to}.xlsx`, saveExport).catch((error) => flash(error.message));
  const topPeak = Math.max(1, ...season.topItems.map((entry) => entry.cost));
  return <section className="panel store-report">
    <div className="store-bar"><MonthPicker month={to} setMonth={setTo} max={config.today.slice(0, 7)} /><span className="muted">{range}</span><div className="store-bar-actions"><button type="button" className="secondary" onClick={exportSeason}>↓ Excel</button></div></div>
    <div className="store-tiles">
      <Tile label="Season cost" value={`TZS ${tzs(season.totals.totalCost)}`} note={range} />
      {info.kpi === 'guests' && <><Tile label="Cost per guest" value={`TZS ${tzs(season.totals.costPerGuest)}`} note={`${tzs(season.totals.guests)} guests`} /><Tile label="vs guest budget" value={overUnder(season.totals.totalCost, season.totals.occupancyBudget) || '—'} note={`budget TZS ${tzs(season.totals.occupancyBudget)}`} tone={season.totals.totalCost > season.totals.occupancyBudget ? 'red-text' : 'green-text'} /></>}
      {info.kpi === 'roomNights' && <Tile label="Cost per occupied room-night" value={`TZS ${tzs(season.totals.costPerRoomNight)}`} note={`${tzs(season.totals.roomNights)} room-nights`} />}
      {info.kpi === 'stock' && <Tile label="Bought vs budget" value={`TZS ${tzs(season.totals.receivedValue)}`} note={`budget TZS ${tzs(season.totals.purchaseBudget)}`} tone={season.totals.receivedValue > season.totals.purchaseBudget ? 'red-text' : ''} />}
    </div>
    <div className="store-bars">{season.months.map((m) => <div key={m.month} title={`${monthLabel(m.month)}: TZS ${tzs(m.totalCost)}`}><span style={{ height: `${(m.totalCost / peak) * 100}%` }} className={info.kpi === 'guests' && m.occupancyBudget && m.totalCost > m.occupancyBudget ? 'over' : ''} />{info.kpi === 'guests' && m.occupancyBudget ? <em style={{ bottom: `calc(${(m.occupancyBudget / peak) * 100}% + 18px)` }} title={`Budget TZS ${tzs(m.occupancyBudget)}`} /> : null}<small>{shortMonth(m.month).slice(0, 3)}</small></div>)}</div>
    {info.kpi === 'guests' && <p className="muted store-note">Bars: cost each month (red when over budget). Line: guest budget (guests × USD {config.settings.chemicals.perGuestUsd} × {config.settings.exchangeRate}).</p>}
    <div className="store-table-wrap"><table className="store-table"><thead><tr><th>Month</th><th className="num">Cost (TZS)</th>{columns.map(([label]) => <th key={label} className="num">{label}</th>)}</tr></thead>
      <tbody>{season.months.map((m) => <tr key={m.month}><td><b>{monthLabel(m.month)}</b></td><td className="num">{tzs(m.totalCost)}</td>{columns.map(([label, value, tone]) => <td key={label} className={`num ${tone ? tone(m) : ''}`}>{value(m)}</td>)}</tr>)}</tbody>
      <tfoot><tr><td>Total</td><td className="num">{tzs(season.totals.totalCost)}</td>{columns.map(([label]) => <td key={label} />)}</tr></tfoot></table></div>
    <div className="store-two">
      <div><p className="kicker">TOP 10 ITEMS BY COST</p>{season.topItems.map((entry) => <div className="store-rank" key={entry.name}><span>{entry.name}</span><i style={{ width: `${(entry.cost / topPeak) * 100}%` }} /><b>{tzs(entry.cost)}</b></div>)}{!season.topItems.length && <Empty text="Nothing used in this period." />}</div>
      <div><p className="kicker">COST BY CATEGORY</p>{season.categories.map((entry) => <div className="store-rank" key={entry.category}><span>{entry.category}</span><i style={{ width: `${(entry.cost / Math.max(1, season.categories[0]?.cost || 1)) * 100}%` }} /><b>{tzs(entry.cost)}</b></div>)}</div>
    </div>
  </section>;
}

// ---------- Items ----------
function ItemsTab({ config, book, request, reload, flash }) {
  const info = config.books[book];
  const items = config.items.filter((item) => item.book === book);
  const blank = { name: '', category: info.categories[0], unit: '', unitCost: '', par: '' };
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  useEffect(() => { setDraft(blank); setEditing(null); }, [book]);
  const categories = [...new Set([...info.categories, ...items.map((item) => item.category)])];
  const submit = async (event) => {
    event.preventDefault();
    try {
      const body = { ...draft, unitCost: Number(draft.unitCost) || 0, par: info.stock ? draft.par : undefined };
      if (editing) await request(`/store/items/${editing}`, { method: 'PUT', body: JSON.stringify(body) }); else await request('/store/items', { method: 'POST', body: JSON.stringify({ ...body, book }) });
      flash(editing ? `${draft.name} updated.` : `${draft.name} added.`); setDraft(blank); setEditing(null); await reload();
    } catch (error) { flash(error.message); }
  };
  const toggle = async (item) => { try { await request(`/store/items/${item.id}`, { method: 'PUT', body: JSON.stringify({ active: item.active === false }) }); await reload(); } catch (error) { flash(error.message); } };
  const listed = items.filter((item) => showInactive || item.active !== false);
  return <section className="panel store-items">
    <form className="store-item-form" onSubmit={submit}>
      <p className="kicker">{editing ? 'EDIT ITEM' : `ADD AN ITEM TO ${info.name.toUpperCase()}`}</p>
      <label>Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={80} /></label>
      <label>Category<input list="store-categories" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} required /><datalist id="store-categories">{categories.map((category) => <option key={category} value={category} />)}</datalist></label>
      <label>Unit<input value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} placeholder="e.g. gallon 20 lt, pcs" maxLength={30} /></label>
      <label>Unit cost (TZS)<input type="number" min="0" step="any" inputMode="decimal" value={draft.unitCost} onChange={(e) => setDraft({ ...draft, unitCost: e.target.value })} required /></label>
      {info.stock && <label>Par stock<input type="number" min="0" inputMode="numeric" value={draft.par ?? ''} onChange={(e) => setDraft({ ...draft, par: e.target.value })} placeholder="reorder below" /></label>}
      <div className="store-item-actions">{editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setDraft(blank); }}>Cancel</button>}<button className="primary">{editing ? 'Save item' : '＋ Add item'}</button></div>
      <small className="muted">A new price applies from now on; months already recorded keep the price they had.</small>
    </form>
    <div className="store-bar"><span className="muted">{items.filter((item) => item.active !== false).length} items in use{items.some((item) => item.active === false) ? ` · ${items.filter((item) => item.active === false).length} no longer used` : ''}</span>{items.some((item) => item.active === false) && <label className="store-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show items no longer used</label>}</div>
    <div className="store-table-wrap"><table className="store-table"><thead><tr><th>Item</th><th>Unit</th><th className="num">Unit cost</th>{info.stock && <th className="num">Par</th>}<th /></tr></thead>
      <tbody>{listed.map((item) => <tr key={item.id} className={item.active === false ? 'quiet' : ''}><td><b>{item.name}</b><small>{item.category}</small></td><td>{item.unit || '—'}</td><td className="num">{tzs(item.unitCost)}</td>{info.stock && <td className="num">{item.par ?? '—'}</td>}<td className="store-row-actions"><button type="button" className="text" onClick={() => { setEditing(item.id); setDraft({ name: item.name, category: item.category, unit: item.unit || '', unitCost: item.unitCost, par: item.par ?? '' }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>✎ Edit</button><button type="button" className="text" onClick={() => toggle(item)}>{item.active === false ? 'Use again' : 'Stop using'}</button></td></tr>)}</tbody></table></div>
    {!listed.length && <Empty text="No items yet." />}
  </section>;
}

// ---------- Occupancy and budgets ----------
function OccupancyTab({ config, request, reload, flash }) {
  const [month, setMonth] = useState(config.today.slice(0, 7));
  const [data, setData] = useState(null);
  const [rooms, setRooms] = useState({});
  const [guests, setGuests] = useState('');
  const [season, setSeason] = useState('');
  const [budget, setBudget] = useState(config.settings);
  const load = () => request(`/store/occupancy?month=${month}`).then((result) => { setData(result); setRooms(result.days); setGuests(result.guests ?? ''); setSeason(result.seasonSet ? result.season : ''); }).catch((error) => flash(error.message));
  useEffect(() => { setData(null); load(); }, [month]);
  const [y, m] = month.split('-').map(Number);
  const dayCount = new Date(y, m, 0).getDate();
  const dates = Array.from({ length: dayCount }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
  const saveMonth = async () => {
    try {
      const changed = Object.fromEntries(dates.filter((date) => String(rooms[date] ?? '') !== String(data.days[date] ?? '')).map((date) => [date, rooms[date] === '' || rooms[date] === undefined ? null : Number(rooms[date])]));
      if (Object.keys(changed).length) await request('/store/occupancy', { method: 'PUT', body: JSON.stringify({ days: changed }) });
      await request(`/store/months/${month}`, { method: 'PUT', body: JSON.stringify({ guests: guests === '' ? null : Number(guests), season: season || null }) });
      flash(`${monthLabel(month)} saved.`); load();
    } catch (error) { flash(error.message); }
  };
  const saveBudget = async () => { try { await request('/store/settings', { method: 'PUT', body: JSON.stringify(budget) }); flash('Budgets saved.'); await reload(); } catch (error) { flash(error.message); } };
  const entered = dates.filter((date) => rooms[date] !== undefined && rooms[date] !== '');
  return <>
    <section className="panel store-occupancy">
      <div className="store-bar"><MonthPicker month={month} setMonth={setMonth} max={config.today.slice(0, 7)} /><span className="muted">{entered.length} of {dayCount} days entered{entered.length ? ` · average ${Math.round(entered.reduce((s, d) => s + Number(rooms[d]), 0) / entered.length)} rooms` : ''}</span></div>
      {!data ? <Empty text="Loading…" /> : <>
        <p className="kicker">OCCUPIED ROOMS EACH DAY</p>
        <div className="store-days">{dates.map((date) => <label key={date} className={date > config.today ? 'future' : ''}><small>{Number(date.slice(8))} {new Date(`${date}T00:00:00`).toLocaleDateString([], { weekday: 'short' })}</small><input type="number" min="0" inputMode="numeric" value={rooms[date] ?? ''} disabled={date > config.today} onChange={(e) => setRooms({ ...rooms, [date]: e.target.value })} /></label>)}</div>
        <div className="store-month-fields"><label>Guests this month (for chemicals)<input type="number" min="0" inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="e.g. 11540" /></label><label>Season<select value={season} onChange={(e) => setSeason(e.target.value)}><option value="">Automatic ({data.seasonSet ? '' : data.season})</option><option value="high">High season</option><option value="low">Low season</option></select></label><button type="button" className="primary" onClick={saveMonth}>Save {MONTH_NAMES[m - 1]}</button></div>
      </>}
    </section>
    <section className="panel store-budgets">
      <p className="kicker">BUDGETS</p><h3>As set in the store books</h3>
      {!config.canManage && <p className="muted">Only managers can change budgets.</p>}
      <fieldset disabled={!config.canManage}>
        <label>Exchange rate (TZS per USD)<input type="number" min="1" value={budget.exchangeRate} onChange={(e) => setBudget({ ...budget, exchangeRate: e.target.value })} /></label>
        <label>Chemicals budget per guest (USD)<input type="number" min="0" step="0.01" value={budget.chemicals.perGuestUsd} onChange={(e) => setBudget({ ...budget, chemicals: { ...budget.chemicals, perGuestUsd: e.target.value } })} /></label>
        <label>Chemicals monthly budget, high season (USD)<input type="number" min="0" value={budget.chemicals.highSeasonUsd} onChange={(e) => setBudget({ ...budget, chemicals: { ...budget.chemicals, highSeasonUsd: e.target.value } })} /></label>
        <label>Chemicals monthly budget, low season (USD)<input type="number" min="0" value={budget.chemicals.lowSeasonUsd} onChange={(e) => setBudget({ ...budget, chemicals: { ...budget.chemicals, lowSeasonUsd: e.target.value } })} /></label>
        <label>Equipment & glassware purchases per month (USD)<input type="number" min="0" value={budget.equipment.monthlyPurchaseUsd} onChange={(e) => setBudget({ ...budget, equipment: { monthlyPurchaseUsd: e.target.value } })} /></label>
        <div className="store-season-months"><span>High season months</span>{MONTH_NAMES.map((name, index) => <label key={name} className="store-check"><input type="checkbox" checked={budget.highSeasonMonths.includes(index + 1)} onChange={(e) => setBudget({ ...budget, highSeasonMonths: e.target.checked ? [...budget.highSeasonMonths, index + 1] : budget.highSeasonMonths.filter((month) => month !== index + 1) })} />{name.slice(0, 3)}</label>)}</div>
        {config.canManage && <button type="button" className="primary" onClick={saveBudget}>Save budgets</button>}
      </fieldset>
    </section>
  </>;
}

// ---------- Import past months from the Excel store books (managers) ----------
// The files are read on this device and sent in one request by the manager already signed in, so nothing is typed.
function ImportTab({ config, request, reload }) {
  const [files, setFiles] = useState([]); // { name, book, workbook }
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const choose = async (list) => {
    setResult(null); setError(''); setBusy('Reading the files…');
    try {
      const XLSX = await import('xlsx');
      const read = [];
      for (const file of list) {
        try { const workbook = XLSX.read(await file.arrayBuffer()); read.push({ name: file.name, book: recognise(XLSX, workbook), workbook }); } catch { read.push({ name: file.name, book: null }); }
      }
      // Choosing files again adds to the list; a second copy of the same book replaces the first.
      setFiles((current) => [...current.filter((file) => !read.some((next) => next.book && next.book === file.book) && !read.some((next) => next.name === file.name)), ...read]);
    } finally { setBusy(''); }
  };
  const books = Object.fromEntries(files.filter((file) => file.book).map((file) => [file.book, file.workbook]));
  const run = async () => {
    setError(''); setResult(null);
    try {
      const XLSX = await import('xlsx');
      setBusy('Preparing the import…');
      const { payload, expected, skipped, disagreements } = buildImport(XLSX, books);
      setBusy(`Saving ${payload.sheets.length} days of records…`);
      await request('/store/import', { method: 'POST', body: JSON.stringify(payload) });
      setBusy('Checking the totals against the books…');
      const checks = [];
      for (const entry of expected) {
        const { report } = await request(`/store/report?book=${entry.book}&month=${entry.month}`);
        checks.push({ ...entry, app: report.totalCost, match: Math.abs(report.totalCost - entry.value) < 1 });
      }
      const missing = new Map();
      for (const { book, month, day, cost } of skipped) { const key = `${book}|${month}|${day}`; missing.set(key, (missing.get(key) || 0) + cost); }
      setResult({ checks, missing: [...missing].map(([key, cost]) => { const [book, month, day] = key.split('|'); return { book, month, day, cost }; }), disagreements, counts: { items: payload.items.length, days: payload.sheets.length, rooms: Object.keys(payload.days).length } });
      await reload();
    } catch (failure) { setError(failure.message); } finally { setBusy(''); }
  };
  const matched = result?.checks.filter((check) => check.match).length;
  return <section className="panel store-import">
    <p className="kicker">IMPORT PAST MONTHS</p><h3>From the Excel store books</h3>
    <p className="muted">Choose the four books (Chemical & Tools, Amenities & Stationery, Minibar, Monthly consumption & stock), all at once or one by one. The app reads them on this device, saves every month, then checks its totals against the books. Importing again replaces the same days; nothing is counted twice.</p>
    <label className="store-file"><input type="file" multiple accept=".xlsx,.xls" onChange={(e) => { choose([...e.target.files]); e.target.value = ''; }} disabled={Boolean(busy)} /><span>＋ Choose Excel files</span></label>
    {files.length > 0 && <ul className="store-files">{files.map((file) => <li key={file.name} className={file.book ? 'ok' : 'bad'}><b>{file.name}</b><span>{file.book ? `→ ${config.books[file.book].name}` : 'not a store book this app knows'}</span></li>)}</ul>}
    {files.length > 0 && <div className="store-import-go"><span className="muted">{Object.keys(books).length} of 4 books chosen</span><button type="button" className="primary" disabled={!Object.keys(books).length || Boolean(busy)} onClick={run}>{busy || `Import ${Object.keys(books).length === 1 ? 'this book' : `these ${Object.keys(books).length} books`}`}</button></div>}
    {busy && !files.length && <p className="muted">{busy}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <div className="store-import-result" role="status">
      <p className={matched === result.checks.length ? 'green-text' : ''}><b>Imported {result.counts.items} items, {result.counts.days} days of records and {result.counts.rooms} days of occupied rooms. {matched} of {result.checks.length} monthly totals match the books.</b></p>
      {result.checks.filter((check) => !check.match).map((check) => <p key={check.book + check.month} className="muted">{config.books[check.book].name}, {monthLabel(check.month)}: book TZS {tzs(check.value)}, app TZS {tzs(check.app)}.</p>)}
      {result.missing.length > 0 && <p className="muted">Left out because the month has no such day: {result.missing.map((entry) => `${config.books[entry.book].short} ${monthLabel(entry.month)} day ${entry.day} (TZS ${tzs(entry.cost)})`).join(', ')}.</p>}
      {result.disagreements.length > 0 && <p className="muted">The minibar and amenities books give different occupied rooms on {result.disagreements.length} days; the minibar figure was used.</p>}
    </div>}
  </section>;
}

export function Store({ request, saveExport }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('record');
  const [book, setBook] = useState('amenities');
  const [toast, setToast] = useState('');
  const flash = (text) => { setToast(text); setTimeout(() => setToast(''), 4000); };
  const reload = () => request('/store').then(setConfig).catch((failure) => setError(failure.message));
  useEffect(() => { reload(); }, []);
  const tabs = useMemo(() => [['record', 'Record'], ['month', 'Month report'], ['season', 'Season'], ['items', 'Items'], ['occupancy', 'Occupancy & budgets'], ...(config?.canManage ? [['import', 'Import']] : [])], [config?.canManage]);
  if (error) return <Empty text={error} />;
  if (!config) return <Empty text="Loading the store…" />;
  const picked = tab === 'season' ? book : book === 'all' ? 'amenities' : book;
  return <div className="store">
    <div className="heading"><div><p className="kicker">HOUSEKEEPING STORE</p><h2>{tab === 'occupancy' ? 'Occupancy & budgets' : tab === 'import' ? 'Import from Excel' : config.books[picked]?.name || 'All store books'}</h2></div></div>
    <div className="segmented store-tabs" role="tablist" aria-label="Store">{tabs.map(([key, label]) => <button type="button" role="tab" key={key} aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    {!['occupancy', 'import'].includes(tab) && <BookPicker books={config.books} book={picked} setBook={setBook} all={tab === 'season'} />}
    {tab === 'record' && <RecordTab key={picked} config={config} book={picked} request={request} flash={flash} />}
    {tab === 'month' && <MonthTab config={config} book={picked} request={request} flash={flash} saveExport={saveExport} />}
    {tab === 'season' && <SeasonTab config={config} book={picked} request={request} flash={flash} saveExport={saveExport} />}
    {tab === 'items' && <ItemsTab config={config} book={picked} request={request} reload={reload} flash={flash} />}
    {tab === 'occupancy' && <OccupancyTab config={config} request={request} reload={reload} flash={flash} />}
    {tab === 'import' && config.canManage && <ImportTab config={config} request={request} reload={reload} />}
    {toast && <div className="store-toast" role="status">{toast}</div>}
  </div>;
}
