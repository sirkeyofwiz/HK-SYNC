import { useEffect, useState } from 'react';
import { PeriodPicker } from '../../components/PeriodPicker';
import { Empty } from '../../components/ui';
import { TYPES } from '../../lib/constants';
import { deadlineLabel, plural } from '../../lib/format';
import { inPeriod, periodRange, periodText } from '../../lib/period';
import { DRAINAGE_STEPS, ROOM_CARE_EVERY, ROOM_CARE_TYPES } from '../../lib/rooms';
import { Icon } from '../../components/icons';

// The Room care tab on Reports. Tracker: for each log, every room with when it was last done and whether it is due again,
// like the Excel sheets but filled in from the reports. History: every past record, for any period, and the full record
// of one room. Old drainage reports were filed by block, so those records carry a block's name instead of a room.
const short = (date) => new Date(`${date}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
// What was done on one record, in words.
export const careDetail = (type, row) => (type === 'mattress_rotation' ? `Turned by ${row.hkName || '—'}` : type === 'upholstery' ? `Cleaned: ${(row.items || []).join(', ') || '—'}` : row.status === 'Issue' ? 'Issue found' : 'Drained');
const place = (key) => (/^\d/.test(key) ? `Room ${key}` : key);

function roomTitle(type, row) {
  if (!row.last) return `Room ${row.key}: never recorded`;
  return `Room ${row.key}: ${careDetail(type, row.last).toLowerCase()} on ${deadlineLabel(row.last.date)} (${row.last.by})${row.last.remarks ? ` · “${row.last.remarks}”` : ''} · ${row.due ? 'due now' : `next due ${deadlineLabel(row.dueOn)}`} · tap for its history`;
}

// Each room's mark: an issue on its latest record, else done until it is due again, else not done. For drainage an issue
// is a room marked Issue (supervisors also write notes like "All ok"); for the other logs, any problem noted. A later
// record without a problem clears the issue.
export const roomState = (row, type) => (row.last && (type === 'drainage' ? row.last.status === 'Issue' : row.last.remarks) ? 'issue' : row.last && !row.due ? 'done' : 'notdone');
const STATES = { done: ['Done', 'check'], notdone: ['Not done', 'x'], issue: ['Issue', 'alert'] };

function RoomGrid({ type, list, blocks, onlyDue, openHistory }) {
  const byRoom = new Map(list.rows.map((row) => [row.key, row]));
  const shown = blocks.map((block) => ({ ...block, rows: block.rooms.map((room) => byRoom.get(room)).filter((row) => row && (!onlyDue || roomState(row, type) !== 'done')) })).filter((block) => block.rows.length);
  if (!shown.length) return <Empty text="Every room is done. Nothing is due and no issues are open." />;
  return <div className="care-blocks">{shown.map((block) => <div className="care-block" key={block.name}><b>{block.name}</b><div className="care-rooms">{block.rows.map((row) => { const state = roomState(row, type); const [word, icon] = STATES[state]; return <button type="button" key={row.key} className={`care-room ${state}`} title={roomTitle(type, row)} aria-label={`${word}. ${roomTitle(type, row)}`} disabled={!row.last} onClick={() => openHistory(row.key)}><span className="care-room-top"><Icon name={icon} size={13} />{row.key}</span><small>{row.last ? (state === 'notdone' ? 'due' : short(row.last.date)) : 'not done'}</small></button>; })}</div></div>)}</div>;
}

// Every record of one room, newest first.
function RecordHistory({ type, recordKey, request, openReport, close }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { request(`/room-care/history?type=${type}&key=${encodeURIComponent(recordKey)}`).then((result) => setRows(result.rows)).catch(() => setRows([])); }, [type, recordKey]);
  useEffect(() => { const onKey = (e) => e.key === 'Escape' && close(); window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  return <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><div className="modal care-history" role="dialog" aria-label={`${place(recordKey)} history`}><button type="button" className="close" onClick={close} aria-label="Close">×</button><p className="kicker">{TYPES[type].toUpperCase()} · HISTORY</p><h2>{place(recordKey)}</h2>
    {!rows ? <Empty text="Loading…" /> : !rows.length ? <Empty text="Nothing recorded yet." /> : <><p className="muted">{plural(rows.length, 'record')} · first {deadlineLabel(rows[rows.length - 1].date)}</p><ol className="care-timeline">{rows.map((row, index) => <li key={`${row.reportId}-${index}`} className={row.status === 'Issue' || row.remarks ? 'problem' : ''}><div><b>{deadlineLabel(row.date)}</b><span>{careDetail(type, row)}</span>{row.remarks && <i>“{row.remarks}”</i>}<small>Recorded by {row.by}</small></div><button type="button" className="text" onClick={() => { close(); openReport(row.reportId); }}>Open report →</button></li>)}</ol></>}
  </div></div>;
}

// Every record of a log in a period, with Excel export.
function HistoryList({ type, request, openReport, openHistory, exportRows }) {
  const [rows, setRows] = useState(null);
  const [when, setWhen] = useState({ period: 'this_month', from: '', to: '' });
  const [search, setSearch] = useState('');
  useEffect(() => { setRows(null); request(`/room-care/history?type=${type}`).then((result) => setRows(result.rows)).catch(() => setRows([])); }, [type]);
  if (!rows) return <Empty text="Loading history…" />;
  const range = periodRange(when.period, when.from, when.to);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((row) => (when.period === 'all' || inPeriod(row.date, range)) && words.every((word) => `${row.key} ${row.hkName || ''} ${row.by} ${(row.items || []).join(' ')} ${row.status || ''} ${row.remarks}`.toLowerCase().includes(word)));
  const problems = shown.filter((row) => row.status === 'Issue' || row.remarks).length;
  const download = () => exportRows(shown.map((row) => ({ Date: row.date, Room: row.key, ...(type === 'mattress_rotation' ? { Housekeeper: row.hkName || '' } : type === 'upholstery' ? { Cleaned: (row.items || []).join(', ') } : { Status: row.status || '' }), Problem: row.remarks || '', RecordedBy: row.by })), `${TYPES[type]} ${periodText(when.period, when.from, when.to)}`);
  return <div className="care-history-list">
    <div className="filters"><input placeholder="Search room, housekeeper or supervisor" value={search} onChange={(e) => setSearch(e.target.value)} /><PeriodPicker period={when.period} from={when.from} to={when.to} onChange={setWhen} /><button type="button" className="secondary" onClick={download} disabled={!shown.length}><Icon name="download" />Excel</button></div>
    <p className="muted report-count">{plural(shown.length, 'record')}{problems ? ` · ${problems} with a problem` : ''} · {periodText(when.period, when.from, when.to)}</p>
    <div className="table scroll dense care-history-table"><div className="table-head"><span>Date</span><span>Room</span><span>Done</span><span>Problem</span><span>Recorded by</span><span /></div>
      {shown.map((row, index) => <div className="table-row" key={`${row.reportId}-${row.key}-${index}`}><span>{deadlineLabel(row.date)}</span><span><button type="button" className="name-link" onClick={() => openHistory(row.key)} title="Every record of this one">{place(row.key)}</button></span><span>{careDetail(type, row)}</span><span className={row.status === 'Issue' || row.remarks ? 'red-text' : 'muted'}>{row.remarks || '—'}</span><span>{row.by}</span><span><button type="button" className="text" onClick={() => openReport(row.reportId)}>Open →</button></span></div>)}
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
  const [history, setHistory] = useState(null);
  useEffect(() => { request('/room-care').then(setData).catch((failure) => setError(failure.message)); }, []);
  if (error) return <Empty text={error} />;
  if (!data) return <Empty text="Loading room care…" />;
  const list = data.tracker[type];
  return <div className="room-care">
    <div className="segmented care-tabs" role="tablist" aria-label="Room care log">{ROOM_CARE_TYPES.map((key) => <button type="button" role="tab" key={key} aria-selected={type === key} className={type === key ? 'active' : ''} onClick={() => setType(key)}>{TYPES[key]} <span className="tab-count">{data.tracker[key].dueCount} due</span></button>)}</div>
    <div className="care-summary"><div className="segmented care-view" role="group" aria-label="Show">{[['tracker', 'What is due'], ['history', 'History']].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}</div><div className="care-actions">{view === 'tracker' && <label className="care-only-due"><input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} /> Only show rooms not done or with issues</label>}{allowedTypes.includes(type) && <button type="button" className="primary" onClick={() => chooseType(type)}><Icon name="plus" />New {TYPES[type]}</button>}</div></div>
    {view === 'history' ? <HistoryList type={type} request={request} openReport={openReport} openHistory={setHistory} exportRows={exportRows} /> : <>
      <p className="care-count"><b>{plural(list.dueCount, 'room')} due</b> of {list.rows.length} · done {ROOM_CARE_EVERY[type]}{list.neverCount ? ` · ${list.neverCount} never recorded` : ''}</p>
      {type === 'drainage' && <div className="entry-card drainage-steps"><p className="kicker">PROCEDURE · EMPTY ROOMS</p><ol>{DRAINAGE_STEPS.map((step) => <li key={step}>{step}</li>)}</ol></div>}
      {(() => { const counts = { done: 0, notdone: 0, issue: 0 }; for (const row of list.rows) counts[roomState(row, type)] += 1; return <div className="care-legend" aria-label="Rooms by mark">{Object.entries(STATES).map(([state, [word, icon]]) => <span key={state} className={`care-chip ${state}`}><Icon name={icon} size={14} /><b>{counts[state]}</b> {word.toLowerCase()}</span>)}<small className="muted">Tap a room for its history.</small></div>; })()}<RoomGrid type={type} list={list} blocks={data.blocks} onlyDue={onlyDue} openHistory={setHistory} />
    </>}
    {history && <RecordHistory type={type} recordKey={history} request={request} openReport={openReport} close={() => setHistory(null)} />}
  </div>;
}
