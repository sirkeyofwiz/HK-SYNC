import { useState } from 'react';
import { Empty, Progress } from '../../components/ui';
import { Icon } from '../../components/icons';
import { confirmAction } from '../../components/ConfirmDialog';
import { deadlineLabel, localToday, plural } from '../../lib/format';

// Department targets → Guest review scores: the scores the manager reads on Booking.com, ReviewPro and other platforms,
// typed in with their date. Each platform keeps its own scale (out of 10, out of 5 or a %), and the history shows the trend.
const SCALES = [[10, 'Out of 10'], [5, 'Out of 5'], [100, '%']];
const STALE_DAYS = 45;
export const formatReviewScore = (score, scale) => (score === null || score === undefined ? '—' : scale === 100 ? `${score}%` : `${score}/${scale}`);
const daysSince = (date) => Math.floor((Date.parse(`${localToday()}T00:00:00`) - Date.parse(`${date}T00:00:00`)) / 86400000);
const round = (value) => Math.round(value * 100) / 100;

function Trend({ entries, scale, target }) {
  if (entries.length < 2) return null;
  const width = 220; const height = 56; const pad = 6;
  const values = entries.map((entry) => entry.score);
  const low = Math.min(...values, target ?? Infinity); const high = Math.max(...values, target ?? -Infinity);
  const span = high - low || scale / 10;
  const x = (index) => pad + (index / (entries.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - low) / span) * (height - pad * 2);
  const line = entries.map((entry, index) => `${x(index).toFixed(1)},${y(entry.score).toFixed(1)}`).join(' ');
  return <svg className="review-trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Trend: ${entries.map((entry) => `${deadlineLabel(entry.date)} ${formatReviewScore(entry.score, scale)}`).join(', ')}`}>
    {target !== null && target !== undefined && <line x1={pad} x2={width - pad} y1={y(target)} y2={y(target)} className="target" />}
    <polyline points={line} />
    {entries.map((entry, index) => <circle key={entry.id} cx={x(index)} cy={y(entry.score)} r="3"><title>{`${deadlineLabel(entry.date)}: ${formatReviewScore(entry.score, scale)}`}</title></circle>)}
  </svg>;
}

