import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from '../../components/ui';
import { Icon } from '../../components/icons';
import { plural } from '../../lib/format';

// Guest laundry: log a guest bag when it leaves the room, then each step until it is back in the room, with who did it
// and when. Express is due back 4 hours after the laundry receives it, Standard 24 hours.
const NEXT = { collected: ['received'], received: ['washing', 'ready'], washing: ['ready'], ready: ['out'], out: ['returned'] };
const STEP_BUTTON = { received: 'Received at laundry', washing: 'Start washing', ready: 'Ready', out: 'Hand to housekeeper', returned: 'Returned to guest' };
const TABS = [['open', 'All open'], ['overdue', 'Overdue'], ['collected', 'On the way'], ['received', 'At laundry'], ['washing', 'Washing'], ['ready', 'Ready'], ['out', 'Out for delivery'], ['returned', 'Returned']];
const emptyForm = () => ({ room: '', service: 'wash_iron', speed: 'standard', stage: 'collected', collectedBy: '', items: {}, notes: '' });
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const when = (iso) => { const date = new Date(iso); const today = new Date(); const sameDay = date.toDateString() === today.toDateString(); return sameDay ? time(iso) : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time(iso)}`; };
const span = (ms) => { const minutes = Math.max(1, Math.round(Math.abs(ms) / 60000)); return minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${Math.round(minutes / 1440)} days`; };
const itemList = (items) => Object.entries(items || {}).map(([name, count]) => `${count} ${name}`).join(', ');
const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

function Due({ bag, now }) {
  if (bag.status === 'returned') return <span className="laundry-due done">Returned {when(bag.returnedAt)}</span>;
  if (!bag.dueAt) return <span className="laundry-due">On the way to the laundry</span>;
  const left = Date.parse(bag.dueAt) - now;
  return <span className={`laundry-due ${left < 0 ? 'late' : left < 2 * 60 * 60 * 1000 ? 'soon' : ''}`}>{left < 0 ? `Overdue by ${span(left)}` : `Due ${when(bag.dueAt)} · in ${span(left)}`}</span>;
}

// The + / − counters for the items in a bag (used when logging a bag and when correcting one).
function ItemCounts({ items, rules, setItems }) {
  const count = (item, by) => setItems((current) => ({ ...current, [item]: Math.max(0, Math.min(200, (current[item] || 0) + by)) }));
  return <div className="laundry-counts">{rules.items.map((item) => <div className="laundry-count" key={item}><span>{item}</span><button type="button" className="secondary" aria-label={`One less ${item}`} disabled={!items[item]} onClick={() => count(item, -1)}>−</button><b>{items[item] || 0}</b><button type="button" className="secondary" aria-label={`One more ${item}`} onClick={() => count(item, 1)}>+</button></div>)}</div>;
}

