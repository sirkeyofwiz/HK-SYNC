import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { DayCalendar } from './DayCalendar';

// A small date button. Tapping it opens a calendar; tapping a day picks it and closes the calendar.
// Shows the chosen day on the button, with × to go back to all days.
export function DayPicker({ value = '', counts = {}, onPick, onClear, label = 'records', placeholder = 'Pick a day' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => !ref.current?.contains(event.target) && setOpen(false);
    const onKey = (event) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown); window.addEventListener('touchstart', onDown); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const text = value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : placeholder;
  return <div className="day-picker" ref={ref}>
    <button type="button" className={`day-picker-button ${value ? 'chosen' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}><Icon name="calendar" size={17} /><span>{text}</span></button>
    {value && <button type="button" className="day-picker-clear" aria-label="Show all days" title="Show all days" onClick={() => { onClear(); setOpen(false); }}>×</button>}
    {open && <div className="day-picker-pop" role="dialog" aria-label="Pick a day"><DayCalendar value={value} counts={counts} label={label} onPick={(day) => { onPick(day); setOpen(false); }} onClear={() => { onClear(); setOpen(false); }} /></div>}
  </div>;
}
