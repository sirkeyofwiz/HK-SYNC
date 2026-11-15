import { useState } from 'react';
import { localToday } from '../lib/format';

// A month calendar to pick one day. Days that have something (counts[day] > 0) show a dot with the number, so you can
// see at a glance which days have records. Future days cannot be picked. Weeks run Monday to Sunday.
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const one = (n, label) => `${n} ${n === 1 ? label.replace(/s$/, '') : label}`;
const pad = (n) => String(n).padStart(2, '0');
const monthOf = (day) => day.slice(0, 7);
const shiftMonth = (month, by) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + by, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

export function DayCalendar({ value = '', counts = {}, onPick, onClear, label = 'records' }) {
  const today = localToday();
  const [month, setMonth] = useState(() => monthOf(value || today));
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const blanks = (first.getDay() + 6) % 7;
  const cells = [...Array(blanks).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${pad(i + 1)}`)];
  const inMonth = Object.entries(counts).filter(([day]) => monthOf(day) === month).reduce((sum, [, n]) => sum + n, 0);
  const title = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const pick = (day) => { onPick(day); setMonth(monthOf(day)); };
  return <div className="day-calendar">
    <div className="day-calendar-head">
      <button type="button" className="round-nav" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
      <div className="day-calendar-title"><b>{title}</b><small className="muted">{one(inMonth, label)} this month</small></div>
      <button type="button" className="round-nav" aria-label="Next month" disabled={month >= monthOf(today)} onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
    </div>
    <div className="day-calendar-grid" role="grid" aria-label={title}>
      {WEEKDAYS.map((name) => <span key={name} className="day-calendar-weekday" aria-hidden="true">{name.slice(0, 2)}</span>)}
      {cells.map((day, index) => {
        if (!day) return <span key={`blank-${index}`} />;
        const count = counts[day] || 0;
        const future = day > today;
        return <button type="button" key={day} disabled={future} aria-pressed={day === value} aria-label={`${new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}: ${one(count, label)}`}
          className={`day-cell ${day === value ? 'selected' : ''} ${day === today ? 'today' : ''} ${count ? 'has' : ''}`} onClick={() => pick(day)}>
          <span>{Number(day.slice(8))}</span>{count > 0 && <i>{count}</i>}
        </button>;
      })}
    </div>
    <div className="day-calendar-foot">
      <button type="button" className="text" onClick={() => pick(today)}>Today</button>
      {value && <button type="button" className="text" onClick={onClear}>Show all days</button>}
    </div>
  </div>;
}
