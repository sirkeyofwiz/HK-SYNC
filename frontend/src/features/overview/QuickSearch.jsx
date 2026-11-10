import { useMemo, useRef, useState } from 'react';
import { TYPES } from '../../lib/constants';
import { deadlineLabel } from '../../lib/format';
import { Icon } from '../../components/icons';

// Overview quick search: one box that finds people, rooms, reports, tasks and pages, so anything is a tap away.
// Every word typed must appear somewhere in a result ("happy quality" finds Happy's Quality Checklists).
const PER_GROUP = 5;
const LISTS = ['entries', 'trolleys', 'pantries'];
const lines = (report) => LISTS.flatMap((list) => (Array.isArray(report.data?.[list]) ? report.data[list] : []).map((entry, index) => ({ entry, list, index })));
const words = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (haystack, terms) => { const text = haystack.toLowerCase(); return terms.every((term) => text.includes(term)); };
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');

const PAGES = [
  ['reports', 'Reports', 'All reports, filters and exports', false],
  ['tasks', 'Tasks', 'Follow-ups and who they are assigned to', false],
  ['messages', 'Messages', 'Chats and groups', false],
  ['people', 'People', 'Housekeeper and supervisor profiles, staff accounts', true],
  ['goals', 'Goals', 'Points, targets and housekeeping progress', true],
  ['review', 'Contract review', 'End-of-year evidence for contracts', true],
  ['account', 'Account', 'Your password and notifications', false]
];

function search(query, { reports, tasks, staff, goals, isManager, allowedTypes }) {
  const terms = words(query);
  if (!terms.length) return [];
  const groups = [];
  const add = (title, items) => { if (items.length) groups.push({ title, items: items.slice(0, PER_GROUP), more: Math.max(0, items.length - PER_GROUP) }); };

  if (isManager) {
    const hk = (goals?.hkPoints || []).filter((row) => row.onRoster && matches(row.name, terms))
      .map((row) => ({ key: `hk-${row.name}`, icon: 'people', title: row.name, detail: `Housekeeper · ${row.rooms || 0} rooms inspected this year`, open: 'hk', name: row.name }));
    const sup = staff.filter((person) => person.role === 'supervisor' && person.active !== false && matches(`${person.name} ${person.email || ''}`, terms))
      .map((person) => ({ key: `sup-${person.id}`, icon: 'people', title: person.name, detail: 'Supervisor', open: 'sup', id: person.id, name: person.name }));
    add('People', [...sup, ...hk]);
  }

  // A room number finds every report line about that room, newest first.
  const rooms = [];
  for (const report of reports) {
    for (const { entry, list, index } of lines(report)) {
      const room = String(entry?.room || '').trim();
      if (!room || !terms.some((term) => room.toLowerCase() === term) || !matches(`${room} ${TYPES[report.type] || ''} ${entry.hkName || ''} ${report.submitter?.name || ''}`, terms)) continue;
      rooms.push({ key: `room-${report.id}-${list}-${index}`, icon: 'rooms', title: `Room ${room} · ${TYPES[report.type] || report.type}`, detail: [entry.hkName, entry.status, `by ${report.submitter?.name || 'Unknown'}`, shortDate(report.date)].filter(Boolean).join(' · '), open: 'report', id: report.id, line: { list, index } });
    }
  }
  add('Rooms', rooms);

  const found = reports.filter((report) => {
    const names = lines(report).map(({ entry }) => `${entry?.hkName || ''} ${entry?.room || ''}`).join(' ');
    return matches(`${TYPES[report.type] || report.type} ${report.submitter?.name || ''} ${report.date} ${shortDate(report.date)} ${report.data?.block || ''} ${report.data?.area || ''} ${report.data?.supervisorName || ''} ${names}`, terms);
  }).map((report) => {
    const hk = [...new Set(lines(report).map(({ entry }) => String(entry?.hkName || '').trim()).filter(Boolean))];
    return { key: `report-${report.id}`, icon: 'reports', title: TYPES[report.type] || report.type, detail: [report.data?.supervisorName, hk.length ? (hk.length > 2 ? `${hk.slice(0, 2).join(', ')} +${hk.length - 2}` : hk.join(', ')) : '', `by ${report.submitter?.name || 'Unknown'}`, shortDate(report.date)].filter(Boolean).join(' · '), open: 'report', id: report.id };
  });
  add('Reports', found);

  const assignee = (id) => staff.find((person) => person.id === id)?.name || '';
  add('Tasks', tasks.filter((task) => matches(`${task.title || ''} ${task.location || ''} ${task.description || ''} ${assignee(task.assignedTo)} ${task.status || ''}`, terms))
    .map((task) => ({ key: `task-${task.id}`, icon: 'tasks', title: task.title || 'Task', detail: [task.status === 'completed' ? 'Done' : 'Open', task.location, assignee(task.assignedTo) && `for ${assignee(task.assignedTo)}`, task.dueDate && `due ${deadlineLabel(task.dueDate)}`].filter(Boolean).join(' · '), open: 'task', id: task.id })));

  add('New report', allowedTypes.filter((type) => matches(`new ${TYPES[type]} report`, terms))
    .map((type) => ({ key: `new-${type}`, icon: 'plus', title: `New ${TYPES[type]}`, detail: 'Start this report', open: 'new', type })));

  add('Pages', PAGES.filter(([, label, detail, managerOnly]) => (!managerOnly || isManager) && matches(`${label} ${detail}`, terms))
    .map(([page, label, detail]) => ({ key: `page-${page}`, icon: page === 'people' ? 'people' : page === 'account' ? 'account' : page === 'review' ? 'review' : page, title: label, detail, open: 'page', page })));
  return groups;
}

