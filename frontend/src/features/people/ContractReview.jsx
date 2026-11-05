import { useEffect, useState } from 'react';
import { Empty } from '../../components/ui';
import { Icon } from '../../components/icons';
import { deadlineLabel } from '../../lib/format';

// ---------- Contract review (managers) ----------
// One financial year's evidence per housekeeper and supervisor, the band the hotel's rules suggest, and the manager's
// decision with its reason. The server decides who may open it (the manager; assistant managers only when shared).
export const REVIEW_BANDS = { meets: ['good', 'Meets standard'], plan: ['ok', 'Needs an improvement plan'], below: ['support', 'Below standard'], not_enough: ['neutral', 'Not enough evidence'] };
const DECISIONS = [['undecided', 'Undecided'], ['renew', 'Renew'], ['renew_with_plan', 'Renew with improvement plan'], ['do_not_renew', 'Do not renew']];
const DECISION_LABEL = Object.fromEntries(DECISIONS);
const TRENDS = { improving: '↗ Improving', steady: '→ Steady', declining: '↘ Declining' };
const AREAS = [['cleaning', 'Cleaning'], ['hygiene', 'Hygiene'], ['trolleyPantry', 'Trolley / pantry'], ['guestInteraction', 'Guest interaction']];
const percent = (share) => `${Math.round(share * 100)}%`;
const when = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

// The band settings the manager can change: [kind, field, label, unit]. Percent fields are shown as 0–100.
const BAND_FIELDS = [
  ['hk', 'meetsAverage', 'Meets standard: year average at least', '/10'],
  ['hk', 'areaMinimum', '…and no area below', '/10'],
  ['hk', 'belowAverage', 'Below standard: year average under', '/10'],
  ['hk', 'failedBelow', 'An inspection fails under', '/10'],
  ['hk', 'failedShare', 'Below standard: failed inspections at least', '%'],
  ['hk', 'minInspections', 'Enough evidence: inspections at least', ''],
  ['hk', 'minSupervisors', 'Enough evidence: different supervisors at least', ''],
  ['supervisor', 'meetsAverage', 'Meets standard: room average at least', '/60'],
  ['supervisor', 'meetsPassRate', '…and rooms passing at least', '%'],
  ['supervisor', 'belowAverage', 'Below standard: room average under', '/60'],
  ['supervisor', 'belowPassRate', 'Below standard: rooms passing under', '%'],
  ['supervisor', 'minSessions', 'Enough evidence: inspection sessions at least', ''],
  ['supervisor', 'minRooms', 'Enough evidence: rooms at least', '']
];
const toForm = (bands) => Object.fromEntries(BAND_FIELDS.map(([kind, field, , unit]) => [`${kind}.${field}`, unit === '%' ? Math.round(bands[kind][field] * 100) : bands[kind][field]]));

function ReviewSettings({ data, request, onSaved }) {
  const [form, setForm] = useState(() => toForm(data.bands));
  const [state, setState] = useState({ busy: false, note: '' });
  const save = async (body, note) => {
    setState({ busy: true, note: '' });
    try { onSaved(await request('/contract-review/settings', { method: 'PUT', body: JSON.stringify(body) })); setState({ busy: false, note }); } catch (problem) { setState({ busy: false, note: problem.message }); }
  };
  const saveBands = (event) => {
    event.preventDefault();
    const bands = { hk: {}, supervisor: {} };
    for (const [kind, field, , unit] of BAND_FIELDS) bands[kind][field] = unit === '%' ? Number(form[`${kind}.${field}`]) / 100 : Number(form[`${kind}.${field}`]);
    save({ bands }, 'Bands saved. Every review below now follows them.');
  };
  return <section className="panel review-settings">
    <label className="review-share"><input type="checkbox" checked={data.shareWithAssistants} disabled={state.busy} onChange={(e) => save({ shareWithAssistants: e.target.checked }, e.target.checked ? 'Shared: assistant managers can now read the reviews (not change them).' : 'No longer shared with assistant managers.')} /><span><b>Share with assistant managers</b><small>They can read the reviews and decisions. Only you can record decisions or change these settings. Housekeepers and supervisors never see this page.</small></span></label>
    <form onSubmit={saveBands}>
      <div className="review-band-grid">{['hk', 'supervisor'].map((kind) => <fieldset key={kind}><legend>{kind === 'hk' ? 'Housekeepers' : 'Supervisors'}</legend>{BAND_FIELDS.filter(([fieldKind]) => fieldKind === kind).map(([, field, label, unit]) => <label key={field}><span>{label}</span><span className="review-number"><input type="number" step="any" min="0" value={form[`${kind}.${field}`]} onChange={(e) => setForm({ ...form, [`${kind}.${field}`]: e.target.value })} required /><small>{unit}</small></span></label>)}</fieldset>)}</div>
      {state.note && <p className="muted" role="status">{state.note}</p>}
      <div className="review-settings-actions"><button type="button" className="secondary" onClick={() => setForm(toForm(data.defaults))}>Use the starting values</button><button className="primary" disabled={state.busy}>Save bands</button></div>
    </form>
  </section>;
}

