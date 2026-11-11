// Guest laundry: every guest bag from the room to the laundry and back, with who handled it and when.
//
// A bag moves through these steps, each saved with the time and the person:
//   collected  a housekeeper picked it up from the room (their name is typed; housekeepers have no login)
//   received   a laundry staff member took it in at the laundry. The promise starts here: Express is due back in
//              4 hours, Standard in 24 hours.
//   washing    being washed / ironed
//   ready      finished, waiting for a housekeeper
//   out        a laundry staff member handed it to a housekeeper (named) to take to the room
//   returned   back in the guest's room. Reminders stop.
// A bag can be logged straight at the laundry (received) when nobody logged the collection.
//
// Reminders (user's choice, 2026-11-11): from received until returned, laundry staff and supervisors are reminded every
// 10 minutes for Express and every hour for Standard. Express rings even in quiet hours; Standard waits for them to end.
// Managers get one alert when a bag goes past its due time.
//
// Laundry staff also hand over between shifts (morning → afternoon): the open bags at that moment are kept with the note.
import { randomUUID } from 'node:crypto';

export const LAUNDRY_ITEMS = ['Shirt', 'T-shirt', 'Trousers', 'Shorts', 'Dress', 'Skirt', 'Jacket', 'Suit', 'Sweater', 'Underwear', 'Socks', 'Pyjamas', 'Swimwear', 'Other'];
export const LAUNDRY_SERVICES = { wash_iron: 'Wash & iron', wash_fold: 'Wash & fold', iron: 'Iron only', dry_clean: 'Dry clean' };
export const LAUNDRY_SPEEDS = { standard: 'Standard', express: 'Express' };
export const LAUNDRY_STEPS = ['collected', 'received', 'washing', 'ready', 'out', 'returned'];
export const STEP_LABELS = { collected: 'Collected from room', received: 'Received at laundry', washing: 'Washing', ready: 'Ready', out: 'With housekeeper for delivery', returned: 'Returned to guest' };
const DUE_HOURS = { express: 4, standard: 24 };
// Who may open Guest laundry and log steps; managers also delete bags.
export const LAUNDRY_ROLES = ['laundry', 'supervisor', 'manager', 'assistant_manager'];
const MANAGER_ROLES = ['manager', 'assistant_manager'];
const REMIND_ROLES = ['laundry', 'supervisor'];
const SHIFTS = { morning: 'Morning → afternoon', afternoon: 'Afternoon → night', night: 'Night → morning' };
const HISTORY_DAYS = 14;
const MAX_PIECES = 200;

const clean = (value, max = 80) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const pieces = (items) => Object.values(items || {}).reduce((sum, count) => sum + count, 0);
const isOpen = (bag) => !bag.voided && bag.status !== 'returned';
// "At the laundry" for reminders: received and not yet back with the guest.
const remindable = (bag) => isOpen(bag) && bag.receivedAt;

