import { useState } from 'react';
import { Empty, Progress } from '../../components/ui';
import { Icon } from '../../components/icons';
import { confirmAction } from '../../components/ConfirmDialog';
import { deadlineLabel, localToday } from '../../lib/format';

// ReviewPro guest ratings: how guests rate housekeeping on ReviewPro, as a %, for the four Department target categories.
// The manager checks ReviewPro often and types in what he reads, with the date. Every update is kept for the trend.
const STALE_DAYS = 30;
const daysSince = (date) => Math.floor((Date.parse(`${localToday()}T00:00:00`) - Date.parse(`${date}T00:00:00`)) / 86400000);
const round = (value) => Math.round(value * 10) / 10;

function Trend({ history, target }) {
  if (history.length < 2) return null;
  const width = 120; const height = 30; const pad = 3;
  const values = history.map((point) => point.score);
  const low = Math.min(...values, target ?? Infinity); const high = Math.max(...values, target ?? -Infinity);
  const span = high - low || 5;
  const x = (index) => pad + (index / (history.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - low) / span) * (height - pad * 2);
  return <svg className="guest-trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`ReviewPro trend: ${history.map((point) => `${deadlineLabel(point.date)} ${point.score}%`).join(', ')}`}>
    {target ? <line x1={pad} x2={width - pad} y1={y(target)} y2={y(target)} className="target" /> : null}
    <polyline points={history.map((point, index) => `${x(index).toFixed(1)},${y(point.score).toFixed(1)}`).join(' ')} />
  </svg>;
}

// The guest line under each Department target: the latest ReviewPro %, the change, when it was read, and the guest target.
export function GuestLine({ goal, guestTarget, setGuestTarget }) {
  const { latest, previous, history } = goal.guest || {};
  const change = latest && previous ? round(latest.score - previous.score) : null;
  const target = Number(guestTarget) || null;
  return <div className="smart-guest">
    <div className="smart-guest-now"><small>Guests · ReviewPro</small><b>{latest ? `${latest.score}%` : '—'}</b>
      {change !== null && <span className={`guest-change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`}>{change > 0 ? '▲ +' : change < 0 ? '▼ ' : '= '}{change} pts</span>}
      <small className={latest && daysSince(latest.date) > STALE_DAYS ? 'guest-stale' : 'muted'}>{latest ? `read ${deadlineLabel(latest.date)}` : 'not entered yet'}</small></div>
    <label>Guest target %<input type="number" min="0" max="100" placeholder="None" value={guestTarget ?? ''} onChange={(e) => setGuestTarget(e.target.value)} /></label>
    <Trend history={history || []} target={target} />
    {target && latest ? <div className="guest-progress"><Progress value={latest.score} target={target} /><small>{latest.score >= target ? 'Target reached' : `${round(target - latest.score)} pts to go`}</small></div> : <small className="muted">{target ? 'Waiting for a ReviewPro %' : 'No guest target set'}</small>}
  </div>;
}

// The update form (date + the four %) and the list of past updates.
export function GuestRatingsPanel({ goals, request, onSaved, readOnly = false }) {
  const categories = goals.smartGoals.map((goal) => [goal.key, goal.label]);
  const blank = () => ({ date: localToday(), note: '', scores: Object.fromEntries(categories.map(([key]) => [key, ''])) });
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const updates = goals.guestRatings || [];
  const save = async (event) => {
    event.preventDefault(); setError('');
    const scores = Object.fromEntries(Object.entries(form.scores).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)]));
    if (!Object.keys(scores).length) return setError('Enter the ReviewPro % for at least one category.');
    setSaving(true);
    try { const result = await request('/goals/guest-ratings', { method: 'POST', body: JSON.stringify({ date: form.date, scores, note: form.note }) }); onSaved(result.goals, 'ReviewPro ratings saved.'); setForm(blank()); } catch (problem) { setError(problem.message); } finally { setSaving(false); }
  };
  const remove = async (update) => {
    if (!await confirmAction({ title: `Delete the ReviewPro update of ${deadlineLabel(update.date)}?`, body: "Its % will no longer count. This can't be undone.", confirmLabel: 'Delete update', danger: true })) return;
    try { const result = await request(`/goals/guest-ratings/${update.id}`, { method: 'DELETE' }); onSaved(result.goals, 'Update deleted.'); } catch (problem) { setError(problem.message); }
  };
  const label = (key) => categories.find(([value]) => value === key)?.[1] || key;
  const shown = showAll ? updates : updates.slice(0, 5);
  return <section className="panel goals-section guest-ratings">
    <div className="panel-title"><div><p className="kicker">REVIEWPRO · GUEST RATINGS OF HOUSEKEEPING</p><h3>Update from ReviewPro</h3><small className="muted">Type in the % guests give housekeeping on ReviewPro for each category, with the date you read it. Leave a category blank if it hasn't changed. The latest % shows under each Department target above.</small></div></div>
    {!readOnly && <form className="guest-form" onSubmit={save}>
      <label>Date read<input type="date" max={localToday()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></label>
      {categories.map(([key, name]) => <label key={key}>{name} %<input type="number" inputMode="decimal" min="0" max="100" step="0.1" placeholder={goals.smartGoals.find((goal) => goal.key === key)?.guest?.latest ? `last ${goals.smartGoals.find((goal) => goal.key === key).guest.latest.score}` : 'e.g. 91'} value={form.scores[key]} onChange={(e) => setForm({ ...form, scores: { ...form.scores, [key]: e.target.value } })} /></label>)}
      <label className="wide">Note (optional)<input placeholder="e.g. last 30 days, 120 reviews" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <button className="primary" disabled={saving}><Icon name="check" />{saving ? 'Saving…' : 'Save ReviewPro update'}</button>
    </form>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <p className="kicker guest-history-title">PAST UPDATES</p>
    {updates.length ? <ul className="guest-history">{shown.map((update) => <li key={update.id}>
      <span><b>{deadlineLabel(update.date)}</b> · {Object.entries(update.scores).map(([key, value]) => `${label(key)} ${value}%`).join(' · ')}<small className="muted"> · by {update.by}{update.note ? ` · “${update.note}”` : ''}</small></span>
      {!readOnly && <button type="button" className="text" aria-label={`Delete the update of ${deadlineLabel(update.date)}`} onClick={() => remove(update)}><Icon name="trash" size={15} /></button>}
    </li>)}</ul> : <Empty text="No ReviewPro updates yet." />}
    {updates.length > 5 && <button type="button" className="text" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${updates.length} updates`}</button>}
  </section>;
}
