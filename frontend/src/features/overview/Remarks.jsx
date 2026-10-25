import { useState } from 'react';
import { Empty } from '../../components/ui';
import { TYPES } from '../../lib/constants';
import { daysAgo, localToday, plural, reportLineLabel } from '../../lib/format';

// Manager Overview: the remarks supervisors write on room inspections, gathered in one place so nobody has to open
// report after report. Each remark links to its room line in the report and can become a follow-up task.
const REMARK_TYPES = ['quality', 'neglected', 'trolley_pantry', 'inspection_rate'];
const PERIODS = [['today', 'Today', 0], ['week', '7 days', 6], ['month', '30 days', 29]];
// Everyday words that keep coming up, in English and Kiswahili. Add to this list to track a new issue.
const ISSUES = [
  ['hair', /\bhairs?\b|nywele/i], ['dust', /\bdust(y)?\b|vumbi/i], ['dirty', /\bdirt(y)?\b|uchafu|\bchafu\b/i], ['stains', /\bstain(s|ed)?\b|\bmadoa\b|\bdoa\b/i],
  ['smell', /\bsmell(s|y)?\b|\bodou?r|harufu/i], ['towels', /\btowels?\b|taulo/i], ['bed linen', /\blinen|\bsheets?\b|pillow|duvet|shuka/i], ['toilet', /\btoilet|\bwc\b|choo/i],
  ['mirror / glass', /\bmirrors?\b|\bglass\b|\bwindows?\b|kioo/i], ['amenities', /amenit(y|ies)|\bsoap\b|shampoo|toiletr|sabuni/i], ['bin', /\bbins?\b|rubbish|trash|garbage|takataka/i],
  ['floor', /\bfloors?\b|sakafu/i], ['cobwebs', /cobweb|spider|buibui/i], ['missing', /\bmissing\b|haipo|hakuna/i], ['broken', /\bbroken\b|damaged?|not working|imeharibika|mbovu/i]
];

