import { deadlineLabel, isoDate, localToday, shiftDays } from './format';

// Date periods for looking back at reports and tasks: a few ready-made ones, or any from–to range. Weeks run Monday to
// Sunday, months from the 1st; an empty from or to leaves that end open.
export const DATE_PERIODS = [['all', 'All time'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Pick dates']];

const monday = (day) => shiftDays(day, -((new Date(`${day}T00:00:00`).getDay() + 6) % 7));
const monthEnd = (start) => { const last = new Date(`${start}T00:00:00`); last.setMonth(last.getMonth() + 1, 0); return isoDate(last); };

export function periodRange(period = 'all', from = '', to = '', today = localToday()) {
  switch (period) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const day = shiftDays(today, -1); return { from: day, to: day }; }
    case 'this_week': { const start = monday(today); return { from: start, to: shiftDays(start, 6) }; }
    case 'last_week': { const start = shiftDays(monday(today), -7); return { from: start, to: shiftDays(start, 6) }; }
    case 'this_month': { const start = `${today.slice(0, 7)}-01`; return { from: start, to: monthEnd(start) }; }
    case 'last_month': { const start = `${shiftDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`; return { from: start, to: monthEnd(start) }; }
    case 'custom': return { from: from || '', to: to || '' };
    default: return { from: '', to: '' };
  }
}

export const inPeriod = (date, { from, to }) => Boolean(date) && (!from || date >= from) && (!to || date <= to);

// "Last week · 26 Oct – 1 Nov 2026", "Today · 1 Nov 2026", or the picked range.
export function periodText(period, from, to) {
  if (!period || period === 'all') return 'All time';
  const range = periodRange(period, from, to);
  const name = DATE_PERIODS.find(([key]) => key === period)?.[1];
  const dates = range.from && range.to ? (range.from === range.to ? deadlineLabel(range.from) : `${new Date(`${range.from}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${deadlineLabel(range.to)}`) : range.from ? `from ${deadlineLabel(range.from)}` : range.to ? `until ${deadlineLabel(range.to)}` : '';
  return period === 'custom' ? dates || 'Pick dates' : `${name}${dates ? ` · ${dates}` : ''}`;
}
