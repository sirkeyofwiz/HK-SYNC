import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from '../../components/ui';
import { Icon } from '../../components/icons';
import { plural } from '../../lib/format';
import { readStockBook } from './readStockBook';

// Store availability: what the housekeeping store has right now, so supervisors know what they can ask for.
// The store team and managers keep the numbers up to date (or import the monthly stock Excel book).
const STATUS = { available: 'Available', low: 'Running low', out: 'Out of stock' };
const FILTERS = [['all', 'All items'], ['available', 'Available'], ['low', 'Running low'], ['out', 'Out of stock']];
const when = (iso) => { if (!iso) return ''; const date = new Date(iso); return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`; };

function ItemRow({ item, canEdit, save, remove }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ inStock: item.inStock, par: item.par ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) setForm({ inStock: item.inStock, par: item.par ?? '' }); }, [item.inStock, item.par, open]);
  const bump = (by) => setForm((current) => ({ ...current, inStock: Math.max(0, (Number(current.inStock) || 0) + by) }));
  const submit = async (event) => {
    event.preventDefault(); setError(''); setBusy(true);
    try { await save(item, { inStock: Number(form.inStock), par: form.par === '' ? null : Number(form.par) }); setOpen(false); } catch (problem) { setError(problem.message); } finally { setBusy(false); }
  };
  const summary = <><span className="stock-name"><b>{item.name}</b><small className="muted">{item.par !== null ? `Par level ${item.par}` : 'No par level'}</small></span>
    <span className="stock-qty"><strong>{item.inStock}</strong><small>in store</small></span>
    <span className={`stock-status ${item.status}`}>{STATUS[item.status]}</span></>;
  if (!canEdit) return <div className={`stock-row ${item.status}`}>{summary}</div>;
  return <div className={`stock-row editable ${item.status} ${open ? 'open' : ''}`}>
    <button type="button" className="stock-row-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{summary}</button>
    {open && <form className="stock-edit" onSubmit={submit}>
      <label>In store now<span className="stock-stepper"><button type="button" className="secondary" aria-label="One less" onClick={() => bump(-1)}>−</button><input type="number" inputMode="numeric" min="0" value={form.inStock} onChange={(e) => setForm({ ...form, inStock: e.target.value })} /><button type="button" className="secondary" aria-label="One more" onClick={() => bump(1)}>+</button></span></label>
      <label>Par level<input type="number" inputMode="numeric" min="0" placeholder="None" value={form.par} onChange={(e) => setForm({ ...form, par: e.target.value })} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="stock-edit-actions"><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="text danger" onClick={() => remove(item)}><Icon name="trash" size={15} />Remove item</button></div>
      <small className="muted">Last updated {when(item.updatedAt)} by {item.updatedByName}</small>
    </form>}
  </div>;
}

function AddItem({ categories, add, close }) {
  const [form, setForm] = useState({ name: '', category: categories[0] || '', inStock: 0, par: '' });
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setError('');
    try { await add({ ...form, inStock: Number(form.inStock), par: form.par === '' ? null : Number(form.par) }); close(); } catch (problem) { setError(problem.message); }
  };
  return <form className="panel stock-add" onSubmit={submit}>
    <div className="panel-title"><div><p className="kicker">NEW ITEM</p><h3>Add an item to the list</h3></div></div>
    <div className="stock-add-grid">
      <label>Item<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Hangers" required /></label>
      <label>Category<input list="stock-categories" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Room Equipment" /></label>
      <label>In store now<input type="number" inputMode="numeric" min="0" value={form.inStock} onChange={(e) => setForm({ ...form, inStock: e.target.value })} required /></label>
      <label>Par level<input type="number" inputMode="numeric" min="0" placeholder="None" value={form.par} onChange={(e) => setForm({ ...form, par: e.target.value })} /></label>
    </div>
    <datalist id="stock-categories">{categories.map((name) => <option key={name} value={name} />)}</datalist>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="stock-edit-actions"><button className="primary">Add item</button><button type="button" className="secondary" onClick={close}>Cancel</button></div>
  </form>;
}

export function Availability({ request, tick = 0, setMessage = () => {} }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const fileInput = useRef(null);
  const load = () => request('/availability').then((result) => { setData(result); setError(''); }).catch((problem) => setError(problem.message || 'Could not load store availability.'));
  useEffect(() => { load(); }, [tick]);
  const items = data?.items || [];
  const categories = useMemo(() => [...new Set(items.map((item) => item.category))], [items]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([key]) => [key, key === 'all' ? items.length : items.filter((item) => item.status === key).length])), [items]);
  if (!data) return <><div className="heading"><div><h2>Store availability</h2></div></div><Empty text={error || 'Loading store availability…'} /></>;

  const term = search.trim().toLowerCase();
  const shown = items.filter((item) => (filter === 'all' || item.status === filter) && (!category || item.category === category) && (!term || `${item.name} ${item.category}`.toLowerCase().includes(term)));
  const groups = categories.map((name) => [name, shown.filter((item) => item.category === name)]).filter(([, list]) => list.length);
  const save = async (item, change) => { await request(`/availability/items/${item.id}`, { method: 'PATCH', body: JSON.stringify(change) }); setMessage(`${item.name} updated.`); await load(); };
  const add = async (form) => { const result = await request('/availability/items', { method: 'POST', body: JSON.stringify(form) }); setMessage(`${result.item.name} added.`); await load(); };
  const remove = async (item) => { if (!window.confirm(`Remove ${item.name} from the list?`)) return; try { await request(`/availability/items/${item.id}`, { method: 'DELETE' }); setMessage(`${item.name} removed.`); await load(); } catch (problem) { setMessage(problem.message); } };
  const importFile = async (file) => {
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const book = readStockBook(XLSX, XLSX.read(await file.arrayBuffer(), { type: 'array' }));
      if (!window.confirm(`Import ${plural(book.items.length, 'item')} from "${book.month}" (stock as of ${when(`${book.asOf}T12:00:00`)})? Items already on the list get the new numbers.`)) return;
      const result = await request('/availability/import', { method: 'POST', body: JSON.stringify(book) });
      setMessage(`Imported: ${result.added} new, ${result.updated} updated.`);
      await load();
    } catch (problem) { setMessage(problem.message || 'Could not read that file.'); } finally { if (fileInput.current) fileInput.current.value = ''; }
  };

  return <div className="availability">
    <div className="heading"><div><h2>Store availability</h2><p className="muted">What the housekeeping store has right now, so you know what you can ask for.{data.updatedAt ? ` Last updated ${when(data.updatedAt)}.` : ''}</p></div>
      {data.canEdit && <div><input ref={fileInput} type="file" accept=".xlsx,.xls" hidden onChange={(e) => importFile(e.target.files?.[0])} /><button type="button" className="secondary" onClick={() => fileInput.current?.click()}><Icon name="download" />Import Excel</button><button type="button" className="primary" onClick={() => setAdding(true)}><Icon name="plus" />Add item</button></div>}
    </div>
    {adding && <AddItem categories={categories} add={add} close={() => setAdding(false)} />}
    <div className="stock-stats">{FILTERS.slice(1).map(([key, label]) => <button type="button" key={key} className={`panel stock-stat ${key} ${filter === key ? 'active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(filter === key ? 'all' : key)}><small>{label}</small><strong>{counts[key]}</strong></button>)}</div>
    <div className="stock-filters">
      <label className="quick-search-field"><Icon name="search" size={18} /><input type="search" placeholder="Search items" aria-label="Search items" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <div className="history-select"><select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{categories.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
      {filter !== 'all' && <button type="button" className="text" onClick={() => setFilter('all')}>Show all items</button>}
    </div>
    {!items.length ? <Empty text={data.canEdit ? 'No items yet. Import the monthly stock Excel book or add items one by one.' : 'The store has not listed its items yet.'} />
      : groups.length ? groups.map(([name, list]) => <section key={name} className="panel stock-group"><div className="panel-title"><div><p className="kicker">{name.toUpperCase()}</p><h3>{plural(list.length, 'item')}</h3></div></div>{list.map((item) => <ItemRow key={item.id} item={item} canEdit={data.canEdit} save={save} remove={remove} />)}</section>)
      : <Empty text="No items match." />}
  </div>;
}
