// Room care: three logs supervisors keep, from the hotel's Excel sheets.
// - Mattress rotation: each room's mattress turned (and by which housekeeper), every 4 months.
// - Upholstery: armchair, luggage rack, carpet, sofa, pouf, decoration pillow and bed runner cleaned in a room, every month.
// - Water drainage: in an empty room, all taps and the shower run for 5 minutes, every month; a plumbing problem is
//   reported as an issue (it flags the report for the managers, like any other problem).
// Each is an ordinary report (type mattress_rotation / upholstery / drainage) with one line per room. The tracker
// (GET /api/room-care) shows, per room, when it was last done and whether it is due again. Drainage reports filed before
// 2026-11-06 have one line per block: they stay on their reports and in History, and don't count for any one room.

// The hotel's rooms, block by block, as on the sheets: blocks 1-18 have rooms x01-x08, block 19 has 1901-1910, the
// suites are 2001-2003, and blocks 21-25 have x01-x10. The app keeps the same list (frontend/src/lib/rooms.js).
const range = (block, count) => Array.from({ length: count }, (_, index) => String(block * 100 + index + 1));
export const BLOCKS = [
  ...Array.from({ length: 18 }, (_, index) => ({ name: `Block ${index + 1}`, rooms: range(index + 1, 8) })),
  { name: 'Block 19', rooms: range(19, 10) },
  { name: 'Suites', rooms: range(20, 3) },
  ...[21, 22, 23, 24, 25].map((block) => ({ name: `Block ${block}`, rooms: range(block, 10) }))
];
export const ROOMS = BLOCKS.flatMap((block) => block.rooms);
export const UPHOLSTERY_ITEMS = ['Armchair', 'Luggage rack', 'Carpet', 'Sofa', 'Pouf', 'Decoration pillow', 'Bed runner', 'New rooms TV table chair'];
export const DRAINAGE_STATUSES = ['Done', 'Issue'];
// How long until it is due again, in months.
export const ROOM_CARE = {
  mattress_rotation: { label: 'Mattress Rotation', months: 4, by: 'room' },
  upholstery: { label: 'Upholstery Cleaning', months: 1, by: 'room' },
  drainage: { label: 'Water Drainage', months: 1, by: 'room' }
};
export const ROOM_CARE_TYPES = Object.keys(ROOM_CARE);

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isLine = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Checks and tidies a room care report before it is saved; returns a problem to show, or null.
// `blockReport`: editing a drainage report filed by block, whose block lines may stay.
export function prepareRoomCare(type, data, isRosterName, { blockReport = false } = {}) {
  if (!ROOM_CARE[type]) return null;
  const lines = (Array.isArray(data.entries) ? data.entries : []).filter(isLine);
  // One line per room.
  const rooms = lines.filter((line) => clean(line.room, 10) || clean(line.block, 40) || clean(line.hkName, 80) || (Array.isArray(line.items) && line.items.length) || clean(line.remarks, 10));
  if (!rooms.length) return 'Add at least one room.';
  const drainageLine = (line, name) => {
    line.remarks = clean(line.remarks, 500);
    delete line.scores;
    if (!DRAINAGE_STATUSES.includes(line.status)) return `${name}: choose Done or Issue.`;
    if (line.status === 'Issue' && !line.remarks) return `${name}: say what the plumbing issue is.`;
    return null;
  };
  const seen = new Set();
  for (const [index, line] of rooms.entries()) {
    if (type === 'drainage' && blockReport && line.block && !clean(line.room, 10)) {
      if (!BLOCKS.some((block) => block.name === line.block)) return `"${clean(line.block, 40)}" is not a block.`;
      if (seen.has(line.block)) return `${line.block} is on the report twice.`;
      seen.add(line.block);
      const problem = drainageLine(line, line.block);
      if (problem) return problem;
      delete line.room;
      continue;
    }
    line.room = clean(line.room, 10);
    const name = line.room ? `Room ${line.room}` : `Line ${index + 1}`;
    if (!line.room) return `${name}: choose the room.`;
    if (!ROOMS.includes(line.room)) return `Room ${line.room} is not one of the hotel's rooms.`;
    if (seen.has(line.room)) return `Room ${line.room} is on the report twice.`;
    seen.add(line.room);
    line.remarks = clean(line.remarks, 500);
    delete line.scores;
    if (type === 'mattress_rotation') {
      line.hkName = clean(line.hkName, 80);
      if (!line.hkName) return `${name}: choose the housekeeper who turned the mattress.`;
      const rosterName = isRosterName(line.hkName);
      if (rosterName) line.hkName = rosterName;
      delete line.items;
    } else if (type === 'drainage') {
      const problem = drainageLine(line, name);
      if (problem) return problem;
      delete line.hkName;
      delete line.items;
      delete line.block;
    } else {
      const items = Array.isArray(line.items) ? line.items : [];
      line.items = UPHOLSTERY_ITEMS.filter((item) => items.includes(item));
      if (!line.items.length) return `${name}: tick what was cleaned.`;
      delete line.hkName;
    }
  }
  data.entries = rooms;
  return null;
}

// `date` plus whole months, as YYYY-MM-DD (31 January + 1 month = 28/29 February).
function addMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const last = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, last))).toISOString().slice(0, 10);
}

export function registerRoomCare(app, { authMiddleware, who, reports, userName, today }) {
  // Supervisors keep these logs; managers read them.
  const canSee = (user) => ['supervisor', 'manager', 'assistant_manager'].includes(user?.role);

  // Every room care line ever recorded for a type, oldest first (on the same day, the later report last).
  const records = (type) => reports().filter((report) => report.type === type && !report.voided)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)))
    .flatMap((report) => (Array.isArray(report.data?.entries) ? report.data.entries : [])
      .map((line) => ({ key: line.room || line.block, date: report.date, reportId: report.id, by: userName(report.submittedBy), hkName: line.hkName || null, items: line.items || null, status: line.status || null, remarks: line.remarks || '' }))
      .filter((row) => row.key));

  // The tracker: per room, the latest record and whether it is due.
  app.get('/api/room-care', authMiddleware, (req, res) => {
    if (!canSee(who(req))) return res.status(403).json({ message: 'Room care is for supervisors and managers.' });
    const now = today();
    const tracker = {};
    for (const [type, rule] of Object.entries(ROOM_CARE)) {
      const done = records(type);
      const latest = new Map(done.map(({ key, ...last }) => [key, last]));
      const rows = ROOMS.map((key) => {
        const last = latest.get(key) || null;
        const dueOn = last ? addMonths(last.date, rule.months) : null;
        return { key, last, dueOn, due: !last || dueOn <= now };
      });
      tracker[type] = { label: rule.label, months: rule.months, by: rule.by, rows, dueCount: rows.filter((row) => row.due).length, neverCount: rows.filter((row) => !row.last).length };
    }
    res.json({ today: now, blocks: BLOCKS, tracker });
  });

  // History: every record of one log, newest first, optionally for one room (or, on old drainage reports, block) only.
  app.get('/api/room-care/history', authMiddleware, (req, res) => {
    if (!canSee(who(req))) return res.status(403).json({ message: 'Room care is for supervisors and managers.' });
    const { type, key } = req.query;
    if (!ROOM_CARE[type]) return res.status(400).json({ message: 'Choose mattress rotation, upholstery or water drainage.' });
    const rows = records(type).filter((row) => !key || row.key === key).reverse();
    res.json({ type, label: ROOM_CARE[type].label, by: ROOM_CARE[type].by, rows });
  });
}
