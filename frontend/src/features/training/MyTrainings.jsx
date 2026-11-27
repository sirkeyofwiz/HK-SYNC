import { useEffect, useState } from 'react';
import { Icon } from '../../components/icons';
import { deadlineLabel, localToday } from '../../lib/format';

// Marking a training done: who attended (all ticked to start) and a short note. Used by the trainer on "My trainings"
// and by managers on the Training page.
export function DoneForm({ planId, people, request, onDone, cancel }) {
  const [attended, setAttended] = useState(() => new Set(people.map((person) => person.actionId)));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const toggle = (id) => setAttended((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const save = async (event) => {
    event.preventDefault(); setError(''); setSaving(true);
    try { const result = await request(`/training-plans/${encodeURIComponent(planId)}/done`, { method: 'POST', body: JSON.stringify({ attended: [...attended], note }) }); onDone(result.plan); } catch (problem) { setError(problem.message); } finally { setSaving(false); }
  };
  return <form className="done-form" onSubmit={save}>
    <p className="kicker">WHO ATTENDED?</p>
    <div className="training-plan-people">{people.map((person) => <label key={person.actionId} className="check"><input type="checkbox" checked={attended.has(person.actionId)} onChange={() => toggle(person.actionId)} />{person.name}</label>)}</div>
    <label>Note (optional)<input value={note} placeholder="e.g. Zawadi off sick, practised on room 214" onChange={(e) => setNote(e.target.value)} /></label>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="training-plan-actions"><button type="button" className="text" onClick={cancel}>Cancel</button><button className="primary" disabled={saving}><Icon name="check" />{saving ? 'Saving…' : `Done · ${attended.size} of ${people.length} attended`}</button></div>
  </form>;
}

function TrainingItem({ training, request, reload }) {
  const [marking, setMarking] = useState(false);
  const due = training.date <= localToday();
  return <li className={`my-training ${training.done ? 'done' : ''}`}>
    <div className="my-training-head">
      <span><b>{training.topic}</b><small className="muted">{deadlineLabel(training.date)}{training.date === localToday() ? ' · today' : ''} · {training.role === 'trainer' ? `you run it for ${training.people.map((person) => person.name).join(', ')}` : `you attend${training.trainerName ? ` · run by ${training.trainerName}` : ''}`}</small></span>
      {training.done ? <span className="plan-status improved">Done</span> : <span className="plan-status in_progress">{training.role === 'trainer' ? 'You run it' : 'You attend'}</span>}
    </div>
    {training.notes && <p className="my-training-note">“{training.notes}”</p>}
    {training.done && <small className="muted">Done {deadlineLabel(training.done.at.slice(0, 10))} by {training.done.byName} · {training.done.attended} of {training.people.length} attended{training.done.note ? ` · ${training.done.note}` : ''}</small>}
    {training.role === 'trainer' && !training.done && due && !marking && <button type="button" className="primary" onClick={() => setMarking(true)}><Icon name="check" />Mark done</button>}
    {marking && <DoneForm planId={training.id} people={training.people} request={request} cancel={() => setMarking(false)} onDone={() => { setMarking(false); reload(); }} />}
  </li>;
}

// Overview card: the trainings this person runs or attends (supervisors don't see the Training page). Hidden when none.
export function MyTrainings({ request }) {
  const [trainings, setTrainings] = useState(null);
  const load = () => request('/my-trainings').then((result) => setTrainings(result.trainings || [])).catch(() => setTrainings([]));
  useEffect(() => { load(); }, []);
  if (!trainings?.length) return null;
  const open = trainings.filter((training) => !training.done);
  return <section className="panel my-trainings">
    <div className="panel-title"><div><p className="kicker">MY TRAININGS</p><h3>{open.length ? `${open.length} coming up or to mark done` : 'All done'}</h3></div></div>
    <ul className="my-training-list">{trainings.map((training) => <TrainingItem key={training.id} training={training} request={request} reload={load} />)}</ul>
  </section>;
}
