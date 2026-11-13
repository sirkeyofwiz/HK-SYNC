import { useState } from 'react';
import { localToday, shiftDays } from '../lib/format';

// One way to look back in history, everywhere: a single drop-down. It replaces the Week/Month switch, the ‹ › arrows
// and the "Go to" calendar. Choices: This week, Last week, This month, Last month, then each earlier month by name
// (a year back), and "Pick a week…" / "Earlier month…" for anything older, which shows one date box.
// The view is { span: 'week' | 'month', anchor: 'YYYY-MM-DD' } (any day inside the week or month), as the charts use.
const monday = (day) => shiftDays(day, -((new Date(`${day}T00:00:00`).getDay() + 6) % 7));
const monthOf = (day) => day.slice(0, 7);
const monthBack = (month, by) => { const date = new Date(`${month}-01T00:00:00`); date.setMonth(date.getMonth() - by); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; };
const monthName = (month) => new Date(`${month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

export function HistorySelect({ span, anchor, onChange, spans = ['week', 'month'], months = 12, today = localToday(), label = 'Period' }) {
  const [picking, setPicking] = useState(false);
  const weeks = spans.includes('week'); const monthly = spans.includes('month');
  const thisMonth = monthOf(today);
  const named = monthly ? Array.from({ length: Math.max(0, months - 2) }, (_, index) => monthBack(thisMonth, index + 2)) : [];
  let value;
  if (picking) value = `${span}:pick`;
  else if (span === 'week') value = monday(anchor) === monday(today) ? 'week:this' : monday(anchor) === shiftDays(monday(today), -7) ? 'week:last' : 'week:pick';
  else { const month = monthOf(anchor); value = month === thisMonth ? 'month:this' : month === monthBack(thisMonth, 1) ? 'month:last' : named.includes(month) ? `month:${month}` : 'month:pick'; }
  const choose = (next) => {
    const [nextSpan, what] = next.split(':');
    setPicking(what === 'pick');
    if (what === 'this') onChange({ span: nextSpan, anchor: today });
    else if (what === 'last') onChange({ span: nextSpan, anchor: nextSpan === 'week' ? shiftDays(monday(today), -7) : `${monthBack(thisMonth, 1)}-01` });
    else if (what === 'pick') onChange({ span: nextSpan, anchor: nextSpan === span ? anchor : today });
    else onChange({ span: 'month', anchor: `${what}-01` });
  };
  const showDate = value.endsWith(':pick');
  return <div className="history-select">
    <select aria-label={label} value={value} onChange={(e) => choose(e.target.value)}>
      {weeks && <optgroup label="Weeks"><option value="week:this">This week</option><option value="week:last">Last week</option><option value="week:pick">Pick a week…</option></optgroup>}
      {monthly && <optgroup label="Months"><option value="month:this">This month</option><option value="month:last">Last month</option>{named.map((month) => <option key={month} value={`month:${month}`}>{monthName(month)}</option>)}<option value="month:pick">Earlier month…</option></optgroup>}
    </select>
    {showDate && (span === 'week'
      ? <input type="date" aria-label="Any day in the week" value={anchor} max={today} onChange={(e) => e.target.value && onChange({ span, anchor: e.target.value })} />
      : <input type="month" aria-label="Month" value={monthOf(anchor)} max={thisMonth} onChange={(e) => e.target.value && onChange({ span, anchor: `${e.target.value}-01` })} />)}
  </div>;
}

// The simple version for lists that only need a few fixed choices (Today / Last 7 days …, This financial year / All time).
export function ChoiceSelect({ value, onChange, options, label = 'Period' }) {
  return <div className="history-select"><select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></div>;
}
