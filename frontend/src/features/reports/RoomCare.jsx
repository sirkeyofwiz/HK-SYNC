import { useEffect, useState } from 'react';
import { Empty } from '../../components/ui';
import { TYPES } from '../../lib/constants';
import { deadlineLabel, plural } from '../../lib/format';
import { DRAINAGE_STEPS, ROOM_CARE_EVERY, ROOM_CARE_TYPES } from '../../lib/rooms';

// The Room care tab on Reports: for each log, every room (or block) with when it was last done and whether it is due
// again, like the Excel sheets but filled in from the reports.
const short = (date) => new Date(`${date}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
const monthName = (month) => new Date(`${month}-01T00:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' });

function roomTitle(type, row) {
  if (!row.last) return `Room ${row.key}: never recorded`;
  const what = type === 'mattress_rotation' ? `turned by ${row.last.hkName}` : `cleaned: ${(row.last.items || []).join(', ')}`;
  return `Room ${row.key}: ${what} on ${deadlineLabel(row.last.date)} (${row.last.by})${row.last.remarks ? ` · “${row.last.remarks}”` : ''} · ${row.due ? 'due now' : `next due ${deadlineLabel(row.dueOn)}`}`;
}

function RoomGrid({ type, list, blocks, onlyDue, openReport }) {
  const byRoom = new Map(list.rows.map((row) => [row.key, row]));
  const shown = blocks.map((block) => ({ ...block, rows: block.rooms.map((room) => byRoom.get(room)).filter((row) => row && (!onlyDue || row.due)) })).filter((block) => block.rows.length);
  if (!shown.length) return <Empty text="Nothing is due. Every room is up to date." />;
  return <div className="care-blocks">{shown.map((block) => <div className="care-block" key={block.name}><b>{block.name}</b><div className="care-rooms">{block.rows.map((row) => <button type="button" key={row.key} className={`care-room ${!row.last ? 'never' : row.due ? 'due' : 'ok'} ${row.last?.remarks ? 'remark' : ''}`} title={roomTitle(type, row)} aria-label={roomTitle(type, row)} disabled={!row.last} onClick={() => openReport(row.last.reportId)}><span>{row.key}</span><small>{row.last ? short(row.last.date) : '—'}</small></button>)}</div></div>)}</div>;
}

function DrainageSheet({ list, blocks, onlyDue, openReport }) {
  const byBlock = new Map(list.rows.map((row) => [row.key, row]));
  const shown = blocks.filter((block) => !onlyDue || byBlock.get(block.name)?.due);
  return <><div className="entry-card drainage-steps"><p className="kicker">PROCEDURE · EMPTY ROOMS</p><ol>{DRAINAGE_STEPS.map((step) => <li key={step}>{step}</li>)}</ol></div>
    {!shown.length ? <Empty text="Nothing is due. Every block was drained this month." /> : <div className="table scroll dense drainage-sheet"><div className="table-head"><span>Block</span><span>{monthName(list.month)}: week 1</span><span>Week 2</span><span>Week 3</span><span>Week 4</span><span>Last drained</span></div>
      {shown.map((block) => { const row = byBlock.get(block.name); const weeks = list.weeks[block.name] || []; return <div className="table-row" key={block.name}><span><b>{block.name}</b><small>{block.rooms[0]}–{block.rooms[block.rooms.length - 1]}</small></span>{[1, 2, 3, 4].map((week) => { const done = weeks.filter((entry) => entry.week === week); return <span key={week} className="drainage-week">{done.map((entry) => <button type="button" key={entry.reportId} className={`badge ${entry.status === 'Issue' ? 'danger' : 'good'}`} onClick={() => openReport(entry.reportId)} title={entry.remarks || entry.status}>{entry.status === 'Issue' ? '⚠ Issue' : '✓'} {short(entry.date)}</button>)}</span>; })}<span className={row.due ? 'red-text' : ''}>{row.last ? `${deadlineLabel(row.last.date)}${row.due ? ' · due' : ''}` : 'Never · due'}</span></div>; })}
    </div>}</>;
}

export function RoomCare({ request, chooseType, allowedTypes, openReport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [type, setType] = useState('mattress_rotation');
  const [onlyDue, setOnlyDue] = useState(false);
  useEffect(() => { request('/room-care').then(setData).catch((failure) => setError(failure.message)); }, []);
  if (error) return <Empty text={error} />;
  if (!data) return <Empty text="Loading room care…" />;
  const list = data.tracker[type];
  const unit = list.by === 'room' ? 'room' : 'block';
  return <div className="room-care">
    <div className="segmented care-tabs" role="tablist" aria-label="Room care log">{ROOM_CARE_TYPES.map((key) => <button type="button" role="tab" key={key} aria-selected={type === key} className={type === key ? 'active' : ''} onClick={() => setType(key)}>{TYPES[key]} <span className="tab-count">{data.tracker[key].dueCount} due</span></button>)}</div>
    <div className="care-summary"><p><b>{plural(list.dueCount, unit)} due</b> of {list.rows.length} · done {ROOM_CARE_EVERY[type]}{list.neverCount ? ` · ${list.neverCount} never recorded` : ''}</p><div className="care-actions"><label className="care-only-due"><input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} /> Only show what is due</label>{allowedTypes.includes(type) && <button type="button" className="primary" onClick={() => chooseType(type)}>＋ New {TYPES[type]}</button>}</div></div>
    {list.by === 'room' ? <><p className="muted care-legend"><span className="care-key ok" /> Done, not due yet <span className="care-key due" /> Due again <span className="care-key never" /> Never recorded · Tap a room to open its last report.</p><RoomGrid type={type} list={list} blocks={data.blocks} onlyDue={onlyDue} openReport={openReport} /></> : <DrainageSheet list={list} blocks={data.blocks} onlyDue={onlyDue} openReport={openReport} />}
  </div>;
}
