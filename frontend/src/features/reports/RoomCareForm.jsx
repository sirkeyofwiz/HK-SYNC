import { HkSelect } from './ReportForm';
import { REPORT_BACKDATE_DAYS, TYPES } from '../../lib/constants';
import { daysAgo, localToday } from '../../lib/format';
import { BLOCKS, DRAINAGE_STEPS, UPHOLSTERY_ITEMS } from '../../lib/rooms';
import { Icon } from '../../components/icons';

// Mattress rotation and upholstery: one card per room. Water drainage: every block in one list, marked Done or Issue.
const RoomSelect = ({ value, onChange, taken }) => <select value={value || ''} onChange={(e) => onChange(e.target.value)} required><option value="">Choose room</option>{BLOCKS.map((block) => <optgroup key={block.name} label={block.name}>{block.rooms.map((room) => <option key={room} value={room} disabled={room !== value && taken.includes(room)}>{room}</option>)}</optgroup>)}</select>;

export function RoomCareForm({ type, report, editReport, submit, chooseType, allowedTypes, editing, cancelEdit, roster = [] }) {
  const entries = report.entries || [];
  const update = (index, key, value) => editReport('entries', (list) => list.map((entry, at) => (at === index ? { ...entry, [key]: value } : entry)));
  const remove = (index) => editReport('entries', (list) => list.filter((_, at) => at !== index));
  const add = () => editReport('entries', (list) => [...list, type === 'upholstery' ? { room: '', items: [], remarks: '' } : { room: '', hkName: '', remarks: '' }]);
  const taken = entries.map((entry) => entry.room).filter(Boolean);
  // Drainage keeps one line per block that has been marked; the form shows all blocks.
  const blockLine = (name) => entries.find((entry) => entry.block === name) || { block: name, status: '', remarks: '' };
  const setBlock = (name, change) => editReport('entries', (list) => { const rest = list.filter((entry) => entry.block && entry.block !== name); const next = { ...blockLine(name), ...change }; return next.status ? [...rest, next] : rest; });
  const marked = entries.filter((entry) => entry.block && entry.status).length;
  return <form onSubmit={submit}><div className="heading"><div><p className="kicker">{editing ? 'EDIT REPORT' : 'ROOM CARE'}</p><h2>{editing ? 'Edit' : 'New'} {TYPES[type]}</h2></div><div className="form-actions">{editing && <button type="button" className="secondary" onClick={cancelEdit}>Cancel</button>}<button className="primary">{editing ? 'Save changes →' : 'Save report →'}</button></div></div>
    <div className="form-toolbar"><select value={type} onChange={(e) => chooseType(e.target.value)} disabled={Boolean(editing)}>{allowedTypes.map((key) => <option value={key} key={key}>{TYPES[key]}</option>)}</select><label>Date<input type="date" value={report.date} min={editing ? undefined : daysAgo(REPORT_BACKDATE_DAYS)} max={localToday()} disabled={Boolean(editing)} onChange={(e) => editReport('date', e.target.value)} /></label></div>
    {type === 'drainage' ? <>
      <div className="entry-card drainage-steps"><p className="kicker">PROCEDURE · EMPTY ROOMS</p><ol>{DRAINAGE_STEPS.map((step) => <li key={step}>{step}</li>)}</ol><p className="muted">Mark each block you drained today. Choose <b>Issue</b> and say what is wrong if you found a plumbing problem: the managers are told.</p></div>
      <div className="drainage-blocks">{BLOCKS.map((block) => { const line = blockLine(block.name); return <div key={block.name} className={`drainage-block ${line.status === 'Issue' ? 'bad' : line.status ? 'done' : ''}`}><div><b>{block.name}</b><small>{block.rooms[0]}–{block.rooms[block.rooms.length - 1]}</small></div><div className="ok-toggle" role="radiogroup" aria-label={block.name}>{[['', 'Not done'], ['Done', 'Done'], ['Issue', 'Issue']].map(([value, label]) => <button type="button" role="radio" aria-checked={line.status === value} key={label} className={line.status === value ? `on ${value === 'Issue' ? 'bad' : value ? 'ok' : ''}` : ''} onClick={() => setBlock(block.name, { status: value })}>{label}</button>)}</div>{line.status && <input value={line.remarks || ''} onChange={(e) => setBlock(block.name, { remarks: e.target.value })} required={line.status === 'Issue'} placeholder={line.status === 'Issue' ? 'What is the plumbing issue? (needed)' : 'Remark (optional)'} aria-label={`${block.name} remark`} />}</div>; })}</div>
      <p className="muted drainage-count">{marked ? `${marked} ${marked === 1 ? 'block' : 'blocks'} marked` : 'No blocks marked yet.'}</p>
    </> : <div className="inspection-list">
      {entries.map((entry, index) => <div className="entry-card" key={index}><div className="entry-title"><b>{String(index + 1).padStart(2, '0')}</b><h3>{entry.room ? `Room ${entry.room}` : 'Room'}</h3>{entries.length > 1 && <button type="button" className="text" onClick={() => remove(index)}>Remove</button>}</div>
        <div className="form-grid"><label>Room<RoomSelect value={entry.room} onChange={(room) => update(index, 'room', room)} taken={taken} /></label>{type === 'mattress_rotation' && <label>Turned by (housekeeper)<HkSelect roster={roster} value={entry.hkName} onChange={(name) => update(index, 'hkName', name)} required /></label>}</div>
        {type === 'upholstery' && <fieldset className="care-items"><legend>Cleaned</legend>{UPHOLSTERY_ITEMS.map((item) => { const on = (entry.items || []).includes(item); return <label key={item} className={`care-item ${on ? 'on' : ''}`}><input type="checkbox" checked={on} onChange={() => update(index, 'items', on ? entry.items.filter((value) => value !== item) : [...(entry.items || []), item])} />{item}</label>; })}</fieldset>}
        <label>Problem found (optional)<textarea value={entry.remarks || ''} onChange={(e) => update(index, 'remarks', e.target.value)} placeholder={type === 'mattress_rotation' ? 'e.g. mattress stained or sagging: the managers are told' : 'e.g. stain that will not come out, torn fabric: the managers are told'} /></label>
      </div>)}
      <button type="button" className="add" onClick={add}><Icon name="plus" />Add another room</button>
    </div>}
  </form>;
}
