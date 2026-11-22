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

export function registerTraining(app, { database, authMiddleware, requireManager, remarks, people, support, today }) {
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

  // Plan a training: a Training action on the support plan of each chosen person.
  app.post('/api/training-plans', authMiddleware, requireManager, (req, res) => {
    const audience = req.body?.audience;
    if (!AUDIENCES.includes(audience)) return res.status(400).json({ message: 'Choose housekeepers or supervisors.' });
    const topic = topicsFor(audience).find((entry) => entry.id === req.body?.topicId);
    if (!topic) return res.status(404).json({ message: 'That training topic was not found.' });
    const chosen = Array.isArray(req.body?.people) ? req.body.people.slice(0, 100) : [];
    if (!chosen.length) return res.status(400).json({ message: 'Choose who takes part.' });
    const date = String(req.body?.date || '');
    if (!DATE.test(date)) return res.status(400).json({ message: 'Choose the training date.' });
    const created = [];
    for (const person of chosen) {
      const result = support.addAction(audience, person?.ref, person?.name, { date, action: 'Training', problem: `Training: ${topic.label}`, notes: req.body?.notes || '', followUp: req.body?.followUp || null, status: 'in_progress' }, req.currentUser.id);
      if (result.error) return res.status(400).json({ message: created.length ? `${result.error} (${created.length} already added)` : result.error });
      created.push(result.action);
    }
    return res.status(201).json({ created: created.length });
  });
}
