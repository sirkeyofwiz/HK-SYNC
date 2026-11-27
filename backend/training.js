// Training suggestions (managers and assistant managers only; user's choice, 2026-11-22): the problems that keep coming up
// in inspection remarks, counted across the whole team, turned into a training plan.
//
//   Housekeepers  remarks supervisors write on Quality Checklist, Neglected Area, Trolley / Pantry and Guest Interaction
//   Supervisors   remarks managers write on Inspection Rate Program rooms
//
// Each remark is matched to training topics by the words in it (English and Kiswahili). For each topic: how many times it
// was written in the period (default the last 30 days), how many different people had it and who, examples, and the same
// count for the period before, so a manager can see whether training helped. A topic is suggested once it repeats
// enough (3+ remarks, or 2+ people, both adjustable): team training when 3 or more people share it, a small group for
// two, one-to-one for one. "Plan this training" adds a Training action to each person's support plan.
// Managers edit the topic library (names and words) themselves.
import { randomUUID } from 'node:crypto';

const W = (...words) => words;
export const DEFAULT_TOPICS = {
  hk: [
    { id: 'dusting', label: 'Dusting high & low areas', words: W('dust', 'dusty', 'vumbi', 'cobweb', 'buibui', 'spider', 'high area', 'low area', 'skirting') },
    { id: 'bathroom', label: 'Bathroom deep clean', words: W('bathroom', 'shower', 'toilet', 'wc', 'basin', 'sink', 'tiles', 'grout', 'limescale', 'mould', 'mold', 'choo', 'bafu', 'drain') },
    { id: 'hair', label: 'Hair & detail check', words: W('hair', 'nywele') },
    { id: 'linen', label: 'Bed making & linen', words: W('bed making', 'bed not made', 'bedding', 'bed sheet', 'bedsheet', 'linen', 'sheet', 'pillow', 'duvet', 'bedspread', 'blanket', 'shuka', 'mto', 'tandika') },
    { id: 'floor', label: 'Floor care', words: W('floor', 'carpet', 'mop', 'under the bed', 'sakafu') },
    { id: 'stains', label: 'Stain removal', words: W('stain', 'spot', 'mark', 'madoa', 'doa') },
    { id: 'smell', label: 'Room freshness & odour', words: W('smell', 'odour', 'odor', 'harufu') },
    { id: 'amenities', label: 'Amenities & room set-up', words: W('amenit', 'soap', 'shampoo', 'toiletr', 'tissue', 'tea', 'coffee', 'set up', 'set-up', 'setup', 'missing', 'sabuni', 'haipo', 'hakuna') },
    { id: 'glass', label: 'Mirrors, glass & windows', words: W('mirror', 'glass', 'window', 'kioo') },
    { id: 'bins', label: 'Bins & rubbish', words: W('bin', 'rubbish', 'trash', 'garbage', 'takataka') },
    { id: 'balcony', label: 'Balcony & outdoor area', words: W('balcony', 'terrace', 'outdoor', 'veranda') },
    { id: 'trolley', label: 'Trolley & pantry organisation', words: W('trolley', 'pantry', 'organi') },
    { id: 'guest', label: 'Guest greeting & English', words: W('greet', 'english', 'introduc', 'smile', 'guest') }
  ],
  sup: [
    { id: 'sup_bathroom', label: 'Inspecting bathrooms', words: W('bathroom', 'shower', 'toilet', 'wc', 'basin', 'sink', 'tiles', 'grout', 'mould', 'mold', 'choo', 'bafu') },
    { id: 'sup_detail', label: 'Detail checks: dust & hair', words: W('dust', 'dusty', 'vumbi', 'cobweb', 'hair', 'nywele', 'detail') },
    { id: 'sup_bedroom', label: 'Inspecting bedrooms & linen', words: W('bed', 'linen', 'sheet', 'pillow', 'duvet', 'shuka', 'stain', 'madoa') },
    { id: 'sup_maintenance', label: 'Maintenance reporting', words: W('broken', 'maintenance', 'leak', 'not working', 'bulb', 'light', 'repair', 'imeharibika', 'mbovu', 'damaged') },
    { id: 'sup_balcony', label: 'Balcony & entrance checks', words: W('balcony', 'terrace', 'entrance', 'door', 'corridor', 'outdoor') },
    { id: 'sup_presentation', label: 'Room presentation & set-up', words: W('presentation', 'set up', 'set-up', 'setup', 'amenit', 'missing', 'arrange', 'haipo', 'hakuna') },
    { id: 'sup_smell', label: 'Room freshness & odour', words: W('smell', 'odour', 'odor', 'harufu') },
    { id: 'sup_followup', label: 'Coaching & follow-up of the team', words: W('follow up', 'follow-up', 'not checked', 'missed', 'overlooked', 'repeat', 'again', 'train') }
  ]
};
const AUDIENCES = ['hk', 'sup'];
const MAX_TOPICS = 40;
const MAX_WORDS = 40;
const EXAMPLES = 5;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A word matches at the start of a word ("dust" matches "dusty"), so short words like "wc" or "bin" don't match inside others.
const matcher = (words) => (words.length ? new RegExp(`(^|[^a-z0-9])(${words.map((word) => escape(word.toLowerCase())).join('|')})`, 'i') : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shiftDate = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function registerTraining(app, { database, authMiddleware, requireManager, remarks, people, support, today, users, notify, hour, reminderCheckMs = 5 * 60 * 1000, reminderFromHour = 7 }) {
  database.exec('CREATE TABLE IF NOT EXISTS training_topics (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const stored = new Map(database.prepare('SELECT data FROM training_topics').all().map((row) => JSON.parse(row.data)).map((row) => [row.id, row]));
  const topicsFor = (audience) => stored.get(audience)?.topics || DEFAULT_TOPICS[audience];

  // Counts every topic for one audience over [since, until], with who had it and examples.
  function analyse(audience, since, until) {
    const topics = topicsFor(audience).map((topic) => ({ ...topic, test: matcher(topic.words) }));
    const found = new Map(topics.map((topic) => [topic.id, { times: 0, people: new Map(), examples: [] }]));
    const unmatched = [];
    const list = remarks(audience, since, until);
    for (const remark of list) {
      let any = false;
      for (const topic of topics) {
        if (!topic.test?.test(remark.text)) continue;
        any = true;
        const row = found.get(topic.id);
        row.times += 1;
        const person = row.people.get(remark.personKey) || { name: remark.personName, ref: remark.ref, times: 0 };
        person.times += 1;
        row.people.set(remark.personKey, person);
        if (row.examples.length < EXAMPLES) row.examples.push(remark);
      }
      if (!any) unmatched.push(remark);
    }
    return { topics, found, unmatched, total: list.length };
  }

  app.get('/api/training-suggestions', authMiddleware, requireManager, (req, res) => {
    const audience = AUDIENCES.includes(req.query.audience) ? req.query.audience : 'hk';
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const minTimes = Math.min(50, Math.max(1, Number(req.query.minTimes) || 3));
    const minPeople = Math.min(50, Math.max(1, Number(req.query.minPeople) || 2));
    const until = today();
    const since = shiftDate(until, -(days - 1));
    const now = analyse(audience, since, until);
    const before = analyse(audience, shiftDate(since, -days), shiftDate(since, -1));
    const team = people(audience);
    // Training already planned for a topic (support actions named "Training: <topic>") in the last 90 days.
    const planned = support.actionsOf(audience).filter((row) => row.action === 'Training' && row.date >= shiftDate(until, -89));
    const topics = now.topics.map((topic) => {
      const row = now.found.get(topic.id);
      const who = [...row.people.values()].sort((a, b) => b.times - a.times || a.name.localeCompare(b.name));
      const suggested = row.times >= minTimes || who.length >= minPeople;
      const plannedRows = planned.filter((action) => action.problem === `Training: ${topic.label}`);
      return {
        id: topic.id, label: topic.label, words: topic.words, times: row.times, people: who, previousTimes: before.found.get(topic.id)?.times || 0,
        examples: row.examples.map(({ personKey, ...example }) => example),
        suggested, group: !suggested ? null : who.length >= 3 ? 'team' : who.length === 2 ? 'group' : 'one',
        planned: plannedRows.length ? { people: new Set(plannedRows.map((action) => action.person)).size, last: plannedRows.map((action) => action.date).sort().at(-1) } : null
      };
    }).filter((topic) => topic.times).sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.people.length - a.people.length || b.times - a.times);
    return res.json({
      audience, days, since, until, minTimes, minPeople, teamSize: team.length,
      totalRemarks: now.total, matchedRemarks: now.total - now.unmatched.length, previousRemarks: before.total,
      topics, unmatched: { count: now.unmatched.length, examples: now.unmatched.slice(0, 8).map(({ personKey, ...example }) => example) },
      library: topicsFor(audience).map(({ id, label, words }) => ({ id, label, words })), defaults: DEFAULT_TOPICS[audience].map(({ id }) => id)
    });
  });

  // The topic library: names and the words that match them, per audience. Sending an empty list restores the defaults.
  app.put('/api/training-topics', authMiddleware, requireManager, (req, res) => {
    const audience = req.body?.audience;
    if (!AUDIENCES.includes(audience)) return res.status(400).json({ message: 'Choose housekeepers or supervisors.' });
    const rows = req.body?.topics;
    if (!Array.isArray(rows) || rows.length > MAX_TOPICS) return res.status(400).json({ message: `Up to ${MAX_TOPICS} topics.` });
    if (!rows.length) {
      stored.delete(audience);
      database.prepare('DELETE FROM training_topics WHERE id = ?').run(audience);
      return res.json({ library: DEFAULT_TOPICS[audience] });
    }
    const topics = [];
    for (const row of rows) {
      const label = clean(row?.label, 80);
      if (!label) return res.status(400).json({ message: 'Every training topic needs a name.' });
      if (topics.some((topic) => topic.label.toLowerCase() === label.toLowerCase())) return res.status(400).json({ message: `"${label}" is listed twice.` });
      const words = [...new Set((Array.isArray(row?.words) ? row.words : String(row?.words || '').split(',')).map((word) => clean(word, 40).toLowerCase()).filter(Boolean))].slice(0, MAX_WORDS);
      if (!words.length) return res.status(400).json({ message: `${label}: add at least one word to look for in the remarks.` });
      topics.push({ id: clean(row?.id, 60) || `topic_${randomUUID().slice(0, 8)}`, label, words });
    }
    const record = { id: audience, topics, updatedAt: new Date().toISOString(), updatedBy: req.currentUser.name };
    stored.set(audience, record);
    database.prepare('INSERT OR REPLACE INTO training_topics (id, data) VALUES (?, ?)').run(audience, JSON.stringify(record));
    return res.json({ library: topics });
  });

  // ---------- Planned trainings ----------
  // A training is the Training actions planned together (same planId) on each person's support plan, plus a few details
  // kept per training in training_plans: who runs it (the trainer, usually a supervisor), whether it is done (by the
  // trainer or a manager, with who attended and a note), and which reminders went out. User's choice, 2026-11-27:
  //   1. the trainer is told when picked, the day before and on the morning of the training
  //   2. trainees with a login (supervisors, in supervisor trainings) are told the same
  //   3. supervisors see "My trainings" (the trainings they run or attend), not the Training page
  //   4. the trainer marks it done (attended, note); managers are told
  //   5. on the "check again" date, managers are reminded to see whether the remarks went down
  // Trainings planned before planId existed are grouped by topic, date, who planned them and the minute they were saved.
  database.exec('CREATE TABLE IF NOT EXISTS training_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const metas = new Map(database.prepare('SELECT data FROM training_plans').all().map((row) => JSON.parse(row.data)).map((row) => [row.id, row]));
  const saveMeta = (meta) => { metas.set(meta.id, meta); database.prepare('INSERT OR REPLACE INTO training_plans (id, data) VALUES (?, ?)').run(meta.id, JSON.stringify(meta)); };
  const dropMeta = (id) => { metas.delete(id); database.prepare('DELETE FROM training_plans WHERE id = ?').run(id); };
  const metaOf = (id) => metas.get(id) || { id };
  const TRAINER_ROLES = ['supervisor', 'manager', 'assistant_manager'];
  const MANAGER_ROLES = ['manager', 'assistant_manager'];
  const activeUser = (id) => users().find((user) => user.id === id && user.active !== false);
  const trainerChoices = () => users().filter((user) => user.active !== false && TRAINER_ROLES.includes(user.role)).map((user) => ({ id: user.id, name: user.name, role: user.role })).sort((a, b) => a.name.localeCompare(b.name));
  const readTrainer = (value) => {
    if (value === undefined) return { skip: true };
    if (value === null || value === '') return { trainer: null };
    const user = activeUser(String(value));
    return user && TRAINER_ROLES.includes(user.role) ? { trainer: user } : { error: 'Choose a supervisor or manager to run the training.' };
  };

  const planKey = (action) => action.planId || `old:${action.problem}|${action.date}|${action.createdBy}|${String(action.createdAt).slice(0, 16)}`;
  const plansOf = (audience) => {
    const groups = new Map();
    for (const action of support.actionsOf(audience).filter((row) => row.action === 'Training')) {
      const key = planKey(action);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(action);
    }
    return groups;
  };
  const allPlans = () => AUDIENCES.flatMap((audience) => [...plansOf(audience).entries()].map(([key, rows]) => ({ audience, key, rows })));
  const topicOf = (rows) => String(rows[0].problem).replace(/^Training: /, '');
  const refOf = (row) => row.person.slice(row.person.indexOf(':') + 1);
  const planView = (key, rows) => {
    const first = rows[0];
    const meta = metaOf(key);
    const statuses = [...new Set(rows.map((row) => row.status))];
    const attended = new Set(meta.attended || []);
    return {
      id: key, topic: topicOf(rows), date: first.date, followUp: first.followUp || null, notes: first.notes || '',
      status: statuses.length === 1 ? statuses[0] : 'mixed', by: support.view(first).byName, createdAt: first.createdAt,
      trainerId: meta.trainerId || null, trainerName: meta.trainerId ? activeUser(meta.trainerId)?.name || meta.trainerName || null : null,
      done: meta.doneAt ? { at: meta.doneAt, byName: meta.doneByName, note: meta.doneNote || '', attended: rows.filter((row) => attended.has(row.id)).length } : null,
      people: rows.map((row) => ({ actionId: row.id, name: row.name, ref: refOf(row), status: row.status, attended: meta.doneAt ? attended.has(row.id) : null })).sort((a, b) => a.name.localeCompare(b.name))
    };
  };
  const audienceOf = (value) => (AUDIENCES.includes(value) ? value : null);
  const findPlan = (id) => allPlans().find((plan) => plan.key === id) || null;
  // Who is told about a training: the trainer, and the trainees who have a login (supervisors, in supervisor trainings).
  const traineeIds = (audience, rows) => (audience === 'sup' ? rows.map(refOf).filter((id) => activeUser(id)) : []);
  const linkFor = (userId) => (MANAGER_ROLES.includes(activeUser(userId)?.role) ? { page: 'training' } : { page: 'overview' });
  const tell = (ids, fromUserId, notification) => { for (const id of new Set(ids.filter(Boolean))) notify(id, { type: 'training', fromUserId, link: linkFor(id), ...notification }); };
  const managers = () => users().filter((user) => user.active !== false && MANAGER_ROLES.includes(user.role)).map((user) => user.id);
  const whoText = (audience, rows) => `${rows.length} ${audience === 'hk' ? (rows.length === 1 ? 'housekeeper' : 'housekeepers') : (rows.length === 1 ? 'supervisor' : 'supervisors')}`;
  const day = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Telling the trainer and trainees about a new or changed training.
  function announce(audience, key, rows, actorId, kind) {
    const meta = metaOf(key);
    const topic = topicOf(rows);
    const when = day(rows[0].date);
    if (meta.trainerId) tell([meta.trainerId], actorId, { title: kind === 'moved' ? `Training moved to ${when}` : `You are running a training on ${when}`, body: `${topic} · ${whoText(audience, rows)}: ${rows.map((row) => row.name).join(', ')}`.slice(0, 240) });
    tell(traineeIds(audience, rows).filter((id) => id !== meta.trainerId), actorId, { title: kind === 'moved' ? `Your training moved to ${when}` : `You have a training on ${when}`, body: `${topic}${meta.trainerId ? ` · run by ${activeUser(meta.trainerId)?.name || 'your trainer'}` : ''}` });
  }

  app.get('/api/training-trainers', authMiddleware, requireManager, (req, res) => res.json({ trainers: trainerChoices() }));

  // Plan a training: a Training action on the support plan of each chosen person, and (optionally) a trainer.
  app.post('/api/training-plans', authMiddleware, requireManager, (req, res) => {
    const audience = req.body?.audience;
    if (!AUDIENCES.includes(audience)) return res.status(400).json({ message: 'Choose housekeepers or supervisors.' });
    const topic = topicsFor(audience).find((entry) => entry.id === req.body?.topicId);
    if (!topic) return res.status(404).json({ message: 'That training topic was not found.' });
    const chosen = Array.isArray(req.body?.people) ? req.body.people.slice(0, 100) : [];
    if (!chosen.length) return res.status(400).json({ message: 'Choose who takes part.' });
    const date = String(req.body?.date || '');
    if (!DATE.test(date)) return res.status(400).json({ message: 'Choose the training date.' });
    const trainer = readTrainer(req.body?.trainerId ?? null);
    if (trainer.error) return res.status(400).json({ message: trainer.error });
    const created = [];
    const planId = randomUUID();
    for (const person of chosen) {
      const result = support.addAction(audience, person?.ref, person?.name, { date, action: 'Training', problem: `Training: ${topic.label}`, notes: req.body?.notes || '', followUp: req.body?.followUp || null, status: 'in_progress' }, req.currentUser.id, { planId });
      if (result.error) {
        for (const action of created) support.removeAction(action.id);
        return res.status(400).json({ message: result.error });
      }
      created.push(result.action);
    }
    saveMeta({ id: planId, audience, trainerId: trainer.trainer?.id || null, trainerName: trainer.trainer?.name || null, createdAt: new Date().toISOString() });
    const rows = plansOf(audience).get(planId);
    announce(audience, planId, rows, req.currentUser.id, 'new');
    return res.status(201).json({ created: created.length, plan: planView(planId, rows) });
  });

  app.get('/api/training-plans', authMiddleware, requireManager, (req, res) => {
    const audience = audienceOf(req.query.audience);
    if (!audience) return res.status(400).json({ message: 'Choose housekeepers or supervisors.' });
    const plans = [...plansOf(audience).entries()].map(([key, rows]) => planView(key, rows))
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
    return res.json({ plans, trainers: trainerChoices() });
  });

  // Change a whole training at once: date, follow-up date, notes, trainer and (optionally) how it turned out for everyone.
  app.patch('/api/training-plans/:id', authMiddleware, requireManager, (req, res) => {
    const audience = audienceOf(req.body?.audience);
    const rows = audience ? plansOf(audience).get(req.params.id) : null;
    if (!rows) return res.status(404).json({ message: 'That training was not found.' });
    const trainer = readTrainer(req.body?.trainerId);
    if (trainer.error) return res.status(400).json({ message: trainer.error });
    const oldDate = rows[0].date;
    const meta = { ...metaOf(req.params.id), audience };
    const oldTrainer = meta.trainerId || null;
    const body = {};
    for (const field of ['date', 'followUp', 'notes', 'status']) if (req.body?.[field] !== undefined) body[field] = req.body[field];
    for (const row of rows) {
      const result = support.updateAction(row.id, body, req.currentUser.id);
      if (result.error) return res.status(400).json({ message: result.error });
    }
    if (!trainer.skip) { meta.trainerId = trainer.trainer?.id || null; meta.trainerName = trainer.trainer?.name || null; }
    const fresh = support.actionsOf(audience).filter((row) => planKey(row) === req.params.id);
    const moved = fresh[0].date !== oldDate;
    if (moved) { delete meta.remindedEve; delete meta.remindedDay; }
    if (body.followUp !== undefined && body.followUp !== rows[0].followUp) delete meta.followUpReminded;
    saveMeta(meta);
    // Tell a newly picked trainer about the training, and everyone involved when it moves to another day.
    if (meta.trainerId && meta.trainerId !== oldTrainer && !moved) tell([meta.trainerId], req.currentUser.id, { title: `You are running a training on ${day(fresh[0].date)}`, body: `${topicOf(fresh)} · ${whoText(audience, fresh)}: ${fresh.map((row) => row.name).join(', ')}`.slice(0, 240) });
    if (moved && !meta.doneAt) announce(audience, req.params.id, fresh, req.currentUser.id, 'moved');
    return res.json({ plan: planView(req.params.id, fresh) });
  });

  // Delete a whole training: its Training action comes off every person's support plan; the trainer and trainees are told.
  app.delete('/api/training-plans/:id', authMiddleware, requireManager, (req, res) => {
    const audience = audienceOf(req.query.audience);
    const rows = audience ? plansOf(audience).get(req.params.id) : null;
    if (!rows) return res.status(404).json({ message: 'That training was not found.' });
    const meta = metaOf(req.params.id);
    if (!meta.doneAt && rows[0].date >= today()) tell([meta.trainerId, ...traineeIds(audience, rows)], req.currentUser.id, { title: 'Training cancelled', body: `${topicOf(rows)} · was ${day(rows[0].date)}` });
    for (const row of rows) support.removeAction(row.id);
    dropMeta(req.params.id);
    return res.json({ deleted: rows.length });
  });

  // The trainer (or a manager) marks the training done: who attended and a short note. Managers are told.
  app.post('/api/training-plans/:id/done', authMiddleware, (req, res) => {
    const plan = findPlan(req.params.id);
    if (!plan) return res.status(404).json({ message: 'That training was not found.' });
    const me = activeUser(req.user.id);
    const meta = { ...metaOf(plan.key), audience: plan.audience };
    if (!me || (meta.trainerId !== me.id && !MANAGER_ROLES.includes(me.role))) return res.status(403).json({ message: 'Only the trainer or a manager can mark this training done.' });
    if (plan.rows[0].date > today()) return res.status(400).json({ message: 'This training is still to come.' });
    const ids = new Set(plan.rows.map((row) => row.id));
    const attended = Array.isArray(req.body?.attended) ? req.body.attended.filter((id) => ids.has(id)) : [...ids];
    Object.assign(meta, { doneAt: new Date().toISOString(), doneById: me.id, doneByName: me.name, doneNote: String(req.body?.note || '').replace(/\s+/g, ' ').trim().slice(0, 300), attended });
    saveMeta(meta);
    const absent = plan.rows.filter((row) => !attended.includes(row.id)).map((row) => row.name);
    tell(managers(), me.id, { title: `Training done: ${topicOf(plan.rows)}`, body: `${me.name} · ${attended.length} of ${plan.rows.length} attended${absent.length ? ` (absent: ${absent.join(', ')})` : ''}${meta.doneNote ? ` · ${meta.doneNote}` : ''}`.slice(0, 240) });
    return res.json({ plan: planView(plan.key, plan.rows) });
  });

  // "My trainings": the trainings someone runs or attends, from two weeks ago on. Anyone signed in; supervisors see it
  // on their Overview. Never other people's support plans: only the topic, date, who takes part and the notes.
  app.get('/api/my-trainings', authMiddleware, (req, res) => {
    const me = activeUser(req.user.id);
    if (!me) return res.json({ trainings: [] });
    const from = shiftDate(today(), -14);
    const trainings = allPlans().map(({ audience, key, rows }) => {
      const meta = metaOf(key);
      const role = meta.trainerId === me.id ? 'trainer' : audience === 'sup' && rows.some((row) => refOf(row) === me.id) ? 'trainee' : null;
      if (!role || rows[0].date < from) return null;
      const view = planView(key, rows);
      return { id: key, role, audience, topic: view.topic, date: view.date, notes: view.notes, trainerName: view.trainerName, done: view.done, people: view.people.map(({ actionId, name, attended }) => ({ actionId, name, attended })) };
    }).filter(Boolean).sort((a, b) => Number(Boolean(a.done)) - Number(Boolean(b.done)) || a.date.localeCompare(b.date));
    return res.json({ trainings });
  });

  // Reminders, checked every few minutes from 07:00 hotel time: the day before and the morning of a training (trainer and
  // trainees), and the "check again" date (managers). Each goes out once.
  function sendTrainingReminders() {
    if (hour() < reminderFromHour) return;
    const now = today();
    const tomorrow = shiftDate(now, 1);
    for (const { audience, key, rows } of allPlans()) {
      const meta = { ...metaOf(key), audience };
      const date = rows[0].date;
      const people = [meta.trainerId, ...traineeIds(audience, rows)];
      let changed = false;
      if (!meta.doneAt && date === tomorrow && !meta.remindedEve) {
        tell(people, null, { title: `Training tomorrow: ${topicOf(rows)}`, body: `${day(date)} · ${whoText(audience, rows)}${meta.trainerId ? ` · run by ${activeUser(meta.trainerId)?.name || 'the trainer'}` : ''}` });
        meta.remindedEve = new Date().toISOString(); changed = true;
      }
      if (!meta.doneAt && date === now && !meta.remindedDay) {
        tell(people, null, { title: `Training today: ${topicOf(rows)}`, body: `${whoText(audience, rows)}${meta.trainerId ? ` · trainer: press Done after the training` : ''}` });
        meta.remindedDay = new Date().toISOString(); changed = true;
      }
      const followUp = rows[0].followUp;
      if (followUp && followUp <= now && followUp >= shiftDate(now, -3) && !meta.followUpReminded) {
        tell(managers(), null, { title: `Check again: ${topicOf(rows)}`, body: `Training of ${day(date)} · ${whoText(audience, rows)}. See on the Training page whether these remarks went down, and set how it turned out.` });
        meta.followUpReminded = new Date().toISOString(); changed = true;
      }
      if (changed) saveMeta(meta);
    }
  }
  setInterval(sendTrainingReminders, reminderCheckMs).unref();
}
