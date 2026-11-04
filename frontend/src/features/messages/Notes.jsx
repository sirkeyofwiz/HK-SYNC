import { useEffect, useState } from 'react';
import { confirmAction } from '../../components/ConfirmDialog';
import { plural } from '../../lib/format';
import { Icon } from '../../components/icons';

// Notes for the manager on a report or task: a supervisor writes one, managers are told and read it on the report or
// task. `note` = { kind: 'report' | 'task', id, title, subtitle }.
export const isManagerRole = (role) => ['manager', 'assistant_manager'].includes(role);
const when = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// The button beside "Ask": supervisors always get it; managers only once there is a note to read.
export function NoteButton({ count = 0, me, open, long = false }) {
  if (isManagerRole(me?.role) && !count) return null;
  const label = isManagerRole(me?.role) ? `${plural(count, 'note')}` : `${long ? 'Note for the manager' : 'Note'}${count ? ` · ${count}` : ''}`;
  return <button type="button" className={`note-button ${count ? 'has-notes' : ''}`} onClick={open} title={isManagerRole(me?.role) ? 'Read the notes on this' : 'Write a note for the manager'}><Icon name="notes" />{label}</button>;
}

// The notes on one report or task, oldest first; the writer or a manager can delete one.
export function NoteList({ note, request, version = 0, onChange, empty = null, heading = '' }) {
  const [notes, setNotes] = useState(null);
  const load = () => request(`/notes?kind=${note.kind}&id=${encodeURIComponent(note.id)}`).then((result) => setNotes(result.notes)).catch(() => setNotes([]));
  useEffect(() => { load(); }, [note.id, version]);
  const remove = async (row) => {
    if (!(await confirmAction({ title: 'Delete this note?', body: `“${row.text.slice(0, 120)}”`, confirmLabel: 'Delete note', danger: true }))) return;
    await request(`/notes/${row.id}`, { method: 'DELETE' }).catch(() => {});
    load(); onChange?.();
  };
  if (!notes) return null;
  if (!notes.length) return empty;
  const list = <ul className="note-list">{notes.map((row) => <li key={row.id}><p>{row.text}</p><small>{row.byName} · {when(row.createdAt)}{row.canDelete && <button type="button" className="text" onClick={() => remove(row)}>Delete</button>}</small></li>)}</ul>;
  return heading ? <section className="panel notes-panel"><p className="kicker">{heading}</p>{list}</section> : list;
}

export function NoteDialog({ note, me, request, close, saved }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const manager = isManagerRole(me?.role);
  useEffect(() => { const onKey = (e) => e.key === 'Escape' && close(); window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true); setError('');
    try { await request('/notes', { method: 'POST', body: JSON.stringify({ kind: note.kind, id: note.id, text: text.trim() }) }); setText(''); setVersion((value) => value + 1); saved(true); } catch (failure) { setError(failure.message); }
    setSaving(false);
  };
  return <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><form className="modal ask-modal note-modal" onSubmit={submit} role="dialog" aria-label="Note for the manager"><button type="button" className="close" onClick={close} aria-label="Close">×</button><p className="kicker">{manager ? 'NOTES' : 'NOTE FOR THE MANAGER'}</p><h2>{manager ? 'Notes on this' : 'Write a note'}</h2><div className="ask-item"><span>{note.kind === 'task' ? '✓' : '📋'}</span><div><b>{note.title}</b><small>{note.subtitle}</small></div></div><NoteList note={note} request={request} version={version} onChange={saved} empty={manager ? <p className="muted">No notes yet.</p> : null} /><label>{manager ? 'Add a note' : 'Your note'}<textarea value={text} maxLength={2000} placeholder={manager ? 'Add your own note to this ' + note.kind : 'What should the manager know? It stays on this ' + note.kind + ' and the managers are told.'} onChange={(e) => setText(e.target.value)} autoFocus={!manager} /></label>{error && <p className="red-text">{error}</p>}<button className="primary" disabled={!text.trim() || saving}>{saving ? 'Saving…' : 'Save note'} <span>→</span></button></form></div>;
}
