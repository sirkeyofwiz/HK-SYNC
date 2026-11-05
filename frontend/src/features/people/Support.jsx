import { useEffect, useState } from 'react';
import { confirmAction } from '../../components/ConfirmDialog';
import { Empty } from '../../components/ui';
import { IRP_PASS } from '../../lib/constants';
import { deadlineLabel, localToday, plural } from '../../lib/format';
import { issueCounts } from '../overview/Remarks';
import { Icon } from '../../components/icons';

// Support plan on a profile: what this person needs attention for (worked out from their scores and remarks), and what
// managers did about it, with a follow-up date and how it turned out.
const STATUS_LABELS = { in_progress: 'In progress', improved: 'Improved', not_improved: 'Not improved', closed: 'Closed' };
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
// Issues that come up at least twice in the remarks about them.
const recurring = (texts) => issueCounts(texts.filter(Boolean).map((text) => ({ text }))).filter(([, count]) => count >= 2).map(([word, count]) => `${capital(word)} in remarks ×${count}`);

export const hkProblems = (profile) => [
  ...(profile.rooms && profile.average !== null && profile.average < 7 ? [`Average ${profile.average}/10 (below 7)`] : []),
  ...profile.weaknesses.map((item) => `${item.label} ${item.average}/10 (team ${item.team})`),
  ...(profile.flagged?.length ? [`${plural(profile.flagged.length, 'room')} under 6/10`] : []),
  ...recurring((profile.remarks || []).map((remark) => remark.text))
];
export const supervisorProblems = (profile) => [
  ...(profile.rooms && profile.roomAverage !== null && profile.roomAverage < IRP_PASS ? [`Room average ${profile.roomAverage}/60 (below ${IRP_PASS})`] : []),
  ...profile.weaknesses.map((item) => `${item.label} ${item.average}/10 (team ${item.team})`),
  ...(profile.flagged ? [`${plural(profile.flagged, 'room')} under the pass mark (${IRP_PASS}/60)`] : []),
  ...recurring((profile.recent || []).map((room) => room.remarks))
];

export function SupportPanel({ kind, refId, name, problems, request }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null); // null: closed; with an id: editing that action
  const today = localToday();
  const load = () => request(`/support-actions?kind=${kind}&ref=${encodeURIComponent(refId)}`).then(setData).catch((failure) => setError(failure.message));
  useEffect(() => { setData(null); setForm(null); load(); }, [kind, refId]);
  const blank = (problem = '') => ({ date: today, action: data?.choices.actions[0] || 'Coaching talk', problem, notes: '', followUp: '', status: 'in_progress' });
  const send = async (path, options, after) => { setError(''); try { await request(path, options); after?.(); await load(); } catch (failure) { setError(failure.message); } };
  const submit = (event) => {
    event.preventDefault();
    const body = { date: form.date, action: form.action, problem: form.problem, notes: form.notes, followUp: form.followUp || null, status: form.status };
    send(form.id ? `/support-actions/${form.id}` : '/support-actions', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(form.id ? body : { ...body, kind, ref: refId, name }) }, () => setForm(null));
  };
  const setStatus = (action, status) => send(`/support-actions/${action.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  const remove = async (action) => { if (await confirmAction({ title: 'Delete this action?', body: `${action.action} on ${deadlineLabel(action.date)} will be removed from ${name}'s support plan.`, confirmLabel: 'Delete', danger: true })) send(`/support-actions/${action.id}`, { method: 'DELETE' }); };
  const overdue = (action) => action.status === 'in_progress' && action.followUp && action.followUp < today;
  const actions = data?.actions || [];
  const open = actions.filter((action) => action.status === 'in_progress').length;
  const late = actions.filter(overdue).length;
  return <section className="panel support-panel">
    <div className="panel-title"><div><p className="kicker">SUPPORT PLAN</p><h3>Needs attention & actions taken</h3><small className="muted">{actions.length ? `${plural(actions.length, 'action')} recorded · ${open} in progress${late ? ` · ${plural(late, 'follow-up')} overdue` : ''}` : 'What managers do to help, and how it turns out.'}</small></div>{!form && data && <button type="button" className="primary" onClick={() => setForm(blank(problems[0] || ''))}><Icon name="plus" />Record an action</button>}</div>
    <div className="support-needs"><p className="kicker">WHAT NEEDS ATTENTION</p>{problems.length ? <div className="support-chips">{problems.map((problem) => <button type="button" key={problem} onClick={() => setForm(blank(problem))} title="Record an action for this">{problem}<b><Icon name="plus" /></b></button>)}</div> : <p className="muted">Nothing flagged from their scores in this period.</p>}</div>
    {form && <form className="support-form" onSubmit={submit}>
      <p className="kicker">{form.id ? 'EDIT ACTION' : `NEW ACTION FOR ${name.toUpperCase()}`}</p>
      <label className="wide">What it's for<input list={`support-problems-${kind}`} value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} maxLength={200} required placeholder="e.g. Hair in bathrooms" /><datalist id={`support-problems-${kind}`}>{problems.map((problem) => <option key={problem} value={problem} />)}</datalist></label>
      <label>Action taken<select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>{data.choices.actions.map((action) => <option key={action}>{action}</option>)}</select></label>
      <label>Date<input type="date" value={form.date} max={today} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></label>
      <label>Follow up by (optional)<input type="date" value={form.followUp} min={form.date} onChange={(e) => setForm({ ...form, followUp: e.target.value })} /></label>
      <label>Outcome<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{data.choices.statuses.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label>
      <label className="wide">Notes<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000} placeholder="What was agreed, and what to check next time" /></label>
      <div className="support-form-actions"><button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button><button className="primary">{form.id ? 'Save changes' : 'Save action'}</button></div>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {!data ? <Empty text="Loading…" /> : !actions.length ? (!form && <Empty text="No actions recorded yet." />) : <div className="support-list">{actions.map((action) => <article key={action.id} className={`support-item ${action.status} ${overdue(action) ? 'overdue' : ''}`}>
      <div className="support-item-head"><b>{action.action}</b><span className={`support-status ${action.status}`}>{STATUS_LABELS[action.status]}</span></div>
      <p className="support-for">For: {action.problem}</p>
      {action.notes && <p className="support-notes">{action.notes}</p>}
      <small className="muted">{deadlineLabel(action.date)} · by {action.byName}{action.followUp ? ` · follow up by ${deadlineLabel(action.followUp)}` : ''}{action.updatedByName ? ` · updated by ${action.updatedByName}` : ''}</small>
      {overdue(action) && <small className="support-overdue">Follow-up overdue: check how they are doing and record the outcome.</small>}
      <div className="support-item-actions">{action.status === 'in_progress' && <><button type="button" className="secondary" onClick={() => setStatus(action, 'improved')}>✓ Improved</button><button type="button" className="secondary" onClick={() => setStatus(action, 'not_improved')}><Icon name="x" />Not improved</button></>}{action.status !== 'in_progress' && action.status !== 'closed' && <button type="button" className="secondary" onClick={() => setStatus(action, 'closed')}>Close</button>}<button type="button" className="text" onClick={() => setForm({ ...action, followUp: action.followUp || '', notes: action.notes || '' })}><Icon name="edit" />Edit</button><button type="button" className="text red-text" onClick={() => remove(action)}>Delete</button></div>
    </article>)}</div>}
  </section>;
}