// Correct a bag that was logged wrong: room, service, Standard/Express, housekeeper, items, note.
function EditBag({ bag, rules, save, cancel }) {
  const [form, setForm] = useState(() => ({ room: bag.room, service: bag.service, speed: bag.speed, collectedBy: bag.collectedBy, items: { ...bag.items }, notes: bag.notes || '' }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const total = Object.values(form.items).reduce((sum, value) => sum + value, 0);
  const submit = async (event) => {
    event.preventDefault(); setError('');
    if (!total) return setError('Count at least one item in the bag.');
    setSaving(true);
    try { await save(form); } catch (problem) { setError(problem.message || 'Could not save the changes.'); setSaving(false); }
  };
  return <form className="laundry-edit" onSubmit={submit}>
    <p className="kicker">EDIT BAG {bag.number}</p>
    <div className="laundry-form-row">
      <label>Room<input inputMode="numeric" value={form.room} onChange={(e) => set('room', e.target.value)} required /></label>
      <label>Service<select value={form.service} onChange={(e) => set('service', e.target.value)}>{Object.entries(rules.services).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    </div>
    <div className="segmented laundry-speed-pick" role="group" aria-label="Speed">{Object.entries(rules.speeds).map(([key, label]) => <button type="button" key={key} aria-pressed={form.speed === key} className={form.speed === key ? 'active' : ''} onClick={() => set('speed', key)}>{label}</button>)}</div>
    <label>Housekeeper who brought it from the room<input list="laundry-hk" value={form.collectedBy} onChange={(e) => set('collectedBy', e.target.value)} required /></label>
    <p className="laundry-label">Items in the bag <b>{total ? `· ${plural(total, 'piece')}` : ''}</b></p>
    <ItemCounts items={form.items} rules={rules} setItems={(update) => setForm((current) => ({ ...current, items: update(current.items) }))} />
    <label>Note<textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="laundry-actions"><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button><button type="button" className="secondary" onClick={cancel} disabled={saving}>Cancel</button></div>
  </form>;
}

function BagCard({ bag, rules, now, focused, act, remove, update, canDelete, meId }) {
  const [hkName, setHkName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (focused && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [focused]);
  const step = async (to) => { setBusy(true); try { await act(bag, to, hkName); setHkName(''); } finally { setBusy(false); } };
  const needsName = (to) => to === 'out' || (to === 'returned' && !bag.handedOutAt);
  const next = NEXT[bag.status] || [];
  // Anyone on Guest laundry can correct an open bag; managers can also correct or delete one already returned.
  // Laundry staff and supervisors can delete only a bag they logged that the laundry has not received yet.
  const deletable = canDelete || (bag.createdById === meId && !bag.receivedAt);
  const editable = canDelete || bag.status !== 'returned';
  if (editing) return <article ref={ref} className="laundry-bag editing"><EditBag bag={bag} rules={rules} cancel={() => setEditing(false)} save={async (form) => { await update(bag, form); setEditing(false); }} /></article>;
  return <article ref={ref} className={`laundry-bag ${bag.overdue ? 'late' : ''} ${focused ? 'focused' : ''}`}>
    <div className="laundry-bag-head">
      <div><b>Room {bag.room}</b> <small className="muted">· bag {bag.number}</small></div>
      <span className={`laundry-speed ${bag.speed}`}>{bag.speed === 'express' ? <><Icon name="alert" size={14} />Express</> : 'Standard'}</span>
    </div>
    <p className="laundry-items">{rules.services[bag.service]} · <b>{plural(bag.pieces, 'piece')}</b>: {itemList(bag.items)}</p>
    {bag.notes && <p className="laundry-note">“{bag.notes}”</p>}
    <div className="laundry-status"><span className={`laundry-step ${bag.status}`}>{rules.steps[bag.status]}</span><Due bag={bag} now={now} /></div>
    <ol className="laundry-history">{bag.history.map((row, index) => <li key={index}><span>{rules.steps[row.step]}</span><small>{when(row.at)} · {row.step === 'collected' ? `by ${row.hkName}${row.byName !== row.hkName ? ` (logged by ${row.byName})` : ''}` : row.step === 'out' ? `${row.byName} → ${row.hkName}` : row.byName}{row.note ? ` · ${row.note}` : ''}</small></li>)}</ol>
    {next.length > 0 && <div className="laundry-actions">
      {next.some(needsName) && <input list="laundry-hk" placeholder={bag.status === 'ready' ? 'Housekeeper taking it to the room' : 'Housekeeper who took it to the room'} aria-label="Housekeeper" value={hkName} onChange={(e) => setHkName(e.target.value)} />}
      {next.map((to, index) => <button type="button" key={to} className={index === next.length - 1 ? 'primary' : 'secondary'} disabled={busy || (needsName(to) && !hkName.trim())} onClick={() => step(to)}>{STEP_BUTTON[to]}</button>)}
    </div>}
    {(editable || deletable) && <div className="laundry-manage">
      {bag.editedAt && <small className="muted">Edited by {bag.editedByName} · {when(bag.editedAt)}</small>}
      {editable && <button type="button" className="text laundry-edit-button" onClick={() => setEditing(true)}><Icon name="edit" size={15} />Edit</button>}
      {deletable && <button type="button" className="text laundry-delete" onClick={() => remove(bag)}><Icon name="trash" size={15} />Delete</button>}
    </div>}
  </article>;
}

function NewBag({ rules, create }) {
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const total = Object.values(form.items).reduce((sum, value) => sum + value, 0);
  const submit = async (event) => {
    event.preventDefault(); setError('');
    if (!total) return setError('Count at least one item in the bag.');
    setSaving(true);
    try { await create(form); setForm(emptyForm()); } catch (problem) { setError(problem.message || 'Could not save the bag.'); } finally { setSaving(false); }
  };
  return <form className="panel laundry-form" onSubmit={submit}>
    <div className="panel-title"><div><p className="kicker">LOG A BAG</p><h3>New guest bag</h3></div></div>
    <div className="laundry-form-row">
      <label>Room<input inputMode="numeric" placeholder="214" value={form.room} onChange={(e) => set('room', e.target.value)} required /></label>
      <label>Service<select value={form.service} onChange={(e) => set('service', e.target.value)}>{Object.entries(rules.services).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    </div>
    <p className="laundry-label">Standard or Express?</p>
    <div className="segmented laundry-speed-pick" role="group" aria-label="Speed">{Object.entries(rules.speeds).map(([key, label]) => <button type="button" key={key} aria-pressed={form.speed === key} className={form.speed === key ? 'active' : ''} onClick={() => set('speed', key)}>{label}<small> · back in {rules.dueHours[key]} h</small></button>)}</div>
    <p className="laundry-label">Where is the bag now?</p>
    <div className="segmented" role="group" aria-label="Where is the bag now">{[['collected', 'Collected from room'], ['received', 'Received at laundry']].map(([key, label]) => <button type="button" key={key} aria-pressed={form.stage === key} className={form.stage === key ? 'active' : ''} onClick={() => set('stage', key)}>{label}</button>)}</div>
    <label>Housekeeper who brought it from the room<input list="laundry-hk" placeholder="Name" value={form.collectedBy} onChange={(e) => set('collectedBy', e.target.value)} required /></label>
    <p className="laundry-label">Items in the bag <b>{total ? `· ${plural(total, 'piece')}` : ''}</b></p>
    <ItemCounts items={form.items} rules={rules} setItems={(update) => setForm((current) => ({ ...current, items: update(current.items) }))} />
    <label>Note (optional)<textarea rows={2} placeholder="e.g. stain on the white shirt, no starch" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></label>
    {error && <p className="error-text" role="alert">{error}</p>}
    <button className="primary" disabled={saving}><Icon name="plus" />{saving ? 'Saving…' : 'Log bag'}</button>
  </form>;
}

function Handovers({ data, me, request, reload }) {
  const [form, setForm] = useState({ shift: 'morning', toId: '', notes: '' });
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const others = data.staff.filter((person) => person.id !== me.id);
  const openBags = data.bags.filter((bag) => bag.status !== 'returned').length;
  const submit = async (event) => {
    event.preventDefault(); setError('');
    try { await request('/laundry/handovers', { method: 'POST', body: JSON.stringify(form) }); setForm({ shift: form.shift, toId: '', notes: '' }); reload(); } catch (problem) { setError(problem.message); }
  };
  return <section className="panel laundry-handovers">
    <div className="panel-title"><div><p className="kicker">LAUNDRY SHIFT HANDOVER</p><h3>Hand over to the next shift</h3><small className="muted">The {plural(openBags, 'open bag')} at this moment go with the handover.</small></div></div>
    {me.role === 'laundry' && <form className="laundry-handover-form" onSubmit={submit}>
      <label>Shift<select value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })}>{Object.entries(data.rules.shifts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>To<select value={form.toId} onChange={(e) => setForm({ ...form, toId: e.target.value })} required><option value="">Choose who takes over</option>{others.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      <label className="wide">Notes<textarea rows={2} placeholder="Anything the next shift must know" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="primary">Hand over</button>
    </form>}
    {data.handovers.length ? <div className="laundry-handover-list">{data.handovers.map((row) => <div key={row.id} className="laundry-handover">
      <button type="button" className="text" onClick={() => setOpen(open === row.id ? null : row.id)} aria-expanded={open === row.id}><b>{row.fromName} → {row.toName}</b><small className="muted"> · {data.rules.shifts[row.shift]} · {when(row.createdAt)} · {plural(row.bags.length, 'open bag')}</small></button>
      {row.notes && <p className="laundry-note">“{row.notes}”</p>}
      {open === row.id && <ul>{row.bags.map((bag) => <li key={bag.id}>Room {bag.room} · bag {bag.number} · {bag.speed === 'express' ? 'Express' : 'Standard'} · {plural(bag.pieces, 'piece')} · {data.rules.steps[bag.status]}</li>)}{!row.bags.length && <li className="muted">No open bags.</li>}</ul>}
    </div>)}</div> : <Empty text="No laundry handovers in the last two weeks." />}
  </section>;
}

export function Laundry({ request, me, roster = [], tick = 0, focusId = null, setMessage = () => {} }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('open');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(Date.now());
  const load = () => request('/laundry').then((result) => { setData(result); setError(''); }).catch((problem) => setError(problem.message || 'Could not load Guest laundry.'));
  useEffect(() => { load(); }, [tick]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30 * 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (focusId) { setTab('open'); setSearch(''); } }, [focusId]);
  const bags = data?.bags || [];
  const counts = useMemo(() => Object.fromEntries(TABS.map(([key]) => [key, bags.filter((bag) => key === 'open' ? bag.status !== 'returned' : key === 'overdue' ? bag.overdue : bag.status === key).length])), [bags]);
  if (error && !data) return <><div className="heading"><div><h2>Guest laundry</h2></div></div><Empty text={error} /></>;
  if (!data) return <><div className="heading"><div><h2>Guest laundry</h2></div></div><Empty text="Loading Guest laundry…" /></>;
  const open = bags.filter((bag) => bag.status !== 'returned');
  const term = search.trim().toLowerCase();
  const shown = bags.filter((bag) => (tab === 'open' ? bag.status !== 'returned' : tab === 'overdue' ? bag.overdue : bag.status === tab) && (!term || `${bag.room} ${bag.number} ${bag.collectedBy} ${bag.deliveredBy || ''}`.toLowerCase().includes(term)))
    .sort((a, b) => (tab === 'returned' ? String(b.returnedAt).localeCompare(String(a.returnedAt)) : (Number(b.overdue) - Number(a.overdue)) || (a.speed === b.speed ? 0 : a.speed === 'express' ? -1 : 1) || String(a.dueAt || '9').localeCompare(String(b.dueAt || '9'))));
  const create = async (form) => { const result = await request('/laundry/bags', { method: 'POST', body: JSON.stringify(form) }); setMessage(`Bag ${result.bag.number} for room ${result.bag.room} logged.`); await load(); };
  const act = async (bag, to, hkName) => { try { await request(`/laundry/bags/${bag.id}/step`, { method: 'POST', body: JSON.stringify({ to, hkName }) }); await load(); } catch (problem) { setMessage(problem.message); } };
  const remove = async (bag) => { if (!window.confirm(`Delete bag ${bag.number} for room ${bag.room}? It will no longer show in Guest laundry.`)) return; try { await request(`/laundry/bags/${bag.id}`, { method: 'DELETE' }); setMessage(`Bag ${bag.number} for room ${bag.room} deleted.`); await load(); } catch (problem) { setMessage(problem.message); } };
  const update = async (bag, form) => { const result = await request(`/laundry/bags/${bag.id}`, { method: 'PATCH', body: JSON.stringify(form) }); setMessage(`Bag ${result.bag.number} for room ${result.bag.room} updated.`); await load(); };
  const dueSoon = open.filter((bag) => bag.dueAt && !bag.overdue && Date.parse(bag.dueAt) - now < 2 * 60 * 60 * 1000).length;
  const returnedToday = bags.filter((bag) => bag.status === 'returned' && isToday(bag.returnedAt));
  return <div className="laundry">
    <datalist id="laundry-hk">{roster.map((name) => <option key={name} value={name} />)}</datalist>
    <div className="heading"><div><h2>Guest laundry</h2><p className="muted">Every guest bag from the room to the laundry and back: who handled it and when. Express is due back {data.rules.dueHours.express} hours after the laundry receives it, Standard {data.rules.dueHours.standard} hours. Reminders every {data.rules.remindMinutes.express} min (Express) or {data.rules.remindMinutes.standard} min (Standard) until it is returned.</p></div></div>
    <div className="laundry-stats">
      <div className="panel"><small>Open bags</small><strong>{open.length}</strong><small className="muted">{plural(open.reduce((sum, bag) => sum + bag.pieces, 0), 'piece')}</small></div>
      <div className={`panel ${counts.overdue ? 'late' : ''}`}><small>Overdue</small><strong>{counts.overdue}</strong><small className="muted">{dueSoon} due in the next 2 hours</small></div>
      <div className="panel"><small>At the laundry</small><strong>{counts.received + counts.washing + counts.ready}</strong><small className="muted">Ready: {counts.ready}</small></div>
      <div className="panel"><small>Returned today</small><strong>{returnedToday.length}</strong><small className="muted">{plural(returnedToday.reduce((sum, bag) => sum + bag.pieces, 0), 'piece')}</small></div>
    </div>
    <div className="laundry-grid">
      <NewBag rules={data.rules} create={create} />
      <section className="panel laundry-list">
        <div className="segmented laundry-tabs" role="tablist" aria-label="Bags">{TABS.map(([key, label]) => <button type="button" role="tab" key={key} aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label} <span className="tab-count">{counts[key]}</span></button>)}</div>
        <label className="quick-search-field"><Icon name="search" size={18} /><input type="search" placeholder="Room, bag no. or housekeeper" aria-label="Search bags" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        {shown.length ? <div className="laundry-bags">{shown.map((bag) => <BagCard key={bag.id} bag={bag} rules={data.rules} now={now} focused={bag.id === focusId} act={act} remove={remove} update={update} canDelete={data.canDelete} meId={me.id} />)}</div>
          : <Empty text={tab === 'open' && !term ? 'No guest bags right now. Log one when you collect it from a room.' : 'No bags here.'} />}
      </section>
    </div>
    <Handovers data={data} me={me} request={request} reload={load} />
  </div>;
}
