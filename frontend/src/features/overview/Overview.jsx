import { Fragment, useEffect, useRef, useState } from 'react';
import { periodRange, periodText } from '../../lib/period';
import { Empty, MiniArea, MiniBars, MiniGauge, NameLink, Progress, StatCard, clickable } from '../../components/ui';
import { teamAverage } from '../goals/Goals';
import { VehicleChecks, vehicleName, vehicleProblems } from '../reports/VehicleChecks';
import { PRIORITY_ORDER, TaskCard } from '../tasks/Tasks';
import { RemarksPanel } from './Remarks';
import { QuickSearch } from './QuickSearch';
import { HK_REPORT_TYPES, IRP_PASS, NOT_INSPECTIONS, NOT_ROOMS, TYPES } from '../../lib/constants';
import { dayLabel, daysAgo, deadlineLabel, isoDate, localToday, plural, reportHousekeepers, shiftDays } from '../../lib/format';
import { Icon } from '../../components/icons';

// One housekeeper on the Overview performance lists; tapping opens their profile.
export function PerformanceRow({ row, tone, openProfile }) {
  return <button type="button" className={`perf-row ${tone}`} onClick={() => openProfile(row.name)}><span className="perf-name"><b>{row.name}</b><small>{[row.rooms ? plural(row.rooms, 'room') : '', row.checks ? plural(row.checks, 'guest check') : ''].filter(Boolean).join(' · ')}{tone === 'poor' && row.below?.length ? ` · ${row.below.map((area) => `${area.label.toLowerCase()} ${area.average}`).join(' · ')}` : ''}{tone === 'poor' && row.weakest ? ` · weakest: ${row.weakest.label} ${row.weakest.average}` : ''}</small></span><span className="perf-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, row.average * 10)}%` }} /></span><strong>{row.average.toFixed(1)}</strong></button>;
}
// Overview "Supervisor points": each supervisor's Inspection Rate Program points toward the yearly target.
export function SupervisorPointsPanel({ goals, setPage, openSupervisor }) {
  const { supervisor: target, deadline } = goals.targets;
  const rows = [...goals.supervisorPoints].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  return <section className="panel performance-panel"><div className="panel-title"><div><p className="kicker">SUPERVISOR POINTS · {goals.year}</p><h3>Progress to {target} points</h3><small className="muted">Points from Inspection Rate Program rooms that pass ({IRP_PASS}/60 or more) · target by {deadlineLabel(deadline)}</small></div><button className="text" onClick={() => setPage('goals')}>View tracker →</button></div>
    <div className="perf-list sup-points"><PerfScroll count={rows.length}>{rows.map((row) => <button type="button" key={row.id} className={`perf-row ${row.points >= target ? 'good' : 'goal'}`} onClick={() => openSupervisor(row.id, row.name)}><span className="perf-name"><b>{row.name}</b><small>{row.rooms ? `${row.passedRooms ?? row.rooms} of ${plural(row.rooms, 'room')} passed · avg ${row.roomAverage}/60 · last ${deadlineLabel(row.lastInspected)}` : 'Not inspected yet this year'}</small></span><span className="perf-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, row.points / target * 100)}%` }} /></span><strong>{row.points}<small>/{target}</small></strong></button>)}</PerfScroll>{!rows.length && <Empty text="No active supervisors yet." />}</div></section>;
}
// Look back: the panels show the last 30 days, or a past week or month. A past period is fetched when picked; the
// default comes with the Overview's own refresh.
const PERF_PERIODS = [['30', 'Last 30 days'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month']];
function usePerformancePeriod(performance, request) {
  const [period, setPeriod] = useState('30');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // The app's request function is new on every render, so it is read from a ref: only a new period fetches again.
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    if (period === '30' || !requestRef.current) { setData(null); setError(''); return undefined; }
    let live = true;
    const { from, to } = periodRange(period);
    setData(null); setError('');
    requestRef.current(`/hk-performance?from=${from}&to=${to}`).then((result) => { if (live) setData(result); }).catch((problem) => { if (live) setError(problem.message || 'Could not load this period.'); });
    return () => { live = false; };
  }, [period]);
  const label = period === '30' ? `LAST ${performance.days} DAYS` : periodText(period).toUpperCase();
  const words = period === '30' ? `in the last ${performance.days} days` : PERF_PERIODS.find(([key]) => key === period)[1].toLowerCase();
  return { period, setPeriod, shown: period === '30' ? performance : data, error, label, words };
}
function PeriodPicker({ period, setPeriod }) {
  return <label className="perf-period"><span className="sr-only">Period</span><select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Period">{PERF_PERIODS.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>;
}

// Every inspected person is on one of the lists. A list is about five rows tall and scrolls inside itself, so a long
// list never stretches the page. When it does scroll, a note under it says how many names it holds.
function PerfScroll({ count, children }) {
  const box = useRef(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const check = () => setScrolls(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  return <><div className="perf-scroll" ref={box} tabIndex={scrolls ? 0 : undefined}>{children}</div>{scrolls && <small className="muted perf-count">{count} names · scroll for more</small>}</>;
}
export function PerformancePanel({ performance: current, openProfile, setPage, request }) {
  const { period, setPeriod, shown, error, label, words } = usePerformancePeriod(current, request);
  const head = <div className="panel-head-actions"><PeriodPicker period={period} setPeriod={setPeriod} /><button className="text" onClick={() => setPage('people')}>All profiles →</button></div>;
  if (!shown) return <section className="panel performance-panel"><div className="panel-title"><div><p className="kicker">HOUSEKEEPER PERFORMANCE · {label}</p><h3>Who is doing well, who needs support</h3></div>{head}</div>{error ? <p className="red-text">{error}</p> : <Empty text="Loading this period…" />}</section>;
  const performance = shown;
  const { top, support, minRooms, goodAt, supportBelow, ranked, inspected } = performance;
  return <section className="panel performance-panel"><div className="panel-title"><div><p className="kicker">HOUSEKEEPER PERFORMANCE · {label}</p><h3>Who is doing well, who needs support</h3><small className="muted">Average score out of 10 (rooms and guest interaction checks) · {minRooms > 1 ? `housekeepers with at least ${minRooms} inspected rooms · ${ranked} of ${inspected} ranked` : `${plural(inspected, "housekeeper")} inspected`}</small></div>{head}</div>
    <div className="perf-columns">
      <div className="perf-list"><h4 className="good">Performing well <small>{goodAt.toFixed(1)} and above</small></h4><PerfScroll count={top.length}>{top.map((row) => <PerformanceRow key={row.name} row={row} tone="good" openProfile={openProfile} />)}</PerfScroll>{!top.length && <Empty text={`No one at ${goodAt.toFixed(1)} or above ${words}.`} />}</div>
      <div className="perf-list"><h4 className="poor">Need support <small>below {supportBelow.toFixed(1)} overall, in rooms or in guest interaction</small></h4><PerfScroll count={support.length}>{support.map((row) => <PerformanceRow key={row.name} row={row} tone="poor" openProfile={openProfile} />)}</PerfScroll>{!support.length && <Empty text={`Nobody below ${supportBelow.toFixed(1)}. Well done, team.`} />}</div>
    </div></section>;
}
// Overview "Supervisor performance": the same two lists for supervisors, from the Inspection Rate Program rooms that
// managers inspected in the last 30 days (out of 60 per room), split at the pass mark: 36/60 and above is doing well,
// below needs support. Tapping a name opens the supervisor's profile.
export function SupervisorPerformanceRow({ row, tone, openSupervisor }) {
  return <button type="button" className={`perf-row ${tone}`} onClick={() => openSupervisor(row.id, row.name)}><span className="perf-name"><b>{row.name}</b><small>{plural(row.rooms, 'room')} inspected{row.failed ? ` · ${row.failed} failed` : ''}{tone === 'poor' && row.weakest ? ` · weakest: ${row.weakest.label} ${row.weakest.average}` : ''}</small></span><span className="perf-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, row.average * 10)}%` }} /></span><strong>{row.roomAverage}<small>/60</small></strong></button>;
}
export function SupervisorPerformancePanel({ performance: current, openSupervisor, setPage, request }) {
  const { period, setPeriod, shown, error, label, words } = usePerformancePeriod(current, request);
  const head = <div className="panel-head-actions"><PeriodPicker period={period} setPeriod={setPeriod} /><button className="text" onClick={() => setPage('people')}>All profiles →</button></div>;
  if (!shown?.supervisors) return <section className="panel performance-panel sup-performance"><div className="panel-title"><div><p className="kicker">SUPERVISOR PERFORMANCE · {label}</p><h3>Who is doing well, who needs support</h3></div>{head}</div>{error ? <p className="red-text">{error}</p> : <Empty text="Loading this period…" />}</section>;
  const { top, support, inspected, total, notInspected, passAt = IRP_PASS } = shown.supervisors;
  const good = passAt;
  const low = passAt;
  return <section className="panel performance-panel sup-performance"><div className="panel-title"><div><p className="kicker">SUPERVISOR PERFORMANCE · {label}</p><h3>Who is doing well, who needs support</h3><small className="muted">Average Inspection Rate Program room score out of 60 · {inspected} of {plural(total, 'supervisor')} inspected · {passAt}/60 is the pass mark</small></div>{head}</div>
    <div className="perf-columns">
      <div className="perf-list"><h4 className="good">Performing well <small>{good}/60 and above</small></h4><PerfScroll count={top.length}>{top.map((row) => <SupervisorPerformanceRow key={row.id} row={row} tone="good" openSupervisor={openSupervisor} />)}</PerfScroll>{!top.length && <Empty text={`No supervisor at ${good}/60 or above ${words}.`} />}</div>
      <div className="perf-list"><h4 className="poor">Need support <small>below {low}/60</small></h4><PerfScroll count={support.length}>{support.map((row) => <SupervisorPerformanceRow key={row.id} row={row} tone="poor" openSupervisor={openSupervisor} />)}</PerfScroll>{!support.length && <Empty text={`No supervisor below ${low}/60. Well done, team.`} />}</div>
    </div>
    {notInspected.length > 0 && <p className="muted not-inspected">Not inspected {words}: {notInspected.map((person, index) => <span key={person.id}>{index ? ', ' : ''}<button type="button" className="text" onClick={() => openSupervisor(person.id, person.name)}>{person.name}</button></span>)}. Add an Inspection Rate Program report to see how they are doing.</p>}
  </section>;
}
// Today's field staff: who has filed a report and who has not. A supervisor opens their profile; anyone else their reports today.
const FIELD_ROLES = ['supervisor', 'driver', 'storekeeper', 'store_supervisor', 'laundry'];
function ActiveStaffDialog({ staff, todayReports, close, openSup, openReports }) {
  const filed = new Set(todayReports.map((item) => item.submittedBy));
  const people = staff.filter((person) => (FIELD_ROLES.includes(person.role) && person.active !== false) || filed.has(person.id)).map((person) => ({ ...person, count: todayReports.filter((item) => item.submittedBy === person.id).length })).sort((a, b) => Number(b.count > 0) - Number(a.count > 0) || a.name.localeCompare(b.name));
  const open = (person) => { close(); const profile = openSup(person.id, person.name); if (profile) profile(); else openReports({ date: localToday(), focus: { label: `${person.name}'s reports`, personId: person.id } }); };
  return <div className="backdrop" onClick={close}><div className="modal staff-today" role="dialog" aria-label="Active staff today" onClick={(event) => event.stopPropagation()}><button type="button" className="close" onClick={close} aria-label="Close">×</button><p className="kicker">TODAY · {deadlineLabel(localToday())}</p><h2>Active staff</h2><p className="muted">{people.filter((person) => person.count).length} of {people.length} have filed a report today. Tap a name to see their work.</p><div className="staff-today-list">{people.map((person) => <button type="button" key={person.id} className={`staff-today-row ${person.count ? 'on' : ''}`} onClick={() => open(person)}><i aria-hidden="true" /><span><b>{person.name}</b><small>{String(person.role).replace('_', ' ')}</small></span><small>{person.count ? `${plural(person.count, 'report')} today` : 'No report yet today'}</small><b aria-hidden="true">→</b></button>)}</div></div></div>;
}
export function Overview({ reports, tasks, goals, staff, openReport, chooseType, setPage, allowedTypes, isManager, performance, openProfile, openSupervisor, userId, newTask, request, openReports = () => setPage('reports'), openTask = () => setPage('tasks') }) { const [staffOpen, setStaffOpen] = useState(false); const supervisorIds = new Set(staff.filter((person) => person.role === 'supervisor').map((person) => person.id)); /* Profiles are for managers; a name opens one only when there is a profile to open. */ const openHk = (name) => (isManager && name ? () => openProfile(name) : null); const openSup = (id, name) => (isManager && supervisorIds.has(id) ? () => openSupervisor(id, name) : null); const today = localToday(); const mine = isManager ? null : userId; /* Staff counts cover only what they filed: handovers handed to them appear in their lists but are not their work. */ const counted = isManager ? reports : reports.filter((item) => item.submittedBy === userId); const todayReports = counted.filter((item) => item.date === localToday()); const openTasks = tasks.filter((task) => task.status !== 'completed' && (isManager || task.assignedTo === userId)); const topTasks = [...openTasks].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || String(a.dueDate || '9').localeCompare(String(b.dueDate || '9'))).slice(0, 3); const hkRoster = goals ? goals.hkPoints.filter((row) => row.onRoster) : []; const flagged = todayReports.filter((item) => item.flagged).length; const countRooms = (list) => list.filter((item) => !NOT_ROOMS.includes(item.type) && !NOT_INSPECTIONS.includes(item.type)).reduce((sum, item) => sum + (item.itemCount || 0), 0); const rooms = countRooms(todayReports); /* Trolleys and pantries checked, kept apart from rooms. */ const countChecks = (list) => list.filter((item) => item.type === 'trolley_pantry').reduce((sum, item) => sum + (item.itemCount || 0), 0); const checks = countChecks(todayReports);
  // Last 7 days, oldest first; index 6 is today and 5 is yesterday.
  const week = Array.from({ length: 7 }, (_, index) => counted.filter((item) => item.date === daysAgo(6 - index)));
  const trend = { reports: week.map((list) => list.length), rooms: week.map(countRooms), checks: week.map(countChecks), flagged: week.map((list) => list.filter((item) => item.flagged).length), active: week.map((list) => new Set(list.map((item) => item.submittedBy)).size) };
  const fieldStaff = staff.filter((person) => FIELD_ROLES.includes(person.role) && person.active !== false).length; const recentPanel = <section className="panel"><div className="panel-title"><div><p className="kicker">RECENT ACTIVITY</p><h3>Latest reports</h3></div><button className="text" onClick={() => setPage('reports')}>View all →</button></div>{reports.filter((item) => item.type !== 'handover').slice(0, 5).map((item) => <ReportLine key={item.id} item={item} onOpen={openReport} openHk={openHk} openSup={openSup} />)}{!reports.some((item) => item.type !== 'handover') && <Empty text="No reports yet. Start today's first inspection." />}{reports.some((item) => item.type === 'handover') && <div className="handover-recent"><p className="kicker">SHIFT HANDOVERS</p>{reports.filter((item) => item.type === 'handover').slice(0, 3).map((item) => <ReportLine key={item.id} item={item} onOpen={openReport} openHk={openHk} openSup={openSup} />)}</div>}</section>; const quickPanel = <section className="panel quick"><p className="kicker">QUICK CAPTURE</p><h3>What are you logging?</h3>{allowedTypes.map((key) => <button onClick={() => chooseType(key)} key={key}><span><Icon name="plus" /></span>{TYPES[key]}<b>→</b></button>)}</section>; const goalsPanel = goals && <section className="panel"><div className="panel-title"><div><p className="kicker">GOALS AT A GLANCE</p><h3>On track for this year</h3></div><button className="text" onClick={() => setPage('goals')}>View tracker →</button></div><div className="glance-stats"><div className="link" {...clickable(() => setPage('goals'))}><strong>{goals.supervisorPoints.filter((row) => row.points >= goals.targets.supervisor).length} / {goals.supervisorPoints.length}</strong><small>supervisors at {goals.targets.supervisor} pts</small><Progress value={teamAverage(goals.supervisorPoints)} target={goals.targets.supervisor} /><small>avg {Math.round(teamAverage(goals.supervisorPoints))} pts each</small></div><div className="link" {...clickable(() => setPage('goals'))}><strong>{hkRoster.filter((row) => row.done).length} / {hkRoster.length}</strong><small>HK staff with all 4 targets met</small><Progress value={hkRoster.length ? hkRoster.reduce((sum, row) => sum + row.progress, 0) / hkRoster.length : 0} target={100} /><small>avg {hkRoster.length ? Math.round(hkRoster.reduce((sum, row) => sum + row.progress, 0) / hkRoster.length) : 0}% of the way</small></div></div>{goals.smartGoals.map((goal) => <div className="glance-goal link" key={goal.key} {...clickable(() => setPage('goals'))}><span>{goal.label}</span>{goal.target ? <Progress value={goal.rate} target={goal.target} /> : <small className="muted">{goal.samples ? `Rate ${goal.rate}% · no target` : 'No scores yet'}</small>}</div>)}</section>; const tasksPanel = <section className="panel"><div className="panel-title"><div><p className="kicker">TASKS AT A GLANCE</p><h3>Open follow-ups</h3></div><button className="text" onClick={() => setPage('tasks')}>View all →</button></div><div className="glance-stats"><div className="link" {...clickable(() => setPage('tasks'))}><strong>{openTasks.length}</strong><small>open tasks</small></div><div className="link" {...clickable(() => setPage('tasks'))}><strong className={openTasks.some((task) => task.priority === 'urgent') ? 'red-text' : ''}>{openTasks.filter((task) => task.priority === 'urgent').length}</strong><small>urgent</small></div></div>{topTasks.map((task) => <div className="task-link" key={task.id} {...clickable(() => openTask(task.id))} title="Open this task"><TaskCard task={task} staff={staff} /></div>)}{!openTasks.length && <Empty text="No open tasks." />}</section>; return <div className={`overview ${isManager ? 'dashboard' : ''}`}><div className="heading"><div><h2>Operations pulse</h2></div>{allowedTypes.length > 0 && <button className="primary" onClick={() => chooseType(allowedTypes[0])}><Icon name="plus" />New report</button>}</div><QuickSearch reports={reports} tasks={tasks} staff={staff} goals={goals} isManager={isManager} allowedTypes={allowedTypes} setPage={setPage} openReport={openReport} openTask={openTask} openProfile={openProfile} openSupervisor={openSupervisor} chooseType={chooseType} /><div className="stat-cards"><StatCard label="Reports submitted" onOpen={() => openReports({ date: today, focus: { label: isManager ? 'Reports submitted' : 'My reports', personId: mine } })} value={todayReports.length} delta={trend.reports[6] - trend.reports[5]}><MiniBars values={trend.reports} tone="green" /></StatCard><StatCard label="Rooms inspected" onOpen={() => openReports({ date: today, focus: { label: 'Inspections with rooms', rooms: true, personId: mine } })} value={rooms} delta={trend.rooms[6] - trend.rooms[5]}><MiniArea values={trend.rooms} /></StatCard><StatCard label="Trolleys & pantries" onOpen={() => openReports({ date: today, focus: { label: 'Trolley / Pantry checks', checks: true, personId: mine } })} value={checks} delta={trend.checks[6] - trend.checks[5]}><MiniBars values={trend.checks} tone="green" /></StatCard><StatCard label="Needs attention" onOpen={() => openReports({ date: today, focus: { label: 'Needs attention', flagged: true, personId: mine } })} value={flagged} delta={trend.flagged[6] - trend.flagged[5]} better="down"><MiniBars values={trend.flagged} tone="red" /></StatCard>{isManager ? <StatCard label="Active staff" onOpen={() => setStaffOpen(true)} value={trend.active[6]} delta={trend.active[6] - trend.active[5]} note={`${trend.active[6]} of ${fieldStaff} staff today`}><MiniGauge value={trend.active[6]} max={fieldStaff} /></StatCard> : <StatCard label="My open tasks" onOpen={() => setPage('tasks')} value={openTasks.length} note={`${tasks.length - openTasks.length} of ${tasks.length} completed`}><MiniGauge value={tasks.length - openTasks.length} max={tasks.length} /></StatCard>}</div>{isManager ? <><div className="dash-top"><ScoreTrend reports={reports} openType={(type) => openReports({ type })} openDay={(date) => openReports({ date, focus: { label: 'Reports that day' } })} />{quickPanel}</div><RemarksPanel reports={reports} openReport={openReport} newTask={newTask} openHk={openHk} openSup={openSup} /><div className={`dash-bottom ${goalsPanel ? '' : 'two'}`}>{goalsPanel}{tasksPanel}{recentPanel}</div>{goals && <SupervisorPointsPanel goals={goals} setPage={setPage} openSupervisor={openSupervisor} />}{performance && <PerformancePanel performance={performance} openProfile={openProfile} setPage={setPage} request={request} />}{performance?.supervisors && <SupervisorPerformancePanel performance={performance} openSupervisor={openSupervisor} setPage={setPage} request={request} />}</> : <div className="columns">{recentPanel}{quickPanel}</div>}{staffOpen && <ActiveStaffDialog staff={staff} todayReports={todayReports} close={() => setStaffOpen(false)} openSup={openSup} openReports={openReports} />}</div>; }
// Manager Overview: the daily average score (out of 10) of each scored report type, as bars, for any week or month.
// Shift Handover, Vehicle Checklist and Tools Control carry no scores, so they never appear. Colours follow the report type;
// every type stays in the key (with "no reports" when it had none), so a colour never just disappears.
export const TREND_TYPES = [['quality', 'Quality Checklist'], ['neglected', 'Neglected Area'], ['trolley_pantry', 'Trolley / Pantry'], ['guest_interaction', 'Guest Interaction'], ['inspection_rate', 'Inspection Rate Program']];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// A week runs Monday to Sunday; a month from the 1st to its last day.
const trendPeriod = (span, anchor) => {
  if (span === 'week') { const start = shiftDays(anchor, -((new Date(`${anchor}T00:00:00`).getDay() + 6) % 7)); return { start, end: shiftDays(start, 6) }; }
  const start = `${anchor.slice(0, 7)}-01`; const last = new Date(`${start}T00:00:00`); last.setMonth(last.getMonth() + 1, 0); return { start, end: isoDate(last) };
};
export function ScoreTrend({ reports, openType, openDay }) {
  const today = localToday();
  const [span, setSpan] = useState('week');
  const [anchor, setAnchor] = useState(today);
  const [picked, setPicked] = useState(null);
  const [hover, setHover] = useState(null);
  const { start, end } = trendPeriod(span, anchor);
  const go = (date) => { setPicked(null); setAnchor(date > today ? today : date); };
  const step = (by) => go(span === 'week' ? shiftDays(start, 7 * by) : by < 0 ? shiftDays(start, -1) : shiftDays(end, 1));
  const current = today >= start && today <= end;
  const label = span === 'week' ? `${new Date(`${start}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${deadlineLabel(end)}` : `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
  const days = []; for (let day = start; day <= end; day = shiftDays(day, 1)) days.push(day);
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const scored = reports.filter((report) => report.average > 0 && report.date >= start && report.date <= end);
  const series = TREND_TYPES.map(([type, name], slot) => {
    const list = scored.filter((report) => report.type === type);
    return { type, name, slot: slot + 1, count: list.length, average: mean(list.map((report) => report.average)), values: days.map((day) => { const ofDay = list.filter((report) => report.date === day); return ofDay.length ? { average: mean(ofDay.map((report) => report.average)), count: ofDay.length } : null; }) };
  });
  const shown = series.filter((line) => line.count);
  const overall = mean(scored.map((report) => report.average));
  const W = 640; const H = 230; const left = 30; const right = 8; const top = 12; const bottom = 28;
  const groupWidth = (W - left - right) / days.length;
  const barWidth = Math.max(1.5, Math.min(16, (groupWidth * 0.82) / Math.max(1, shown.length)));
  const y = (value) => top + (1 - value / 10) * (H - top - bottom);
  const dayName = (day) => new Date(`${day}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  const tick = (day, index) => (span === 'week' ? dayName(day) : Number(day.slice(8)) === 1 || Number(day.slice(8)) % 5 === 0 ? String(Number(day.slice(8))) : '');
  const focus = picked ?? hover;
  return <section className="panel trend score-trend"><div className="panel-title"><div><p className="kicker">MANAGER PERFORMANCE VIEW</p><h3>Daily score by report type</h3><small className="muted">Average score out of 10 a day · one bar per report type · every scored report, from supervisors and managers</small></div><strong className="trend-value">{overall === null ? '—' : overall.toFixed(1)}<small>/10 {current ? `this ${span}` : `in ${span === 'week' ? 'that week' : label}`}</small></strong></div>
    <div className="trend-controls"><div className="segmented" role="tablist" aria-label="Period">{[['week', 'Week'], ['month', 'Month']].map(([key, name]) => <button type="button" role="tab" key={key} aria-selected={span === key} className={span === key ? 'active' : ''} onClick={() => { setSpan(key); setPicked(null); }}>{name}</button>)}</div><div className="trend-nav"><button type="button" onClick={() => step(-1)} aria-label={`Previous ${span}`}>‹</button><b>{label}</b><button type="button" onClick={() => step(1)} disabled={end >= today} aria-label={`Next ${span}`}>›</button></div><label className="trend-jump">Go to{span === 'month' ? <input type="month" value={start.slice(0, 7)} max={today.slice(0, 7)} onChange={(e) => e.target.value && go(`${e.target.value}-01`)} /> : <input type="date" value={anchor} max={today} onChange={(e) => e.target.value && go(e.target.value)} />}</label>{!current && <button type="button" className="text" onClick={() => go(today)}>Back to this {span}</button>}</div>
    <ul className="trend-legend">{series.map((line) => <li key={line.type} className={line.count ? '' : 'none'}>{openType ? <button type="button" onClick={() => openType(line.type)} title={`Open ${line.name} reports`}><i className={`series-${line.slot}`} aria-hidden="true" /><span>{line.name}</span><b>{line.count ? line.average.toFixed(1) : 'no reports'}</b></button> : <><i className={`series-${line.slot}`} aria-hidden="true" /><span>{line.name}</span><b>{line.count ? line.average.toFixed(1) : 'no reports'}</b></>}</li>)}</ul>
    {shown.length ? <>
      <div className="trend-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily score by report type, ${label}: ${shown.map((line) => `${line.name} average ${line.average.toFixed(1)}`).join('; ')}`}>
          {[0, 2, 4, 6, 8, 10].map((value) => <g key={value}><line className="trend-grid" x1={left} x2={W - right} y1={y(value)} y2={y(value)} /><text className="trend-axis" x={left - 7} y={y(value) + 4} textAnchor="end">{value}</text></g>)}
          {focus !== null && <rect className="trend-focus" x={left + focus * groupWidth} y={top} width={groupWidth} height={H - top - bottom} />}
          {days.map((day, index) => { const present = shown.filter((line) => line.values[index]); const x0 = left + index * groupWidth + (groupWidth - barWidth * present.length) / 2; return <g key={day}>{present.map((line, k) => <rect key={line.type} className={`trend-bar series-${line.slot}`} x={x0 + k * barWidth} y={y(line.values[index].average)} width={Math.max(1, barWidth - 1)} height={y(0) - y(line.values[index].average)} rx="1.5" />)}<text className={`trend-axis ${focus === index ? 'on' : ''}`} x={left + index * groupWidth + groupWidth / 2} y={H - 8} textAnchor="middle">{tick(day, index)}</text></g>; })}
          {days.map((day, index) => <rect key={day} className="trend-hit" x={left + index * groupWidth} y={top} width={groupWidth} height={H - top - bottom} onMouseEnter={() => setHover(index)} onClick={() => setPicked(picked === index ? null : index)} />)}
        </svg>
      </div>
      {focus !== null ? <div className="trend-day"><b>{deadlineLabel(days[focus])}</b>{shown.map((line) => <span key={line.type}><i className={`series-${line.slot}`} aria-hidden="true" />{line.name}<b>{line.values[focus] ? `${line.values[focus].average.toFixed(1)} · ${plural(line.values[focus].count, 'report')}` : '—'}</b></span>)}{openDay && scored.some((report) => report.date === days[focus]) && <button type="button" className="text" onClick={() => openDay(days[focus])}>Open that day's reports →</button>}</div> : <p className="muted trend-hint">Tap a day to see its scores and open its reports.</p>}
    </> : <Empty text={`No scored reports in ${current ? `this ${span}` : label} yet.`} />}
  </section>;
}
const housekeeperNames = (item) => (HK_REPORT_TYPES.includes(item.type) ? [...new Set([...(item.data?.entries || []), ...(item.data?.trolleys || []), ...(item.data?.pantries || [])].map((line) => String(line?.hkName || '').trim()).filter(Boolean))] : []);
const nowhere = () => null;
export function ReportLine({ item, onOpen, openHk = nowhere, openSup = nowhere }) { const names = housekeeperNames(item); return <div className="report-line link" {...clickable(() => onOpen?.(item.id))}><div className={`status-icon ${item.flagged ? 'bad' : ''}`}>{item.flagged ? '!' : '✓'}</div><div><strong>{TYPES[item.type]}</strong><small>{item.type === 'handover' ? <><NameLink name={item.data?.handoverFrom || item.submitter?.name} open={openSup(item.submittedBy, item.submitter?.name)} /> → <NameLink name={item.data?.receivedBy || '—'} open={openSup(item.data?.receivedById, item.data?.receivedBy)} /></> : <NameLink name={item.submitter?.name} open={openSup(item.submittedBy, item.submitter?.name)} />} · {deadlineLabel(item.date)}</small>{names.length > 0 && <small className="report-line-hk">HK: {names.slice(0, 3).map((name, index) => <Fragment key={name}>{index ? ', ' : ''}<NameLink name={name} open={openHk(name)} /></Fragment>)}{names.length > 3 ? ` +${names.length - 3}` : ''}</small>}{item.type === 'inspection_rate' && item.data?.supervisorName && <small className="report-line-hk">Supervisor: <NameLink name={item.data.supervisorName} open={openSup(item.data.supervisorId, item.data.supervisorName)} /></small>}</div><span className={`badge ${item.flagged ? 'danger' : 'good'}`}>{item.flagged ? 'Needs attention' : 'Clear'}</span></div>; }
// A driver's Overview: only their own vehicle checklists. Today's checklist first, then the week / month dashboard.
export function DriverHome({ reports, me, openReport, newChecklist, exportChecks }) {
  const todays = reports.filter((item) => item.date === localToday() && item.submittedBy === me.id);
  const problems = [...new Set(todays.flatMap(vehicleProblems))];
  const status = !todays.length ? 'todo' : problems.length ? 'bad' : 'done';
  return <div className="overview driver-home"><div className="heading"><div><p className="kicker">HELLO, {String(me.name || '').split(' ')[0].toUpperCase()}</p><h2>My vehicle checks</h2></div><button className="primary" onClick={newChecklist}><Icon name="plus" />New checklist</button></div><section className={`panel today-check ${status}`}><span className="today-icon" aria-hidden="true">{status === 'todo' ? '!' : status === 'bad' ? '✕' : '✓'}</span><div><p className="kicker">TODAY · {deadlineLabel(localToday())}</p>{status === 'todo' ? <><h3>Today's checklist is not done yet</h3><small>Check your vehicle before you start driving.</small></> : <><h3>{status === 'bad' ? `Today's checklist found ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}` : "Today's checklist is done · All OK"}</h3><small>{todays.map((item) => vehicleName(item)).join(', ')}{problems.length ? ` · Not OK: ${problems.join(', ')}` : ''}</small></>}</div>{status === 'todo' ? <button className="primary" onClick={newChecklist}>Start checklist →</button> : <button className="secondary" onClick={() => openReport(todays[0].id)}>View →</button>}</section><VehicleChecks reports={reports} isManager={false} openReport={openReport} exportChecks={exportChecks} /></div>;
}
