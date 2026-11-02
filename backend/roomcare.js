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

  app.get('/api/room-care', authMiddleware, (req, res) => {
    if (!canSee(who(req))) return res.status(403).json({ message: 'Room care is for supervisors and managers.' });
    const now = today();
    const tracker = {};
    for (const [type, rule] of Object.entries(ROOM_CARE)) {
      // The latest record per room or block (newest report date wins; on the same day, the later report).
      const latest = new Map();
      const done = reports().filter((report) => report.type === type && !report.voided)
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const report of done) {
        for (const line of Array.isArray(report.data?.entries) ? report.data.entries : []) {
          const key = rule.by === 'room' ? line.room : line.block;
          if (!key) continue;
          latest.set(key, { date: report.date, reportId: report.id, by: userName(report.submittedBy), hkName: line.hkName || null, items: line.items || null, status: line.status || null, remarks: line.remarks || '' });
        }
      }
      const keys = rule.by === 'room' ? ROOMS : BLOCKS.map((block) => block.name);
      const rows = keys.map((key) => {
        const last = latest.get(key) || null;
        const dueOn = last ? addMonths(last.date, rule.months) : null;
        return { key, last, dueOn, due: !last || dueOn <= now };
      });
      tracker[type] = { label: rule.label, months: rule.months, by: rule.by, rows, dueCount: rows.filter((row) => row.due).length, neverCount: rows.filter((row) => !row.last).length };
      // Drainage: what was done in each week of this month, for the monthly sheet.
      if (type === 'drainage') {
        const month = now.slice(0, 7);
        tracker[type].month = month;
        tracker[type].weeks = Object.fromEntries(keys.map((key) => [key, []]));
        for (const report of done.filter((entry) => entry.date.startsWith(month))) {
          for (const line of report.data.entries || []) {
            if (!tracker[type].weeks[line.block]) continue;
            tracker[type].weeks[line.block].push({ week: Math.min(4, Math.ceil(Number(report.date.slice(8)) / 7)), date: report.date, status: line.status, remarks: line.remarks || '', reportId: report.id });
          }
        }
      }
    }
    res.json({ today: now, blocks: BLOCKS, tracker });
  });
}