function ScoreCard({ row, request, onSaved, readOnly }) {
  const [form, setForm] = useState({ date: localToday(), score: '', note: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);
  const { latest, previous, scale, target } = row;
  const change = latest && previous ? round(latest.score - previous.score) : null;
  const stale = latest && daysSince(latest.date) > STALE_DAYS;
  const add = async (event) => {
    event.preventDefault(); setError('');
    if (form.score === '') return setError('Enter the score.');
    setSaving(true);
    try { const result = await request(`/goals/review-scores/${row.key}/entries`, { method: 'POST', body: JSON.stringify({ date: form.date, score: Number(form.score), note: form.note }) }); onSaved(result.reviewScores, `${row.label}: ${formatReviewScore(Number(form.score), scale)} saved.`); setForm({ date: localToday(), score: '', note: '' }); } catch (problem) { setError(problem.message); } finally { setSaving(false); }
  };
  const remove = async (entry) => {
    if (!await confirmAction({ title: `Delete the ${formatReviewScore(entry.score, scale)} from ${deadlineLabel(entry.date)}?`, body: `${row.label}. This can't be undone.`, confirmLabel: 'Delete score', danger: true })) return;
    try { const result = await request(`/goals/review-scores/${row.key}/entries/${entry.id}`, { method: 'DELETE' }); onSaved(result.reviewScores, 'Score deleted.'); } catch (problem) { setError(problem.message); }
  };
  return <article className="review-card">
    <div className="review-head"><strong>{row.label}</strong><small className="muted">{SCALES.find(([value]) => value === scale)?.[1]}</small></div>
    <div className="review-now">
      <b className="review-score">{formatReviewScore(latest?.score, scale)}</b>
      {change !== null && <span className={`review-change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`}>{change > 0 ? '▲' : change < 0 ? '▼' : '='} {change > 0 ? '+' : ''}{change}{scale === 100 ? ' pts' : ''} since {deadlineLabel(previous.date)}</span>}
    </div>
    {latest ? <small className={stale ? 'review-stale' : 'muted'}>{stale ? `Not updated for ${daysSince(latest.date)} days · ` : ''}Read on {deadlineLabel(latest.date)} · by {latest.by}{latest.note ? ` · “${latest.note}”` : ''}</small> : <small className="muted">No score yet. Add the score you read on the platform.</small>}
    {target ? <div className="review-target"><Progress value={latest?.score || 0} target={target} /><small>Target {formatReviewScore(target, scale)}{latest ? ` · ${latest.score >= target ? 'reached' : `${round(target - latest.score)}${scale === 100 ? ' pts' : ''} to go`}` : ''}</small></div> : <small className="muted">No target set · Edit rows to set one</small>}
    <Trend entries={row.entries.slice(-12)} scale={scale} target={target} />
    {!readOnly && <form className="review-add" onSubmit={add}>
      <label>Date read<input type="date" max={localToday()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></label>
      <label>Score{scale === 100 ? ' %' : ` /${scale}`}<input type="number" inputMode="decimal" min="0" max={scale} step={scale === 100 ? '1' : '0.1'} placeholder={scale === 100 ? '92' : scale === 10 ? '8.9' : '4.5'} value={form.score} onChange={(e) => setForm({ ...form, score: e.target.value })} /></label>
      <label className="wide">Note (optional)<input placeholder="e.g. 214 reviews, last 12 months" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <button className="primary" disabled={saving}><Icon name="plus" />{saving ? 'Saving…' : 'Add score'}</button>
    </form>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {row.entries.length > 0 && <button type="button" className="text review-history-toggle" aria-expanded={history} onClick={() => setHistory(!history)}>{history ? 'Hide history' : `History · ${plural(row.entries.length, 'score')}`}</button>}
    {history && <ul className="review-history">{[...row.entries].reverse().map((entry) => <li key={entry.id}><span><b>{formatReviewScore(entry.score, scale)}</b> · {deadlineLabel(entry.date)} · {entry.by}{entry.note ? ` · “${entry.note}”` : ''}</span>{!readOnly && <button type="button" className="text" aria-label={`Delete the score from ${deadlineLabel(entry.date)}`} onClick={() => remove(entry)}><Icon name="trash" size={15} /></button>}</li>)}</ul>}
  </article>;
}

function EditRows({ rows, request, onSaved, close }) {
  const [draft, setDraft] = useState(rows.map(({ key, label, scale, target, entries }) => ({ key, label, scale, target: target ?? '', count: entries.length })));
  const [error, setError] = useState('');
  const set = (index, field, value) => setDraft((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  const save = async () => {
    setError('');
    const removed = rows.filter((row) => row.entries.length && !draft.some((entry) => entry.key === row.key));
    if (removed.length && !await confirmAction({ title: `Remove ${removed.map((row) => row.label).join(', ')}?`, body: `Their ${plural(removed.reduce((sum, row) => sum + row.entries.length, 0), 'saved score')} will be deleted too.`, confirmLabel: 'Remove', danger: true })) return;
    try { const result = await request('/goals/review-scores', { method: 'PUT', body: JSON.stringify({ rows: draft.map(({ key, label, scale, target }) => ({ key, label, scale: Number(scale), target: target === '' ? null : Number(target) })) }) }); onSaved(result.reviewScores, 'Review scores saved.'); close(); } catch (problem) { setError(problem.message); }
  };
  return <div className="review-edit">
    {draft.map((row, index) => <div className="review-edit-row" key={row.key || `new-${index}`}>
      <label>Name<input value={row.label} placeholder="e.g. Google – Overall" onChange={(e) => set(index, 'label', e.target.value)} /></label>
      <label>Scale<select value={row.scale} disabled={row.count > 0} title={row.count > 0 ? "This row has scores, so its scale can't change" : undefined} onChange={(e) => set(index, 'scale', Number(e.target.value))}>{SCALES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Target<input type="number" inputMode="decimal" min="0" max={row.scale} step={row.scale === 100 ? '1' : '0.1'} placeholder="None" value={row.target} onChange={(e) => set(index, 'target', e.target.value)} /></label>
      <button type="button" className="text remove-row" aria-label={`Remove ${row.label || 'this row'}`} onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}><Icon name="trash" size={16} /></button>
    </div>)}
    <button type="button" className="add" onClick={() => setDraft((current) => [...current, { key: null, label: '', scale: 10, target: '', count: 0 }])}><Icon name="plus" />Add a review score</button>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="review-edit-actions"><button type="button" className="text" onClick={close}>Cancel</button><button type="button" className="primary" onClick={save}>Save rows</button></div>
  </div>;
}

export function ReviewScores({ rows = [], request, onChange, readOnly = false }) {
  const [editing, setEditing] = useState(false);
  const onSaved = (next, note) => onChange(next, note);
  return <section className="panel goals-section review-scores">
    <div className="panel-title"><div><p className="kicker">GUEST REVIEW SCORES</p><h3>Booking.com, ReviewPro and other platforms</h3><small className="muted">Type in the score you read on each platform, with the date you read it. Every score is kept, so you can see whether it is going up or down.</small></div>{!readOnly && !editing && <button type="button" className="secondary" onClick={() => setEditing(true)}><Icon name="edit" />Edit rows</button>}</div>
    {editing ? <EditRows rows={rows} request={request} onSaved={onSaved} close={() => setEditing(false)} />
      : rows.length ? <div className="review-grid">{rows.map((row) => <ScoreCard key={row.key} row={row} request={request} onSaved={onSaved} readOnly={readOnly} />)}</div>
        : <Empty text="No review scores yet. Press Edit rows to add one." />}
  </section>;
}
