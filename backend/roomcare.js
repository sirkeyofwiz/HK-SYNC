// Room care: three logs supervisors keep, from the hotel's Excel sheets.
// - Mattress rotation: each room's mattress turned (and by which housekeeper), every 4 months.
// - Upholstery: armchair, luggage rack, carpet, sofa, pouf, decoration pillow and bed runner cleaned in a room, every month.
// - Water drainage: in each block's empty rooms, all taps and the shower run for 5 minutes, every month; a plumbing
//   problem is reported as an issue (it flags the report for the managers, like any other problem).
// Each is an ordinary report (type mattress_rotation / upholstery / drainage) with one line per room or block. The
// tracker (GET /api/room-care) shows, per room or block, when it was last done and whether it is due again.

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
export const UPHOLSTERY_ITEMS = ['Armchair', 'Luggage rack', 'Carpet', 'Sofa', 'Pouf', 'Decoration pillow', 'Bed runner'];
export const DRAINAGE_STATUSES = ['Done', 'Issue'];
// How long until it is due again, in months.
export const ROOM_CARE = {
  mattress_rotation: { label: 'Mattress Rotation', months: 4, by: 'room' },
  upholstery: { label: 'Upholstery Cleaning', months: 1, by: 'room' },
  drainage: { label: 'Water Drainage', months: 1, by: 'block' }
};
export const ROOM_CARE_TYPES = Object.keys(ROOM_CARE);

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isLine = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Checks and tidies a room care report before it is saved; returns a problem to show, or null.
export function prepareRoomCare(type, data, isRosterName) {
  if (!ROOM_CARE[type]) return null;
  const lines = (Array.isArray(data.entries) ? data.entries : []).filter(isLine);
  if (type === 'drainage') {
    // The form lists every block; only the blocks marked Done or Issue are kept.
    const marked = lines.filter((line) => clean(line.status, 10));
    if (!marked.length) return 'Mark at least one block as drained.';
    const seen = new Set();
    for (const line of marked) {
      if (!BLOCKS.some((block) => block.name === line.block)) return `"${clean(line.block, 40)}" is not a block.`;
      if (seen.has(line.block)) return `${line.block} is on the report twice.`;
      seen.add(line.block);
      if (!DRAINAGE_STATUSES.includes(line.status)) return `${line.block}: choose Done or Issue.`;
      line.remarks = clean(line.remarks, 500);
      if (line.status === 'Issue' && !line.remarks) return `${line.block}: say what the plumbing issue is.`;
      delete line.scores;
    }
    data.entries = marked;
    return null;
  }
  // Mattress rotation and upholstery: one line per room.
  const rooms = lines.filter((line) => clean(line.room, 10) || clean(line.hkName, 80) || (Array.isArray(line.items) && line.items.length) || clean(line.remarks, 10));
  if (!rooms.length) return 'Add at least one room.';
  const seen = new Set();
  for (const [index, line] of rooms.entries()) {
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
  const records = (type) => {
    const rule = ROOM_CARE[type];
    return reports().filter((report) => report.type === type && !report.voided)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)))
      .flatMap((report) => (Array.isArray(report.data?.entries) ? report.data.entries : [])
        .map((line) => ({ key: rule.by === 'room' ? line.room : line.block, date: report.date, reportId: report.id, by: userName(report.submittedBy), hkName: line.hkName || null, items: line.items || null, status: line.status || null, remarks: line.remarks || '' }))
        .filter((row) => row.key));
  };

  // The tracker: per room or block, the latest record and whether it is due. `month` (YYYY-MM, default this month)
  // picks the month shown on the drainage sheet, so managers can look back at earlier months.
  app.get('/api/room-care', authMiddleware, (req, res) => {
    if (!canSee(who(req))) return res.status(403).json({ message: 'Room care is for supervisors and managers.' });
    const now = today();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) && req.query.month <= now.slice(0, 7) ? req.query.month : now.slice(0, 7);
    const tracker = {};
    for (const [type, rule] of Object.entries(ROOM_CARE)) {
      const done = records(type);
      const latest = new Map(done.map(({ key, ...last }) => [key, last]));
      const keys = rule.by === 'room' ? ROOMS : BLOCKS.map((block) => block.name);
      const rows = keys.map((key) => {
        const last = latest.get(key) || null;
        const dueOn = last ? addMonths(last.date, rule.months) : null;
        return { key, last, dueOn, due: !last || dueOn <= now };
      });
      tracker[type] = { label: rule.label, months: rule.months, by: rule.by, rows, dueCount: rows.filter((row) => row.due).length, neverCount: rows.filter((row) => !row.last).length, first: done[0]?.date || null };
      // Drainage: what was done in each week of the month, for the monthly sheet.
      if (type === 'drainage') {
        tracker[type].month = month;
        tracker[type].weeks = Object.fromEntries(keys.map((key) => [key, []]));
        for (const row of done.filter((entry) => entry.date.startsWith(month))) {
          tracker[type].weeks[row.key]?.push({ week: Math.min(4, Math.ceil(Number(row.date.slice(8)) / 7)), date: row.date, status: row.status, remarks: row.remarks, reportId: row.reportId });
        }
      }
    }
    res.json({ today: now, blocks: BLOCKS, tracker });
  });

  // History: every record of one log, newest first, optionally for one room or block only.
  app.get('/api/room-care/history', authMiddleware, (req, res) => {
    if (!canSee(who(req))) return res.status(403).json({ message: 'Room care is for supervisors and managers.' });
    const { type, key } = req.query;
    if (!ROOM_CARE[type]) return res.status(400).json({ message: 'Choose mattress rotation, upholstery or water drainage.' });
    const rows = records(type).filter((row) => !key || row.key === key).reverse();
    res.json({ type, label: ROOM_CARE[type].label, by: ROOM_CARE[type].by, rows });
  });
}