export function inspectionRemarks(reports) {
  return reports.filter((report) => REMARK_TYPES.includes(report.type)).flatMap((report) => {
    const lists = report.type === 'trolley_pantry' ? ['trolleys', 'pantries'] : ['entries'];
    return lists.flatMap((list) => (Array.isArray(report.data?.[list]) ? report.data[list] : []).map((entry, index) => {
      const text = String(entry?.remarks || '').trim();
      if (!text) return null;
      const values = Object.values(entry.scores || {}).filter((value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
      return {
        key: `${report.id}-${list}-${index}`, reportId: report.id, line: { list, index }, text, type: report.type, date: report.date, createdAt: report.createdAt || '',
        label: reportLineLabel(report.type, list, entry, index), place: report.data?.block || report.data?.area || '',
        person: report.type === 'inspection_rate' ? report.data?.supervisorName || '' : entry.hkName || '', personRole: report.type === 'inspection_rate' ? 'SPV' : 'HK',
        by: report.submitter?.name || '', byId: report.submittedBy, score: values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null
      };
    }).filter(Boolean));
  }).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

const whenLabel = (iso) => iso === localToday() ? 'Today' : iso === daysAgo(1) ? 'Yesterday' : new Date(`${iso}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
const scoreTone = (score) => score === null ? '' : score >= 8 ? 'good' : score >= 7 ? 'ok' : 'low';

function RemarkRow({ remark, openReport, newTask, showPerson = true }) {
  return <div className="remark-row">
    <button type="button" className="remark-main" onClick={() => openReport(remark.reportId, remark.line)} title="Open this room in the report">
      <q>{remark.text}</q>
      <small>{remark.label}{remark.place ? ` · ${remark.place}` : ''} · {TYPES[remark.type]}{showPerson && remark.person ? ` · ${remark.personRole} ${remark.person}` : ''} · by {remark.by || 'Unknown'} · {whenLabel(remark.date)}</small>
    </button>
    <span className={`remark-score ${scoreTone(remark.score)}`} title="Average score of this room">{remark.score ?? '—'}</span>
    <button type="button" className="remark-task" onClick={() => newTask({ title: `${remark.label}: ${remark.text}`.slice(0, 100), location: `${remark.label}${remark.place ? ` · ${remark.place}` : ''}`, assignedTo: remark.byId, priority: 'medium', dueDate: localToday() })}>＋ Task</button>
  </div>;
}

const issueCounts = (remarks) => ISSUES.map(([word, pattern]) => [word, remarks.filter((remark) => pattern.test(remark.text)).length]).filter(([, count]) => count).sort((a, b) => b[1] - a[1]).slice(0, 8);
const withIssue = (remarks, issue) => { const pattern = ISSUES.find(([word]) => word === issue)?.[1]; return pattern ? remarks.filter((remark) => pattern.test(remark.text)) : remarks; };
function IssueChips({ issues, issue, pick }) {
  if (!issues.length) return null;
  return <div className="issue-chips"><span className="muted">Common issues:</span>{issues.map(([word, count]) => <button type="button" key={word} className={issue === word ? 'active' : ''} aria-pressed={issue === word} onClick={() => pick(issue === word ? '' : word)}>{word} <b>×{count}</b></button>)}{issue && <button type="button" className="text" onClick={() => pick('')}>Clear</button>}</div>;
}

// Housekeeper profile: every remark about this person in the profile's period (the server sends them newest first).
export function ProfileRemarks({ remarks, period, openReport, newTask }) {
  const [issue, setIssue] = useState(''); const [all, setAll] = useState(false); const LIMIT = 6;
  const list = remarks.map((remark) => ({ ...remark, key: `${remark.reportId}-${remark.line.list}-${remark.line.index}`, label: remark.place || TYPES[remark.type], place: remark.block && remark.block !== remark.place ? remark.block : '' }));
  const shown = withIssue(list, issue);
  return <section className="panel remarks-panel profile-remarks"><div className="panel-title"><div><p className="kicker">WHAT SUPERVISORS FOUND · {period === 'all' ? 'ALL TIME' : 'THIS FINANCIAL YEAR'}</p><h3>Remarks from inspections</h3><small className="muted">{plural(list.length, 'remark')} about this housekeeper. Tap one to open that room.</small></div></div>
    <IssueChips issues={issueCounts(list)} issue={issue} pick={(word) => { setIssue(word); setAll(false); }} />
    {shown.length ? <div className="remark-list">{(all ? shown : shown.slice(0, LIMIT)).map((remark) => <RemarkRow key={remark.key} remark={remark} openReport={openReport} newTask={newTask} showPerson={false} />)}</div> : <Empty text="No remarks written about this housekeeper in this period." />}
    {shown.length > LIMIT && <button type="button" className="text remarks-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${shown.length} remarks →`}</button>}
  </section>;
}

export function RemarksPanel({ reports, openReport, newTask }) {
  const [period, setPeriod] = useState('week'); const [issue, setIssue] = useState(''); const [grouped, setGrouped] = useState(false); const [all, setAll] = useState(false);
  const since = daysAgo(PERIODS.find(([key]) => key === period)[2]);
  const inPeriod = inspectionRemarks(reports).filter((remark) => remark.date >= since);
  const shown = withIssue(inPeriod, issue);
  const LIMIT = 8;
  const groupAverage = (list) => { const scored = list.filter((remark) => remark.score !== null); return scored.length ? Math.round((scored.reduce((sum, remark) => sum + remark.score, 0) / scored.length) * 10) / 10 : null; };
  // Most remarks first; on a tie, the lower room score first (who needs attention most).
  const groups = [...shown.reduce((map, remark) => { const name = remark.person || 'No name given'; map.set(name, [...(map.get(name) || []), remark]); return map; }, new Map()).entries()].sort((a, b) => b[1].length - a[1].length || (groupAverage(a[1]) ?? 10) - (groupAverage(b[1]) ?? 10) || a[0].localeCompare(b[0]));
  const visibleGroups = all ? groups : groups.slice(0, 5);
  const more = grouped ? groups.length - visibleGroups.length : shown.length - Math.min(shown.length, LIMIT);
  return <section className="panel remarks-panel">
    <div className="panel-title"><div><p className="kicker">WHAT SUPERVISORS FOUND · {period === 'today' ? 'TODAY' : `LAST ${PERIODS.find(([key]) => key === period)[2] + 1} DAYS`}</p><h3>Remarks from inspections</h3><small className="muted">{plural(inPeriod.length, 'remark')} on Quality, Neglected Area, Trolley / Pantry and Inspection Rate reports. Tap one to open that room.</small></div>
      <div className="remarks-controls"><div className="segmented" role="tablist" aria-label="Period">{PERIODS.map(([key, label]) => <button type="button" role="tab" key={key} aria-selected={period === key} className={period === key ? 'active' : ''} onClick={() => { setPeriod(key); setIssue(''); setAll(false); }}>{label}</button>)}</div><label className="remarks-group"><input type="checkbox" checked={grouped} onChange={(e) => { setGrouped(e.target.checked); setAll(false); }} /> Group by housekeeper</label></div></div>
    <IssueChips issues={issueCounts(inPeriod)} issue={issue} pick={(word) => { setIssue(word); setAll(false); }} />
    {!shown.length ? <Empty text={inPeriod.length ? `No remarks mention "${issue}".` : period === 'today' ? 'No remarks written today yet.' : 'No remarks written in this period.'} /> : grouped
      ? <div className="remark-groups">{visibleGroups.map(([name, list]) => { const average = groupAverage(list); return <div className="remark-group" key={name}><div className="remark-group-head"><b>{name}</b><small>{plural(list.length, 'remark')}{average !== null ? ` · avg room score ` : ''}{average !== null && <span className={`remark-score inline ${scoreTone(average)}`}>{average}</span>}</small></div>{list.map((remark) => <RemarkRow key={remark.key} remark={remark} openReport={openReport} newTask={newTask} showPerson={false} />)}</div>; })}</div>
      : <div className="remark-list">{(all ? shown : shown.slice(0, LIMIT)).map((remark) => <RemarkRow key={remark.key} remark={remark} openReport={openReport} newTask={newTask} />)}</div>}
    {more > 0 && <button type="button" className="text remarks-more" onClick={() => setAll(true)}>{grouped ? `Show ${plural(more, 'more housekeeper')} →` : `Show all ${shown.length} remarks →`}</button>}
    {all && (grouped ? groups.length > 5 : shown.length > LIMIT) && <button type="button" className="text remarks-more" onClick={() => setAll(false)}>Show fewer</button>}
  </section>;
}
