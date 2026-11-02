import { useEffect, useState } from 'react';
import { PeriodPicker } from '../../components/PeriodPicker';
import { Empty } from '../../components/ui';
import { TYPES } from '../../lib/constants';
import { deadlineLabel, plural } from '../../lib/format';
import { inPeriod, periodRange, periodText } from '../../lib/period';
import { DRAINAGE_STEPS, ROOM_CARE_EVERY, ROOM_CARE_TYPES } from '../../lib/rooms';

// The Room care tab on Reports. Tracker: for each log, every room (or block) with when it was last done and whether it
// is due again, like the Excel sheets but filled in from the reports. History: every past record, for any period, and
// the full record of one room or block.
const short = (date) => new Date(`${date}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
const monthName = (month) => new Date(`${month}-01T00:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' });
const shiftMonth = (month, by) => { const day = new Date(`${month}-01T00:00:00`); day.setMonth(day.getMonth() + by); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`; };
// What was done on one record, in words.
export const careDetail = (type, row) => (type === 'mattress_rotation' ? `Turned by ${row.hkName || '—'}` : type === 'upholstery' ? `Cleaned: ${(row.items || []).join(', ') || '—'}` : row.status === 'Issue' ? 'Issue found' : 'Drained');
const place = (by, key) => (by === 'room' ? `Room ${key}` : key);

function roomTitle(type, row) {
  if (!row.last) return `Room ${row.key}: never recorded`;
  return `Room ${row.key}: ${careDetail(type, row.last).toLowerCase()} on ${deadlineLabel(row.last.date)} (${row.last.by})${row.last.remarks ? ` · “${row.last.remarks}”` : ''} · ${row.due ? 'due now' : `next due ${deadlineLabel(row.dueOn)}`} · tap for its history`;
}

function RoomGrid({ type, list, blocks, onlyDue, openHistory }) {
  const byRoom = new Map(list.rows.map((row) => [row.key, row]));
  const shown = blocks.map((block) => ({ ...block, rows: block.rooms.map((room) => byRoom.get(room)).filter((row) => row && (!onlyDue || row.due)) })).filter((block) => block.rows.length);
  if (!shown.length) return <Empty text="Nothing is due. Every room is up to date." />;
  return <div className="care-blocks">{shown.map((block) => <div className="care-block" key={block.name}><b>{block.name}</b><div className="care-rooms">{block.rows.map((row) => <button type="button" key={row.key} className={`care-room ${!row.last ? 'never' : row.due ? 'due' : 'ok'} ${row.last?.remarks ? 'remark' : ''}`} title={roomTitle(type, row)} aria-label={roomTitle(type, row)} disabled={!row.last} onClick={() => openHistory(row.key)}><span>{row.key}</span><small>{row.last ? short(row.last.date) : '—'}</small></button>)}</div></div>)}</div>;
}

function DrainageSheet({ list, blocks, onlyDue, openReport, openHistory, month, setMonth, thisMonth }) {
  const byBlock = new Map(list.rows.map((row) => [row.key, row]));
  const shown = blocks.filter((block) => !onlyDue || byBlock.get(block.name)?.due);
  const firstMonth = list.first ? list.first.slice(0, 7) : thisMonth;
  return <><div className="entry-card drainage-steps"><p className="kicker">PROCEDURE · EMPTY ROOMS</p><ol>{DRAINAGE_STEPS.map((step) => <li key={step}>{step}</li>)}</ol></div>
    <div className="month-nav"><button type="button" className="secondary" onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= firstMonth} aria-label="Previous month">‹ {monthName(shiftMonth(month, -1)).split(' ')[0]}</button><b>{monthName(month)}</b><button type="button" className="secondary" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth} aria-label="Next month">{monthName(shiftMonth(month, 1)).split(' ')[0]} ›</button>{month !== thisMonth && <button type="button" className="text" onClick={() => setMonth(thisMonth)}>Back to this month</button>}</div>
    {!shown.length ? <Empty text="Nothing is due. Every block was drained this month." /> : <div className="table scroll dense drainage-sheet"><div className="table-head"><span>Block</span><span>Week 1</span><span>Week 2</span><span>Week 3</span><span>Week 4</span><span>{month === thisMonth ? 'Last drained' : `In ${monthName(month).split(' ')[0]}`}</span></div>
      {shown.map((block) => { const row = byBlock.get(block.name); const weeks = list.weeks[block.name] || []; return <div className="table-row" key={block.name}><span><button type="button" className="name-link" onClick={() => openHistory(block.name)} title={`${block.name}: every drainage record`}>{block.name}</button><small>{block.rooms[0]}–{block.rooms[block.rooms.length - 1]}</small></span>{[1, 2, 3, 4].map((week) => { const done = weeks.filter((entry) => entry.week === week); return <span key={week} className="drainage-week">{done.map((entry) => <button type="button" key={entry.reportId} className={`badge ${entry.status === 'Issue' ? 'danger' : 'good'}`} onClick={() => openReport(entry.reportId)} title={entry.remarks || entry.status}>{entry.status === 'Issue' ? '⚠ Issue' : '✓'} {short(entry.date)}</button>)}</span>; })}{month === thisMonth ? <span className={row.due ? 'red-text' : ''}>{row.last ? `${deadlineLabel(row.last.date)}${row.due ? ' · due' : ''}` : 'Never · due'}</span> : <span className={!weeks.length || weeks.some((entry) => entry.status === 'Issue') ? 'red-text' : 'green-text'}>{!weeks.length ? 'Not drained' : weeks.some((entry) => entry.status === 'Issue') ? 'Issue reported' : 'Drained'}</span>}</div>; })}
    </div>}</>;
}

// Every record of one room or block, newest first.
function RecordHistory({ type, by, recordKey, request, openReport, close }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { request(`/room-care/history?type=${type}&key=${encodeURIComponent(recordKey)}`).then((result) => setRows(result.rows)).catch(() => setRows([])); }, [type, recordKey]);
  useEffect(() => { const onKey = (e) => e.key === 'Escape' && close(); window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  return <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><div className="modal care-history" role="dialog" aria-label={`${place(by, recordKey)} history`}><button type="button" className="close" onClick={close} aria-label="Close">×</button><p className="kicker">{TYPES[type].toUpperCase()} · HISTORY</p><h2>{place(by, recordKey)}</h2>
    {!rows ? <Empty text="Loading…" /> : !rows.length ? <Empty text="Nothing recorded yet." /> : <><p className="muted">{plural(rows.length, 'record')} · first {deadlineLabel(rows[rows.length - 1].date)}</p><ol className="care-timeline">{rows.map((row, index) => <li key={`${row.reportId}-${index}`} className={row.status === 'Issue' || row.remarks ? 'problem' : ''}><div><b>{deadlineLabel(row.date)}</b><span>{careDetail(type, row)}</span>{row.remarks && <i>“{row.remarks}”</i>}<small>Recorded by {row.by}</small></div><button type="button" className="text" onClick={() => { close(); openReport(row.reportId); }}>Open report →</button></li>)}</ol></>}
  </div></div>;
}

// Every record of a log in a period, with Excel export.
function HistoryList({ type, by, request, openReport, openHistory, exportRows }) {
  const [rows, setRows] = useState(null);
  const [when, setWhen] = useState({ period: 'this_month', from: '', to: '' });
  const [search, setSearch] = useState('');
  useEffect(() => { setRows(null); request(`/room-care/history?type=${type}`).then((result) => setRows(result.rows)).catch(() => setRows([])); }, [type]);
  if (!rows) return <Empty text="Loading history…" />;
  const range = periodRange(when.period, when.from, when.to);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((row) => (when.period === 'all' || inPeriod(row.date, range)) && words.every((word) => `${row.key} ${row.hkName || ''} ${row.by} ${(row.items || []).join(' ')} ${row.status || ''} ${row.remarks}`.toLowerCase().includes(word)));
  const problems = shown.filter((row) => row.status === 'Issue' || row.remarks).length;
  const download = () => exportRows(shown.map((row) => ({ Date: row.date, [by === 'room' ? 'Room' : 'Block']: row.key, ...(type === 'mattress_rotation' ? { Housekeeper: row.hkName || '' } : type === 'upholstery' ? { Cleaned: (row.items || []).join(', ') } : { Status: row.status || '' }), Problem: row.remarks || '', RecordedBy: row.by })), `${TYPES[type]} ${periodText(when.period, when.from, when.to)}`);
  return <div className="care-history-list">
    <div className="filters"><input placeholder={by === 'room' ? 'Search room, housekeeper or supervisor' : 'Search block or supervisor'} value={search} onChange={(e) => setSearch(e.target.value)} /><PeriodPicker period={when.period} from={when.from} to={when.to} onChange={setWhen} /><button type="button" className="secondary" onClick={download} disabled={!shown.length}>↓ Excel</button></div>
    <p className="muted report-count">{plural(shown.length, 'record')}{problems ? ` · ${problems} with a problem` : ''} · {periodText(when.period, when.from, when.to)}</p>
    <div className="table scroll dense care-history-table"><div className="table-head"><span>Date</span><span>{by === 'room' ? 'Room' : 'Block'}</span><span>Done</span><span>Problem</span><span>Recorded by</span><span /></div>
      {shown.map((row, index) => <div className="table-row" key={`${row.reportId}-${row.key}-${index}`}><span>{deadlineLabel(row.date)}</span><span><button type="button" className="name-link" onClick={() => openHistory(row.key)} title="Every record of this one">{place(by, row.key)}</button></span><span>{careDetail(type, row)}</span><span className={row.status === 'Issue' || row.remarks ? 'red-text' : 'muted'}>{row.remarks || '—'}</span><span>{row.by}</span><span><button type="button" className="text" onClick={() => openReport(row.reportId)}>Open →</button></span></div>)}
      {!shown.length && <Empty text="Nothing recorded in this period." />}
    </div>
  </div>;
}

export function RoomCare({ request, chooseType, allowedTypes, openReport, exportRows }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [type, setType] = useState('mattress_rotation');
  const [view, setView] = useState('tracker');
  const [onlyDue, setOnlyDue] = useState(false);
  const [month, setMonth] = useState('');
  const [history, setHistory] = useState(null);
  useEffect(() => { request(`/room-care${month ? `?month=${month}` : ''}`).then(setData).catch((failure) => setError(failure.message)); }, [month]);
  if (error) return <Empty text={error} />;
  if (!data) return <Empty text="Loading room care…" />;
  const list = data.tracker[type];
  const unit = list.by === 'room' ? 'room' : 'block';
  const thisMonth = data.today.slice(0, 7);
  return <div className="room-care">
    <div className="segmented care-tabs" role="tablist" aria-label="Room care log">{ROOM_CARE_TYPES.map((key) => <button type="button" role="tab" key={key} aria-selected={type === key} className={type === key ? 'active' : ''} onClick={() => setType(key)}>{TYPES[key]} <span className="tab-count">{data.tracker[key].dueCount} due</span></button>)}</div>
    <div className="care-summary"><div className="segmented care-view" role="group" aria-label="Show">{[['tracker', 'What is due'], ['history', 'History']].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}</div><div className="care-actions">{view === 'tracker' && <label className="care-only-due"><input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} /> Only show what is due</label>}{allowedTypes.includes(type) && <button type="button" className="primary" onClick={() => chooseType(type)}>＋ New {TYPES[type]}</button>}</div></div>
    {view === 'history' ? <HistoryList type={type} by={list.by} request={request} openReport={openReport} openHistory={setHistory} exportRows={exportRows} /> : <>
      <p className="care-count"><b>{plural(list.dueCount, unit)} due</b> of {list.rows.length} · done {ROOM_CARE_EVERY[type]}{list.neverCount ? ` · ${list.neverCount} never recorded` : ''}</p>
      {list.by === 'room' ? <><p className="muted care-legend"><span className="care-key ok" /> Done, not due yet <span className="care-key due" /> Due again <span className="care-key never" /> Never recorded · Tap a room for its history.</p><RoomGrid type={type} list={list} blocks={data.blocks} onlyDue={onlyDue} openHistory={setHistory} /></> : <DrainageSheet list={list} blocks={data.blocks} onlyDue={onlyDue} openReport={openReport} openHistory={setHistory} month={list.month} setMonth={setMonth} thisMonth={thisMonth} />}
    </>}
    {history && <RecordHistory type={type} by={list.by} recordKey={history} request={request} openReport={openReport} close={() => setHistory(null)} />}
  </div>;
}