function DecisionBox({ row, year, canDecide, request, onSaved }) {
  const [decision, setDecision] = useState(row.decision?.decision || 'undecided');
  const [reason, setReason] = useState(row.decision?.reason || '');
  const [state, setState] = useState({ busy: false, error: '' });
  useEffect(() => { setDecision(row.decision?.decision || 'undecided'); setReason(row.decision?.reason || ''); }, [row.decision?.at]);
  const saved = row.decision;
  if (!canDecide) return <div className="review-decision readonly"><b>Decision: {DECISION_LABEL[saved?.decision || 'undecided']}</b>{saved?.reason && <p>{saved.reason}</p>}{saved && <small>By {saved.byName} · {when(saved.at)}</small>}</div>;
  const changed = decision !== (saved?.decision || 'undecided') || reason.trim() !== (saved?.reason || '');
  const needsReason = ['renew_with_plan', 'do_not_renew'].includes(decision);
  const save = async (event) => {
    event.preventDefault();
    setState({ busy: true, error: '' });
    try { const result = await request('/contract-review/decision', { method: 'PUT', body: JSON.stringify({ year, kind: row.kind, key: row.key, decision, reason }) }); onSaved(result.decision); setState({ busy: false, error: '' }); } catch (problem) { setState({ busy: false, error: problem.message }); }
  };
  return <form className="review-decision" onSubmit={save}>
    <label>Decision<select value={decision} onChange={(e) => setDecision(e.target.value)}>{DECISIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Reason{needsReason ? ' (required)' : ''}<textarea value={reason} maxLength={2000} required={needsReason} placeholder="What the decision is based on, and any improvement plan agreed" onChange={(e) => setReason(e.target.value)} /></label>
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    <div className="review-decision-foot">{saved ? <small>Saved by {saved.byName} · {when(saved.at)}</small> : <small>No decision recorded yet.</small>}<button className="primary" disabled={state.busy || !changed}>{state.busy ? 'Saving…' : 'Save decision'}</button></div>
  </form>;
}

function Fact({ label, value, note }) { return <div className="review-fact"><small>{label}</small><b>{value}</b>{note && <small>{note}</small>}</div>; }

function ReviewCard({ row, year, canDecide, request, open, onDecision }) {
  const [tone, label] = REVIEW_BANDS[row.band];
  const hk = row.kind === 'hk';
  return <article className={`panel review-card band-${row.band}`}>
    <div className="review-card-head"><button type="button" className="link-button" onClick={open}>{row.name}</button><span className={`tag ${tone}`}>{label}</span></div>
    <ul className="review-reasons">{row.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    <div className="review-facts">{hk ? <>
      <Fact label="Year average" value={row.average === null ? '—' : `${row.average}/10`} note={row.trend ? TRENDS[row.trend.direction] : null} />
      <Fact label="Inspections" value={row.inspections} note={`by ${row.inspectors} supervisor${row.inspectors === 1 ? '' : 's'}`} />
      <Fact label="Failed" value={row.failed} note={row.inspections ? percent(row.failedShare) : null} />
      {AREAS.filter(([key]) => row.areas[key].count).map(([key, name]) => <Fact key={key} label={name} value={`${row.areas[key].average}/10`} note={`${row.areas[key].count} scores`} />)}
    </> : <>
      <Fact label="Room average" value={row.average === null ? '—' : `${row.average}/60`} note={row.trend ? TRENDS[row.trend.direction] : null} />
      <Fact label={`Passed ${row.passMark}/60`} value={row.rooms ? percent(row.passRate) : '—'} note={`${row.passed} of ${row.rooms} rooms`} />
      <Fact label="Sessions" value={row.sessions} />
      <Fact label="Points" value={`${row.points}/${row.pointsTarget}`} note="context" />
      <Fact label="Reports filed" value={row.reportsFiled} note={`${row.handovers} handovers · context`} />
    </>}</div>
    {hk && row.remarks.length > 0 && <details className="review-remarks"><summary>Latest inspection remarks ({row.remarks.length})</summary><ul>{row.remarks.map((remark) => <li key={`${remark.reportId}-${remark.text}`}><small>{deadlineLabel(remark.date)} · {remark.score}/10</small> “{remark.text}”</li>)}</ul></details>}
    <DecisionBox row={row} year={year} canDecide={canDecide} request={request} onSaved={onDecision} />
  </article>;
}

export function ContractReview({ request, openProfile, openSupervisor, saveExport }) {
  const [year, setYear] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('hk');
  const [band, setBand] = useState('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const load = () => request(`/contract-review${year ? `?year=${year}` : ''}`).then((result) => { setData(result); setError(''); }).catch((problem) => setError(problem.message));
  useEffect(() => { setData(null); load(); }, [year]);
  if (error) return <section className="panel review-closed"><p className="kicker">CONTRACT REVIEW</p><h2>Not available</h2><p className="muted">{error}</p></section>;
  if (!data) return <Empty text="Loading contract reviews…" />;
  const rows = kind === 'hk' ? data.housekeepers : data.supervisors;
  const shown = band === 'all' ? rows : rows.filter((row) => row.band === band);
  const count = (list, key) => list.filter((row) => row.band === key).length;
  const updateDecision = (row, decision) => setData((current) => ({ ...current, [row.kind === 'hk' ? 'housekeepers' : 'supervisors']: current[row.kind === 'hk' ? 'housekeepers' : 'supervisors'].map((item) => (item.key === row.key ? { ...item, decision } : item)) }));
  const exportExcel = async () => {
    const { utils, write } = await import('xlsx');
    const decisionCells = (row) => [DECISION_LABEL[row.decision?.decision || 'undecided'], row.decision?.reason || '', row.decision ? `${row.decision.byName}, ${when(row.decision.at)}` : ''];
    const hkRows = [['Housekeeper', 'Suggested band', 'Why', 'Year average /10', 'Inspections', 'Supervisors', 'Failed', ...AREAS.map(([, name]) => `${name} /10`), 'Trend', 'Decision', 'Reason', 'Decided by'],
      ...data.housekeepers.map((row) => [row.name, REVIEW_BANDS[row.band][1], row.reasons.join(' '), row.average ?? '', row.inspections, row.inspectors, row.failed, ...AREAS.map(([key]) => row.areas[key].average ?? ''), row.trend ? TRENDS[row.trend.direction] : '', ...decisionCells(row)])];
    const supRows = [['Supervisor', 'Suggested band', 'Why', 'Room average /60', 'Rooms passed', 'Rooms', 'Sessions', 'Points', 'Reports filed', 'Handovers', 'Trend', 'Decision', 'Reason', 'Decided by'],
      ...data.supervisors.map((row) => [row.name, REVIEW_BANDS[row.band][1], row.reasons.join(' '), row.average ?? '', row.passed, row.rooms, row.sessions, row.points, row.reportsFiled, row.handovers, row.trend ? TRENDS[row.trend.direction] : '', ...decisionCells(row)])];
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(hkRows), 'Housekeepers');
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(supRows), 'Supervisors');
    await saveExport(new Blob([write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `contract-review-${data.period.label.replace('/', '-')}.xlsx`);
  };
  return <>
    <div className="heading review-heading"><div><p className="kicker">{data.canDecide ? `MANAGER ONLY${data.shareWithAssistants ? ' · SHARED WITH ASSISTANT MANAGERS' : ''}` : 'SHARED BY THE MANAGER · READ ONLY'}</p><h2>Contract review {data.period.label}</h2><p className="muted">Evidence from inspections between {when(data.period.start)} and {when(data.period.end)}. The band is a suggestion from the hotel's rules; the decision and its reason are the manager's.</p></div>
      <div className="review-tools">{data.years.length > 1 && <select value={data.period.startYear} onChange={(e) => setYear(Number(e.target.value))} aria-label="Financial year">{data.years.map((option) => <option key={option} value={option}>{option}/{String(option + 1).slice(2)}</option>)}</select>}<button type="button" className="secondary" onClick={exportExcel}><Icon name="download" />Excel</button>{data.canDecide && <button type="button" className="secondary" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="sliders" />Bands & sharing</button>}</div></div>
    {settingsOpen && data.canDecide && <ReviewSettings data={data} request={request} onSaved={() => load()} />}
    <div className="review-filters"><div className="segmented" role="group" aria-label="Who">{[['hk', `Housekeepers (${data.housekeepers.length})`], ['supervisor', `Supervisors (${data.supervisors.length})`]].map(([key, label]) => <button type="button" key={key} className={kind === key ? 'active' : ''} aria-pressed={kind === key} onClick={() => { setKind(key); setBand('all'); }}>{label}</button>)}</div>
      <div className="review-band-filter" role="group" aria-label="Band"><button type="button" className={band === 'all' ? 'active' : ''} aria-pressed={band === 'all'} onClick={() => setBand('all')}>All {rows.length}</button>{Object.entries(REVIEW_BANDS).map(([key, [tone, label]]) => <button type="button" key={key} className={`tag ${tone} ${band === key ? 'active' : ''}`} aria-pressed={band === key} onClick={() => setBand(key)}>{label} {count(rows, key)}</button>)}</div></div>
    {shown.length ? <div className="review-list">{shown.map((row) => <ReviewCard key={row.key} row={row} year={data.period.startYear} canDecide={data.canDecide} request={request} open={() => (row.kind === 'hk' ? openProfile(row.name) : openSupervisor(row.key, row.name))} onDecision={(decision) => updateDecision(row, decision)} />)}</div>
      : <Empty text={rows.length ? 'Nobody in this band.' : kind === 'hk' ? 'No housekeepers on the roster yet. Add them on Goals.' : 'No active supervisor accounts.'} />}
  </>;
}