export function QuickSearch({ reports, tasks, staff, goals, isManager, allowedTypes, setPage, openReport, openTask, openProfile, openSupervisor, chooseType }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const groups = useMemo(() => search(query, { reports, tasks, staff, goals, isManager, allowedTypes }), [query, reports, tasks, staff, goals, isManager, allowedTypes]);
  const first = groups[0]?.items[0];
  const go = (item) => {
    setOpen(false); setQuery('');
    if (item.open === 'hk') openProfile(item.name);
    else if (item.open === 'sup') openSupervisor(item.id, item.name);
    else if (item.open === 'report') openReport(item.id, item.line || null);
    else if (item.open === 'task') openTask(item.id);
    else if (item.open === 'new') chooseType(item.type);
    else if (item.open === 'page') { setPage(item.page); window.scrollTo(0, 0); }
  };
  const showing = open && query.trim();
  return <div className="quick-search" ref={box} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget)) setOpen(false); }}>
    <label className="quick-search-field"><Icon name="search" size={18} /><input type="search" placeholder={isManager ? 'Search people, rooms, reports, tasks…' : 'Search rooms, reports, tasks…'} aria-label="Search" value={query}
      onChange={(e) => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' && first) { e.preventDefault(); go(first); } if (e.key === 'Escape') { setQuery(''); setOpen(false); } }} /></label>
    {showing && <div className="quick-results" role="listbox" aria-label="Search results">
      {groups.length ? groups.map((group) => <div className="quick-group" key={group.title}><p className="kicker">{group.title}</p>
        {group.items.map((item) => <button type="button" role="option" aria-selected={item === first} className={`quick-item ${item === first ? 'first' : ''}`} key={item.key} onClick={() => go(item)}><Icon name={item.icon} size={18} /><span><b>{item.title}</b>{item.detail && <small>{item.detail}</small>}</span></button>)}
        {group.more > 0 && <small className="muted quick-more">+{group.more} more · type more to narrow it down</small>}</div>)
        : <p className="muted quick-empty">Nothing found for “{query.trim()}”.</p>}
    </div>}
  </div>;
}
