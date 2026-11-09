import { HkSelect } from './ReportForm';
import { REPORT_BACKDATE_DAYS, TYPES, emptyEntry } from '../../lib/constants';
import { daysAgo, localToday } from '../../lib/format';
import { BLOCKS, DRAINAGE_STEPS, UPHOLSTERY_ITEMS } from '../../lib/rooms';
import { Icon } from '../../components/icons';

// One card per room. A drainage report filed before drainage went room by room has block lines: they show the block's name.
const RoomSelect = ({ value, onChange, taken }) => <select value={value || ''} onChange={(e) => onChange(e.target.value)} required><option value="">Choose room</option>{BLOCKS.map((block) => <optgroup key={block.name} label={block.name}>{block.rooms.map((room) => <option key={room} value={room} disabled={room !== value && taken.includes(room)}>{room}</option>)}</optgroup>)}</select>;

export function RoomCareForm({ type, report, editReport, submit, chooseType, allowedTypes, editing, cancelEdit, roster = [] }) {
  const entries = report.entries || [];
  const update = (index, key, value) => editReport('entries', (list) => list.map((entry, at) => (at === index ? { ...entry, [key]: value } : entry)));
  const remove = (index) => editReport('entries', (list) => list.filter((_, at) => at !== index));
  const add = () => editReport('entries', (list) => [...list, emptyEntry(type)]);
  const taken = entries.map((entry) => entry.room).filter(Boolean);
  return <form onSubmit={submit}><div className="heading"><div><h2>{editing ? 'Edit' : 'New'} {TYPES[type]}</h2></div><div className="form-actions">{editing && <button type="button" className="secondary" onClick={cancelEdit}>Cancel</button>}<button className="primary">{editing ? 'Save changes →' : 'Save report →'}</button></div></div>
    <div className="form-toolbar"><select value={type} onChange={(e) => chooseType(e.target.value)} disabled={Boolean(editing)}>{allowedTypes.map((key) => <option value={key} key={key}>{TYPES[key]}</option>)}</select><label>Date<input type="date" value={report.date} min={editing ? undefined : daysAgo(REPORT_BACKDATE_DAYS)} max={localToday()} disabled={Boolean(editing)} onChange={(e) => editReport('date', e.target.value)} /></label></div>
    {type === 'drainage' && <div className="entry-card drainage-steps"><p className="kicker">PROCEDURE · EMPTY ROOMS</p><ol>{DRAINAGE_STEPS.map((step) => <li key={step}>{step}</li>)}</ol><p className="muted">Add each room you drained. Choose <b>Issue</b> and say what is wrong if you found a plumbing problem: the managers are told.</p></div>}
    <div className="inspection-list">
      {entries.map((entry, index) => <div className="entry-card" key={index}><div className="entry-title"><b>{String(index + 1).padStart(2, '0')}</b><h3>{entry.room ? `Room ${entry.room}` : entry.block || 'Room'}</h3>{entries.length > 1 && <button type="button" className="text" onClick={() => remove(index)}>Remove</button>}</div>
        <div className="form-grid">{!(entry.block && !entry.room) && <label>Room<RoomSelect value={entry.room} onChange={(room) => update(index, 'room', room)} taken={taken} /></label>}{type === 'drainage' && <div className={`drainage-status ${entry.status ? "" : "unset"}`}><span>Drained — choose one</span><div className="ok-toggle" role="radiogroup" aria-label={`${entry.room ? `Room ${entry.room}` : entry.block || 'Room'} drainage`}>{[['Done', 'Done'], ['Issue', 'Issue']].map(([value, label]) => <button type="button" role="radio" aria-checked={entry.status === value} key={value} className={entry.status === value ? `on ${value === 'Issue' ? 'bad' : 'ok'}` : ''} onClick={() => update(index, 'status', value)}>{label}</button>)}</div></div>}{type === 'mattress_rotation' && <label>Turned by (housekeeper)<HkSelect roster={roster} value={entry.hkName} onChange={(name) => update(index, 'hkName', name)} required /></label>}</div>
        {type === 'upholstery' && <fieldset className="care-items"><legend>Cleaned</legend>{UPHOLSTERY_ITEMS.map((item) => { const on = (entry.items || []).includes(item); return <label key={item} className={`care-item ${on ? 'on' : ''}`}><input type="checkbox" checked={on} onChange={() => update(index, 'items', on ? entry.items.filter((value) => value !== item) : [...(entry.items || []), item])} />{item}</label>; })}</fieldset>}
        <label>{type === 'drainage' ? (entry.status === 'Issue' ? 'What is the plumbing issue? (needed)' : 'Note (optional)') : 'Problem found (optional)'}<textarea value={entry.remarks || ''} required={type === 'drainage' && entry.status === 'Issue'} onChange={(e) => update(index, 'remarks', e.target.value)} placeholder={type === 'mattress_rotation' ? 'e.g. mattress stained or sagging: the managers are told' : type === 'drainage' ? (entry.status === 'Issue' ? 'e.g. no bidet stopper, shower drains slowly: the managers are told' : 'A plumbing problem? Choose Issue above so the managers are told')  : 'e.g. stain that will not come out, torn fabric: the managers are told'} /></label>
      </div>)}
      <button type="button" className="add" onClick={add}><Icon name="plus" />Add another room</button>
    </div>
  </form>;
}
