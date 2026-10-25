import { useEffect, useId, useState } from 'react';
import { INSPECTION } from '../lib/constants';

// Overview stat cards: a figure, its change since yesterday, and a small chart of the last 7 days.
// `better` says which direction is good news ('up', or 'down' for problems such as flagged reports).
// Makes a card or row open something when tapped, or with Enter / Space from the keyboard.
export const clickable = (open) => (open ? { role: 'button', tabIndex: 0, onClick: open, onKeyDown: (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(); } } } : {});
// A person's name that opens their page; plain text when there is nowhere to go.
export function NameLink({ name, open }) {
  if (!open) return <>{name}</>;
  return <button type="button" className="name-chip" onClick={(event) => { event.stopPropagation(); open(); }}>{name}</button>;
}
export function StatCard({ label, value, delta, better = 'up', note, children, onOpen }) {
  const change = delta === undefined ? null : delta === 0 ? 'same' : (delta > 0) === (better === 'up') ? 'good' : 'bad';
  return <div className={`stat-card ${onOpen ? 'link' : ''}`} {...clickable(onOpen)}><h3>{label}{onOpen && <span className="go" aria-hidden="true">→</span>}</h3><div className="stat-body"><div className="stat-value">{value}{change && change !== 'same' && <svg className={`stat-arrow ${change}`} viewBox="0 0 12 14" aria-hidden="true"><path d={delta > 0 ? 'M6 1 11 7H8v6H4V7H1z' : 'M6 13 1 7h3V1h4v6h3z'} /></svg>}</div><small className="stat-note">{note ?? (delta === 0 ? 'Same as yesterday' : `${delta > 0 ? '+' : ''}${delta} from yesterday`)}</small><div className="stat-chart">{children}</div></div></div>;
}
export function MiniBars({ values, tone }) {
  const id = useId();
  const max = Math.max(1, ...values);
  return <svg viewBox="0 0 84 44" role="img" aria-label={`Last 7 days: ${values.join(', ')}`}><defs><pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" className={`bar-fill ${tone}`} /><rect width="2" height="5" className="bar-stripe" /></pattern></defs>{values.map((value, index) => { const height = Math.max(3, (value / max) * 42); const last = index === values.length - 1; return <rect key={index} x={index * 12} y={44 - height} width="8" height={height} rx="2" className={last ? '' : 'bar-rest'} fill={last ? `url(#${id})` : undefined} />; })}</svg>;
}
export function MiniArea({ values }) {
  const id = useId();
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => [2 + index * (80 / (values.length - 1)), 40 - (value / max) * 34]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [endX, endY] = points.at(-1);
  return <svg viewBox="0 0 84 44" role="img" aria-label={`Last 7 days: ${values.join(', ')}`}><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="area-top" /><stop offset="1" className="area-bottom" /></linearGradient></defs><path d={`${line} L${endX.toFixed(1)} 44 L2 44 Z`} fill={`url(#${id})`} /><path d={line} className="area-line" /><circle cx={endX} cy={endY} r="3.2" className="area-dot" /></svg>;
}
export function MiniGauge({ value, max }) {
  const share = max ? Math.min(1, value / max) : 0;
  const angle = Math.PI * (1 - share);
  const end = [42 + 34 * Math.cos(angle), 42 - 34 * Math.sin(angle)];
  return <svg viewBox="0 0 84 48" role="img" aria-label={`${value} of ${max}`}><path d="M8 42 A34 34 0 0 1 76 42" className="gauge-track" />{share > 0 && <path d={`M8 42 A34 34 0 0 1 ${end[0].toFixed(1)} ${end[1].toFixed(1)}`} className="gauge-fill" />}{share > 0 && <circle cx={end[0]} cy={end[1]} r="4.5" className="gauge-knob" />}</svg>;
}
export function PeriodSwitch({ period, setPeriod }) { return <div className="segmented" role="group" aria-label="Period">{[['year', 'This financial year'], ['all', 'All time']].map(([key, label]) => <button type="button" key={key} className={period === key ? 'active' : ''} aria-pressed={period === key} onClick={() => setPeriod(key)}>{label}</button>)}</div>; }
export function Lightbox({ image, close }) { useEffect(() => { const onKey = (e) => e.key === 'Escape' && close(); window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []); return <div className="lightbox" role="dialog" aria-label={image.name} onClick={close}><img src={image.url} alt={image.name} /><button type="button" className="close" aria-label="Close">×</button></div>; }
export function InspectionTotal({ scores }) { const values = INSPECTION.map((key) => scores?.[key]).filter((value) => value !== '' && value !== undefined && value !== null).map(Number).filter(Number.isFinite); const total = values.reduce((sum, value) => sum + value, 0); const recleanable = values.length === INSPECTION.length && total < 40; return <p className={`room-total ${recleanable ? 'red-text' : 'muted'}`}>Room total <b>{total}/50</b>{recleanable ? ' — needs a re-clean before guest check-in.' : ' · Under 40/50 total → this room needs a re-clean before guest check-in.'}</p>; }
export function Progress({ value, target }) { const percent = target ? Math.min(100, Math.round((Number(value) || 0) / target * 100)) : 0; return <div className={`progress ${target && Number(value) >= target ? 'done' : ''}`} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${percent}%` }} /></div>; }
export function Sparkline({ history }) { if (history.length < 2) return <span className="spark muted">—</span>; const max = Math.max(...history.map((point) => point.points), 1); const points = history.map((point, index) => `${(index / (history.length - 1)) * 76 + 2},${24 - (point.points / max) * 20}`).join(' '); return <svg className="spark" viewBox="0 0 80 26" role="img" aria-label={`Cumulative points: ${history.map((point) => point.points).join(', ')}`}><polyline points={points} /></svg>; }
export function useDraft(rows) { const saved = JSON.stringify(rows); const [draft, setDraft] = useState(rows); useEffect(() => setDraft(rows), [saved]); const update = (index, key, value) => setDraft((current) => current.map((row, i) => i === index ? { ...row, [key]: value } : row)); const tools = { add: (row) => setDraft((current) => [...current, row]), remove: (index) => setDraft((current) => current.filter((_, i) => i !== index)), reset: () => setDraft(rows), dirty: JSON.stringify(draft) !== saved }; return [draft, update, tools]; }
export function SaveBar({ tools, onSave }) { return <div className="save-bar">{tools.dirty && <span className="unsaved">Unsaved changes</span>}{tools.dirty && <button type="button" className="text" onClick={tools.reset}>Undo</button>}<button className="primary" disabled={!tools.dirty} onClick={onSave}>Save</button></div>; }
export function Empty({ text }) { return <div className="empty">{text}</div>; }
