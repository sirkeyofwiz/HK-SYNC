import { useEffect, useState } from 'react';
import { Empty } from '../../components/ui';
import { Icon } from '../../components/icons';
import { PlannedTrainings } from './PlannedTrainings';
import { TYPES } from '../../lib/constants';
import { deadlineLabel, localToday, plural } from '../../lib/format';

// Training suggestions (managers and assistant managers): the problems that keep coming up in inspection remarks, counted
// across the whole team over the last 30 days (or another period), turned into a training plan.
const AUDIENCES = [['hk', 'Housekeepers'], ['sup', 'Supervisors']];
const PERIODS = [[30, 'Last 30 days'], [60, 'Last 60 days'], [90, 'Last 90 days']];
const GROUPS = { team: ['Team training', 'Many people share it: train the whole team'], group: ['Small group', 'Two people repeat it: train them together'], one: ['One-to-one', 'One person repeats it: coach them on their own'] };
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00`) + days * 86400000).toLocaleDateString('en-CA');

function PlanForm({ topic, audience, request, done, cancel }) {
  const [chosen, setChosen] = useState(() => new Set(topic.people.map((person) => person.ref)));
  const [form, setForm] = useState({ date: localToday(), followUp: addDays(localToday(), 30), notes: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const toggle = (ref) => setChosen((current) => { const next = new Set(current); if (next.has(ref)) next.delete(ref); else next.add(ref); return next; });
  const save = async (event) => {
    event.preventDefault(); setError('');
    const people = topic.people.filter((person) => chosen.has(person.ref)).map(({ name, ref }) => ({ name, ref }));
    if (!people.length) return setError('Choose who takes part.');
    setSaving(true);
    try { const result = await request('/training-plans', { method: 'POST', body: JSON.stringify({ audience, topicId: topic.id, people, ...form }) }); done(`${topic.label}: added to ${plural(result.created, 'support plan')}.`); } catch (problem) { setError(problem.message); } finally { setSaving(false); }
  };
  return <form className="training-plan" onSubmit={save}>
    <p className="kicker">PLAN THIS TRAINING</p>
    <div className="training-plan-people">{topic.people.map((person) => <label key={person.ref} className="check"><input type="checkbox" checked={chosen.has(person.ref)} onChange={() => toggle(person.ref)} />{person.name}</label>)}</div>
    <div className="training-plan-fields">
      <label>Training date<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required /></label>
      <label>Check again on<input type="date" min={form.date} value={form.followUp} onChange={(e) => setForm({ ...form, followUp: e.target.value })} /></label>
      <label className="wide">Notes (optional)<input placeholder="e.g. morning briefing, trainer: Deograsia" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="training-plan-actions"><button type="button" className="text" onClick={cancel}>Cancel</button><button className="primary" disabled={saving}><Icon name="check" />{saving ? 'Saving…' : `Add to ${plural(chosen.size, 'support plan')}`}</button></div>
  </form>;
}

function TopicCard({ topic, audience, teamSize, request, reload, openPerson, openReport, setMessage }) {
  const [planning, setPlanning] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const change = topic.times - topic.previousTimes;
  const [groupLabel, groupHint] = GROUPS[topic.group] || [];
  return <article className={`training-topic ${topic.suggested ? 'suggested' : ''}`}>
    <div className="training-topic-head">
      <div><strong>{topic.label}</strong>{groupLabel && <span className={`training-group ${topic.group}`} title={groupHint}>{groupLabel}</span>}</div>
      <div className="training-counts"><b>{plural(topic.times, 'remark')}</b><span>{topic.people.length} of {teamSize || '?'} {audience === 'hk' ? 'housekeepers' : 'supervisors'}</span>
        {topic.previousTimes || topic.times ? <small className={change > 0 ? 'red-text' : change < 0 ? 'green-text' : 'muted'}>{change > 0 ? `▲ up from ${topic.previousTimes}` : change < 0 ? `▼ down from ${topic.previousTimes}` : `same as before (${topic.previousTimes})`} in the period before</small> : null}</div>
    </div>
    <div className="training-people">{topic.people.map((person) => <button type="button" key={person.ref} className="chip" onClick={() => openPerson(person)}>{person.name}{person.times > 1 ? <b> ×{person.times}</b> : null}</button>)}</div>
    {topic.planned && <p className="training-planned"><Icon name="check" size={15} />Training planned for {topic.planned.people} {topic.planned.people === 1 ? 'person' : 'people'} · latest {deadlineLabel(topic.planned.last)}</p>}
    <div className="training-topic-actions">
      <button type="button" className="text" aria-expanded={showExamples} onClick={() => setShowExamples(!showExamples)}>{showExamples ? 'Hide what was written' : 'What was written'}</button>
      {!planning && <button type="button" className={topic.suggested ? 'primary' : 'secondary'} onClick={() => setPlanning(true)}><Icon name="plus" />Plan this training</button>}
    </div>
    {showExamples && <ul className="training-examples">{topic.examples.map((example, index) => <li key={index}><button type="button" className="text" onClick={() => openReport(example.reportId, example.line)}>“{example.text}”</button><small className="muted">{example.personName}{example.place ? ` · ${example.place}` : ''} · {TYPES[example.type] || ''} · by {example.by} · {deadlineLabel(example.date)}</small></li>)}</ul>}
    {planning && <PlanForm topic={topic} audience={audience} request={request} cancel={() => setPlanning(false)} done={(note) => { setPlanning(false); setMessage(note); reload(); }} />}
  </article>;
}

function TopicLibrary({ audience, library, defaults, request, close, reload, setMessage }) {
  const [draft, setDraft] = useState(library.map((topic) => ({ ...topic, words: topic.words.join(', ') })));
  const [error, setError] = useState('');
  const set = (index, field, value) => setDraft((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  const save = async (topics) => {
    setError('');
    try { await request('/training-topics', { method: 'PUT', body: JSON.stringify({ audience, topics }) }); setMessage('Training topics saved.'); close(); reload(); } catch (problem) { setError(problem.message); }
  };
  return <section className="panel training-library">
    <div className="panel-title"><div><p className="kicker">TRAINING TOPICS · {audience === 'hk' ? 'HOUSEKEEPERS' : 'SUPERVISORS'}</p><h3>Topics and the words that match them</h3><small className="muted">A remark counts for a topic when it contains one of its words (the start of a word: "dust" also finds "dusty"). Separate words with commas. Add Kiswahili words too.</small></div></div>
    {draft.map((topic, index) => <div className="training-library-row" key={topic.id || `new-${index}`}>
      <label>Topic<input value={topic.label} onChange={(e) => set(index, 'label', e.target.value)} placeholder="e.g. Minibar set-up" /></label>
      <label className="wide">Words<input value={topic.words} onChange={(e) => set(index, 'words', e.target.value)} placeholder="e.g. minibar, fridge, friji" /></label>
      <button type="button" className="text" aria-label={`Remove ${topic.label || 'this topic'}`} onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}><Icon name="trash" size={16} /></button>
    </div>)}
    <button type="button" className="add" onClick={() => setDraft((current) => [...current, { id: '', label: '', words: '' }])}><Icon name="plus" />Add a topic</button>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="training-library-actions">
      <button type="button" className="text" onClick={() => save([])} title={`${defaults.length} standard topics`}>Restore the standard topics</button>
      <span />
      <button type="button" className="text" onClick={close}>Cancel</button>
      <button type="button" className="primary" onClick={() => save(draft.map(({ id, label, words }) => ({ id, label, words })))}>Save topics</button>
    </div>
  </section>;
}

export function Training({ request, openProfile, openSupervisor, openReport, setMessage = () => {} }) {
  const [audience, setAudience] = useState('hk');
  const [days, setDays] = useState(30);
  const [limits, setLimits] = useState({ minTimes: 3, minPeople: 2 });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [plansVersion, setPlansVersion] = useState(0);
  // After planning a training, refresh the suggestions and the planned list.
  const load = () => { setPlansVersion((value) => value + 1); return loadSuggestions(); };
  const loadSuggestions = () => request(`/training-suggestions?audience=${audience}&days=${days}&minTimes=${limits.minTimes}&minPeople=${limits.minPeople}`).then((result) => { setData(result); setError(''); }).catch((problem) => setError(problem.message || 'Could not load the suggestions.'));
  useEffect(() => { setData(null); loadSuggestions(); }, [audience, days, limits.minTimes, limits.minPeople]);
  const openPerson = (person) => (audience === 'hk' ? openProfile(person.name) : openSupervisor(person.ref, person.name));
  const suggested = data?.topics.filter((topic) => topic.suggested) || [];
  const others = data?.topics.filter((topic) => !topic.suggested) || [];
  const who = audience === 'hk' ? 'housekeepers' : 'supervisors';
  return <div className="training-page">
    <div className="heading"><div><p className="kicker">INSIGHTS · MANAGERS ONLY</p><h2>Training suggestions</h2><p className="muted">The problems that keep coming up in the remarks {audience === 'hk' ? 'supervisors write about housekeepers' : 'managers write about supervisors (Inspection Rate Program)'}, counted across the whole team, and the training they call for.</p></div></div>
    <div className="training-controls">
      <div className="segmented" role="tablist" aria-label="Who">{AUDIENCES.map(([key, label]) => <button type="button" role="tab" key={key} aria-selected={audience === key} className={audience === key ? 'active' : ''} onClick={() => { setAudience(key); setEditing(false); }}>{label}</button>)}</div>
      <label>Period<select value={days} onChange={(e) => setDays(Number(e.target.value))}>{PERIODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Suggest when written<input type="number" min="1" max="50" value={limits.minTimes} onChange={(e) => setLimits({ ...limits, minTimes: Number(e.target.value) || 1 })} /><small>times or more</small></label>
      <label>or when<input type="number" min="1" max="50" value={limits.minPeople} onChange={(e) => setLimits({ ...limits, minPeople: Number(e.target.value) || 1 })} /><small>{who} or more have it</small></label>
      {!editing && <button type="button" className="secondary" onClick={() => setEditing(true)}><Icon name="edit" />Edit topics</button>}
    </div>
    {error && <Empty text={error} />}
    {!data && !error && <Empty text="Reading the remarks…" />}
    {data && editing && <TopicLibrary audience={audience} library={data.library} defaults={data.defaults} request={request} close={() => setEditing(false)} reload={load} setMessage={setMessage} />}
    {data && <>
      <p className="training-summary">{plural(data.totalRemarks, 'remark')} about {who} from {deadlineLabel(data.since)} to {deadlineLabel(data.until)} · {data.matchedRemarks} matched a training topic{data.previousRemarks ? ` · ${data.previousRemarks} in the ${data.days} days before` : ''}</p>
      <section className="panel goals-section">
        <div className="panel-title"><div><p className="kicker">SUGGESTED TRAINING PLAN</p><h3>{suggested.length ? `${plural(suggested.length, 'topic')} to train on` : 'Nothing repeats enough yet'}</h3><small className="muted">Most people first. Team training when 3 or more {who} share a problem, a small group for two, one-to-one for one.</small></div></div>
        {suggested.length ? <div className="training-topics">{suggested.map((topic) => <TopicCard key={topic.id} topic={topic} audience={audience} teamSize={data.teamSize} request={request} reload={load} openPerson={openPerson} openReport={openReport} setMessage={setMessage} />)}</div>
          : <Empty text={`No problem was written ${limits.minTimes} times or more, or about ${limits.minPeople} ${who} or more, in this period.`} />}
      </section>
      <PlannedTrainings audience={audience} request={request} version={plansVersion} setMessage={setMessage} openPerson={openPerson} onChange={loadSuggestions} />
      {others.length > 0 && <section className="panel goals-section">
        <div className="panel-title"><div><p className="kicker">ALSO MENTIONED</p><h3>Not repeating enough to suggest yet</h3></div><button type="button" className="text" aria-expanded={showOthers} onClick={() => setShowOthers(!showOthers)}>{showOthers ? 'Hide' : `Show ${others.length}`}</button></div>
        {showOthers && <div className="training-topics">{others.map((topic) => <TopicCard key={topic.id} topic={topic} audience={audience} teamSize={data.teamSize} request={request} reload={load} openPerson={openPerson} openReport={openReport} setMessage={setMessage} />)}</div>}
      </section>}
      {data.unmatched.count > 0 && <section className="panel goals-section">
        <div className="panel-title"><div><p className="kicker">NOT MATCHED</p><h3>{plural(data.unmatched.count, 'remark')} matched no topic</h3><small className="muted">If one of these is a real problem, press Edit topics and add its words to a topic (or a new one).</small></div></div>
        <ul className="training-examples">{data.unmatched.examples.map((example, index) => <li key={index}><button type="button" className="text" onClick={() => openReport(example.reportId, example.line)}>“{example.text}”</button><small className="muted">{example.personName}{example.place ? ` · ${example.place}` : ''} · by {example.by} · {deadlineLabel(example.date)}</small></li>)}</ul>
      </section>}
    </>}
  </div>;
}
