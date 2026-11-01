import { DATE_PERIODS } from '../lib/period';
import { localToday } from '../lib/format';

// Choose a period (Today … Last month) or pick a from–to range. onChange gets { period, from, to }.
export function PeriodPicker({ period = 'all', from = '', to = '', onChange, label = 'Period' }) {
  const today = localToday();
  const choose = (next) => onChange(next === 'custom' ? { period: next, from: from || today, to: to || today } : { period: next, from: '', to: '' });
  return <div className={`period-picker ${period === 'custom' ? 'custom' : ''}`}>
    <select aria-label={label} value={period} onChange={(e) => choose(e.target.value)}>{DATE_PERIODS.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>
    {period === 'custom' && <><input type="date" aria-label="From" value={from} max={to || today} onChange={(e) => onChange({ period, from: e.target.value, to })} /><span>to</span><input type="date" aria-label="To" value={to} min={from || undefined} max={today} onChange={(e) => onChange({ period, from, to: e.target.value })} /></>}
  </div>;
}
