import { useEffect, useState } from 'react';
import { Empty } from '../../components/ui';
import { Icon } from '../../components/icons';
import { confirmAction } from '../../components/ConfirmDialog';
import { deadlineLabel, plural } from '../../lib/format';

// Planned trainings (Training page): one row per training planned there, to change or delete it for everyone at once
// instead of going through each person's profile.
const PLAN_STATUSES = [['in_progress', 'In progress'], ['improved', 'Improved'], ['not_improved', 'Not improved'], ['closed', 'Closed']];
const statusLabel = (status) => (status === 'mixed' ? 'Mixed' : PLAN_STATUSES.find(([key]) => key === status)?.[1] || status);
const people = (count) => `${count} ${count === 1 ? 'person' : 'people'}`;
const formOf = (plan) => ({ date: plan.date, followUp: plan.followUp || '', notes: plan.notes, status: '' });

function PlanRow({ plan, audience, request, reload, setMessage, openPerson }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => formOf(plan));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(formOf(plan)), [plan.id, plan.date, plan.followUp, plan.notes]);
  const save = async (event) => {
    event.preventDefault(); setError(''); setSaving(true);
    try {
      await request(`/training-plans/${encodeURIComponent(plan.id)}`, { method: 'PATCH', body: JSON.stringify({ audience, date: form.date, followUp: form.followUp || null, notes: form.notes, ...(form.status ? { status: form.status } : {}) }) });
      setMessage(`${plan.topic}: saved for ${people(plan.people.length)}.`);
      reload();
    } catch (problem) { setError(problem.message); } finally { setSaving(false); }
  };
  const setStatus = async (person, status) => {
    setError('');
    try { await request(`/support-actions/${person.actionId}`, { method: 'PATCH', body: JSON.stringify({ status }) }); reload(); } catch (problem) { setError(problem.message); }
  };
  const removePerson = async (person) => {
    if (!await confirmAction({ title: `Take ${person.name} off this training?`, body: `${plan.topic} · ${deadlineLabel(plan.date)}. It comes off their support plan.`, confirmLabel: 'Take off', danger: true })) return;
    try { await request(`/support-actions/${person.actionId}`, { method: 'DELETE' }); setMessage(`${person.name} taken off ${plan.topic}.`); reload(); } catch (problem) { setError(problem.message); }
  };
  const removePlan = async () => {
    if (!await confirmAction({ title: `Delete the training "${plan.topic}" of ${deadlineLabel(plan.date)}?`, body: `It comes off the support plan of all ${people(plan.people.length)}. This can't be undone.`, confirmLabel: 'Delete training', danger: true })) return;
    try { const result = await request(`/training-plans/${encodeURIComponent(plan.id)}?audience=${audience}`, { method: 'DELETE' }); setMessage(`Training deleted from ${plural(result.deleted, 'support plan')}.`); reload(); } catch (problem) { setError(problem.message); }
  };
  return <li className={`plan-row ${open ? 'open' : ''}`}>
    <button type="button" className="plan-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span><b>{plan.topic}</b><small className="muted">{deadlineLabel(plan.date)} · {people(plan.people.length)}{plan.followUp ? ` · check again ${deadlineLabel(plan.followUp)}` : ''} · by {plan.by}</small></span>
      <span className={`plan-status ${plan.status}`}>{statusLabel(plan.status)}</span>
    </button>
    {open && <div className="plan-row-body">
      <form className="training-plan-fields" onSubmit={save}>
        <label>Training date<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></label>
        <label>Check again on<input type="date" min={form.date} value={form.followUp} onChange={(e) => setForm({ ...form, followUp: e.target.value })} /></label>
        <label>How it turned out (everyone)<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="">Keep as it is</option>{PLAN_STATUSES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="wide">Notes<input value={form.notes} placeholder="e.g. morning briefing, trainer: Deograsia" onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <div className="plan-row-actions"><button type="button" className="text danger-text" onClick={removePlan}><Icon name="trash" size={15} />Delete training</button><span /><button className="primary" disabled={saving}><Icon name="check" />{saving ? 'Saving…' : 'Save for everyone'}</button></div>
      </form>
      {error && <p className="error-text" role="alert">{error}</p>}
      <ul className="plan-people">{plan.people.map((person) => <li key={person.actionId}>
        <button type="button" className="text" onClick={() => openPerson(person)}>{person.name}</button>
        <select aria-label={`How it turned out for ${person.name}`} value={person.status} onChange={(e) => setStatus(person, e.target.value)}>{PLAN_STATUSES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <button type="button" className="text" aria-label={`Take ${person.name} off this training`} title="Take off this training" onClick={() => removePerson(person)}><Icon name="x" size={16} /></button>
      </li>)}</ul>
    </div>}
  </li>;
}

export function PlannedTrainings({ audience, request, version, setMessage, openPerson, onChange }) {
  const [plans, setPlans] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const load = () => request(`/training-plans?audience=${audience}`).then((result) => setPlans(result.plans)).catch(() => setPlans([]));
  useEffect(() => { setPlans(null); load(); }, [audience, version]);
  const reload = () => { load(); onChange(); };
  const shown = showAll ? plans || [] : (plans || []).slice(0, 8);
  return <section className="panel goals-section planned-trainings">
    <div className="panel-title"><div><p className="kicker">PLANNED TRAININGS</p><h3>{plans?.length ? `${plural(plans.length, 'training')} planned` : 'No training planned yet'}</h3><small className="muted">Each training is one row. Open it to change the date, notes or how it turned out for everyone at once, take someone off, or delete it from all their support plans.</small></div></div>
    {plans === null ? <Empty text="Loading…" /> : plans.length ? <ul className="plan-list">{shown.map((plan) => <PlanRow key={plan.id} plan={plan} audience={audience} request={request} reload={reload} setMessage={setMessage} openPerson={openPerson} />)}</ul> : <Empty text="Plan a training from a suggestion above, and it shows here." />}
    {plans?.length > 8 && <button type="button" className="text" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${plans.length}`}</button>}
  </section>;
}