export function registerLaundry(app, { database, authMiddleware, users, findUser, notify, clearNotifications, quiet, broadcast, now = () => Date.now(), reminderMs = {}, checkMs = 60 * 1000 }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS laundry_bags (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS laundry_handovers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  const load = (table) => new Map(database.prepare(`SELECT data FROM ${table}`).all().map((row) => JSON.parse(row.data)).map((row) => [row.id, row]));
  const bags = load('laundry_bags');
  const handovers = load('laundry_handovers');
  const save = (table, row) => database.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`).run(row.id, JSON.stringify(row));
  const saveBag = (bag) => { save('laundry_bags', bag); broadcast(); };
  const remindEvery = { express: reminderMs.express ?? 10 * 60 * 1000, standard: reminderMs.standard ?? 60 * 60 * 1000 };

  const access = (req, res, next) => {
    const user = findUser(req.user.id);
    if (!user || user.active === false || !LAUNDRY_ROLES.includes(user.role)) return res.status(403).json({ message: 'Only laundry staff, supervisors and managers can open Guest laundry.' });
    req.laundryUser = user;
    next();
  };
  const iso = () => new Date(now()).toISOString();
  const nextNumber = () => {
    const highest = [...bags.values()].reduce((max, bag) => Math.max(max, Number(bag.number) || 0), 0);
    return highest + 1;
  };
  const shape = (bag) => ({ ...bag, pieces: pieces(bag.items), overdue: Boolean(isOpen(bag) && bag.dueAt && Date.parse(bag.dueAt) < now()) });

  // Items: { Shirt: 2, ... } with whole numbers only; at least one piece.
  function readItems(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Count the items in the bag.' };
    const items = {};
    for (const [name, value] of Object.entries(raw)) {
      if (!LAUNDRY_ITEMS.includes(name)) return { error: `Unknown item: ${clean(name, 30)}.` };
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0 || count > MAX_PIECES) return { error: `${name}: enter a whole number from 0 to ${MAX_PIECES}.` };
      if (count) items[name] = count;
    }
    if (!pieces(items)) return { error: 'Count at least one item in the bag.' };
    return { items };
  }

  const recipients = () => users().filter((user) => user.active !== false && REMIND_ROLES.includes(user.role));
  const managers = () => users().filter((user) => user.active !== false && MANAGER_ROLES.includes(user.role));
  const bagTitle = (bag) => `Room ${bag.room} · bag ${bag.number}`;
  const link = (bag) => ({ page: 'laundry', id: bag.id });
  const isReminder = (bag) => (notification) => notification.type === 'laundry_reminder' && notification.link?.id === bag.id;
  const clearReminders = (bag) => { for (const user of recipients()) clearNotifications(user.id, isReminder(bag)); };

  function receive(bag, user, at) {
    bag.receivedAt = at;
    bag.receivedById = user.id;
    bag.receivedByName = user.name;
    bag.dueAt = new Date(Date.parse(at) + DUE_HOURS[bag.speed] * 60 * 60 * 1000).toISOString();
    bag.remindedAt = at;
  }

  app.get('/api/laundry', authMiddleware, access, (req, res) => {
    const since = now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const list = [...bags.values()].filter((bag) => !bag.voided && (isOpen(bag) || Date.parse(bag.returnedAt || bag.createdAt) >= since))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(shape);
    const recent = [...handovers.values()].filter((row) => Date.parse(row.createdAt) >= since).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
    return res.json({
      bags: list, handovers: recent,
      staff: users().filter((user) => user.active !== false && user.role === 'laundry').map((user) => ({ id: user.id, name: user.name })),
      rules: { items: LAUNDRY_ITEMS, services: LAUNDRY_SERVICES, speeds: LAUNDRY_SPEEDS, steps: STEP_LABELS, dueHours: DUE_HOURS, shifts: SHIFTS, remindMinutes: { express: remindEvery.express / 60000, standard: remindEvery.standard / 60000 } },
      canDelete: MANAGER_ROLES.includes(req.laundryUser.role)
    });
  });

  app.post('/api/laundry/bags', authMiddleware, access, (req, res) => {
    const body = req.body || {};
    const room = clean(body.room, 12);
    if (!room) return res.status(400).json({ message: 'Enter the room number.' });
    if (!LAUNDRY_SERVICES[body.service]) return res.status(400).json({ message: 'Choose the service the guest asked for.' });
    if (!LAUNDRY_SPEEDS[body.speed]) return res.status(400).json({ message: 'Choose Standard or Express.' });
    const stage = body.stage === 'received' ? 'received' : 'collected';
    const collectedBy = clean(body.collectedBy);
    if (!collectedBy) return res.status(400).json({ message: 'Enter the housekeeper who brought the bag from the room.' });
    const { items, error } = readItems(body.items);
    if (error) return res.status(400).json({ message: error });
    const at = iso();
    const user = req.laundryUser;
    const bag = {
      id: randomUUID(), number: nextNumber(), room, service: body.service, speed: body.speed, items, notes: clean(body.notes, 300),
      status: stage, collectedBy, collectedAt: at, createdAt: at, createdById: user.id, createdByName: user.name,
      history: [{ step: 'collected', at, byId: user.id, byName: user.name, hkName: collectedBy }]
    };
    if (stage === 'received') {
      if (user.role !== 'laundry' && !MANAGER_ROLES.includes(user.role) && user.role !== 'supervisor') return res.status(403).json({ message: 'Not allowed.' });
      receive(bag, user, at);
      bag.history.push({ step: 'received', at, byId: user.id, byName: user.name });
    }
    bags.set(bag.id, bag);
    saveBag(bag);
    const kind = bag.speed === 'express' ? 'Express' : 'Standard';
    for (const person of recipients()) {
      notify(person.id, { type: 'laundry', fromUserId: user.id, urgent: bag.speed === 'express', title: stage === 'received' ? `New ${kind} bag at the laundry` : `${kind} bag on its way to the laundry`, body: `${bagTitle(bag)} · ${pieces(items)} pieces · ${LAUNDRY_SERVICES[bag.service]} · from ${collectedBy}${bag.dueAt ? ` · due back ${dueText(bag.dueAt)}` : ''}`, link: link(bag) });
    }
    return res.status(201).json({ bag: shape(bag) });
  });

  // Move a bag one step on (or log a later step directly, e.g. Ready straight from Received).
  app.post('/api/laundry/bags/:id/step', authMiddleware, access, (req, res) => {
    const bag = bags.get(req.params.id);
    if (!bag || bag.voided) return res.status(404).json({ message: 'That bag was not found.' });
    const to = req.body?.to;
    const from = LAUNDRY_STEPS.indexOf(bag.status);
    const target = LAUNDRY_STEPS.indexOf(to);
    if (target <= 0) return res.status(400).json({ message: 'Choose the next step.' });
    if (target <= from) return res.status(409).json({ message: `This bag is already ${STEP_LABELS[bag.status].toLowerCase()}.` });
    const user = req.laundryUser;
    const at = iso();
    const hkName = clean(req.body?.hkName);
    if (to === 'out' && !hkName) return res.status(400).json({ message: 'Enter the housekeeper taking the bag to the room.' });
    if (to === 'returned' && !bag.handedOutAt && !hkName) return res.status(400).json({ message: 'Enter the housekeeper who took the bag to the room.' });
    if (!bag.receivedAt) { receive(bag, user, at); if (to !== 'received') bag.history.push({ step: 'received', at, byId: user.id, byName: user.name }); }
    if (to === 'out' || (to === 'returned' && !bag.handedOutAt)) {
      bag.handedOutAt = at; bag.handedOutById = user.id; bag.handedOutByName = user.name; bag.deliveredBy = hkName;
      if (to === 'returned') bag.history.push({ step: 'out', at, byId: user.id, byName: user.name, hkName });
    }
    if (to === 'returned') { bag.returnedAt = at; bag.returnedById = user.id; bag.returnedByName = user.name; clearReminders(bag); }
    bag.status = to;
    bag.history.push({ step: to, at, byId: user.id, byName: user.name, ...(to === 'out' ? { hkName } : {}), ...(clean(req.body?.note, 200) ? { note: clean(req.body.note, 200) } : {}) });
    saveBag(bag);
    return res.json({ bag: shape(bag) });
  });

  // Fix a mistake (room, counts, service, notes) while the bag is still open.
  app.patch('/api/laundry/bags/:id', authMiddleware, access, (req, res) => {
    const bag = bags.get(req.params.id);
    if (!bag || bag.voided) return res.status(404).json({ message: 'That bag was not found.' });
    if (!isOpen(bag) && !MANAGER_ROLES.includes(req.laundryUser.role)) return res.status(409).json({ message: 'This bag is already back with the guest.' });
    const body = req.body || {};
    if ('room' in body) { const room = clean(body.room, 12); if (!room) return res.status(400).json({ message: 'Enter the room number.' }); bag.room = room; }
    if ('service' in body) { if (!LAUNDRY_SERVICES[body.service]) return res.status(400).json({ message: 'Choose the service.' }); bag.service = body.service; }
    if ('items' in body) { const { items, error } = readItems(body.items); if (error) return res.status(400).json({ message: error }); bag.items = items; }
    if ('notes' in body) bag.notes = clean(body.notes, 300);
    bag.editedAt = iso(); bag.editedByName = req.laundryUser.name;
    saveBag(bag);
    return res.json({ bag: shape(bag) });
  });

  app.delete('/api/laundry/bags/:id', authMiddleware, access, (req, res) => {
    const bag = bags.get(req.params.id);
    if (!bag || bag.voided) return res.status(404).json({ message: 'That bag was not found.' });
    const own = bag.createdById === req.laundryUser.id && !bag.receivedAt;
    if (!MANAGER_ROLES.includes(req.laundryUser.role) && !own) return res.status(403).json({ message: 'Only a manager can delete a bag once the laundry has it.' });
    bag.voided = true; bag.voidedAt = iso(); bag.voidedById = req.laundryUser.id;
    clearReminders(bag);
    saveBag(bag);
    return res.json({ ok: true });
  });

  app.post('/api/laundry/handovers', authMiddleware, access, (req, res) => {
    const user = req.laundryUser;
    const shift = SHIFTS[req.body?.shift] ? req.body.shift : null;
    if (!shift) return res.status(400).json({ message: 'Choose the shift.' });
    const receiver = users().find((entry) => entry.id === req.body?.toId && entry.active !== false && entry.role === 'laundry');
    const toName = receiver?.name || clean(req.body?.toName);
    if (!toName) return res.status(400).json({ message: 'Choose who takes over.' });
    if (receiver?.id === user.id) return res.status(400).json({ message: 'Hand over to someone else.' });
    const open = [...bags.values()].filter(isOpen).sort((a, b) => a.number - b.number)
      .map((bag) => ({ id: bag.id, number: bag.number, room: bag.room, status: bag.status, speed: bag.speed, pieces: pieces(bag.items), dueAt: bag.dueAt || null }));
    const row = { id: randomUUID(), shift, fromId: user.id, fromName: user.name, toId: receiver?.id || null, toName, notes: clean(req.body?.notes, 1000), bags: open, createdAt: iso() };
    handovers.set(row.id, row);
    save('laundry_handovers', row);
    broadcast();
    if (receiver) notify(receiver.id, { type: 'laundry', fromUserId: user.id, title: 'Laundry handover for you', body: `From ${user.name} · ${open.length} open bag${open.length === 1 ? '' : 's'}${row.notes ? ` · ${row.notes}` : ''}`, link: { page: 'laundry' } });
    return res.status(201).json({ handover: row });
  });

  const dueText = (dueAt) => new Intl.DateTimeFormat('en-GB', { timeZone: process.env.APP_TIMEZONE || 'Africa/Dar_es_Salaam', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(dueAt));

  function sendReminders() {
    const time = now();
    for (const bag of bags.values()) {
      if (!remindable(bag)) continue;
      const overdue = Date.parse(bag.dueAt) < time;
      if (overdue && !bag.overdueAlertedAt) {
        bag.overdueAlertedAt = new Date(time).toISOString();
        save('laundry_bags', bag);
        for (const manager of managers()) notify(manager.id, { type: 'laundry', urgent: bag.speed === 'express', title: `Laundry overdue · ${bagTitle(bag)}`, body: `${LAUNDRY_SPEEDS[bag.speed]} · ${STEP_LABELS[bag.status]} · was due ${dueText(bag.dueAt)}`, link: link(bag) });
      }
      if (time - (Date.parse(bag.remindedAt || bag.receivedAt) || 0) < remindEvery[bag.speed]) continue;
      bag.remindedAt = new Date(time).toISOString();
      save('laundry_bags', bag);
      const express = bag.speed === 'express';
      const stage = bag.status === 'ready' ? 'ready, waiting for a housekeeper to take it to the room' : bag.status === 'out' ? `with ${bag.deliveredBy} for delivery` : 'still at the laundry';
      for (const person of recipients()) {
        // Express rings even in quiet hours; Standard waits until they end.
        if (!express && quiet(person)) continue;
        clearNotifications(person.id, isReminder(bag));
        notify(person.id, { type: 'laundry_reminder', urgent: express, title: `${express ? 'Express' : 'Standard'} laundry: ${bagTitle(bag)}`, body: `${pieces(bag.items)} pieces · ${stage} · ${overdue ? `overdue since ${dueText(bag.dueAt)}` : `due back ${dueText(bag.dueAt)}`}. Mark it returned when it is in the room.`, link: link(bag) });
      }
    }
  }
  setInterval(sendReminders, checkMs).unref();
}
