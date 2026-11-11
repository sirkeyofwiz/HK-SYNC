export const TYPES = { neglected: 'Neglected Area', quality: 'Quality Checklist', trolley_pantry: 'Trolley / Pantry', handover: 'Shift Handover', vehicle: 'Vehicle Checklist', tools: 'Tools Control', inspection_rate: 'Inspection Rate Program', guest_interaction: 'Guest Interaction Check', mattress_rotation: 'Mattress Rotation', upholstery: 'Upholstery Cleaning', drainage: 'Water Drainage' };
export const QUALITY = ['Doors / balcony', 'Wardrobe', 'Minibar / cabinet', 'Kettle / tray', 'Bench / tables', 'Fan / AC', 'Bed / phone', 'Wall decor / lamp', 'Curtains', 'Armchair / carpet', 'Desk / TV', 'Mirror / glass', 'Counter / sink', 'Shower', 'Towel holder', 'Toilet / WC', 'Floor / skirting'];
// 'Cleaning time' is off the form until the hotel's standard times per room category and status are agreed (14 Oct 2026).
// Inspection Rate Program: six items of 10, so a room is out of 60 and passes at 36 (an average of 6). Rooms filed before
// Entrance Area was added (2026-11-05) have five items: out of 50, passing at 30. Averages are shown on the 60 scale.
export const IRP_PASS = 36;
export const IRP_SCALE = 60;
export const INSPECTION = ['Bathroom', 'Bedroom', 'Balcony', 'Maintenance', 'Presentation Room', 'Entrance Area'];
// A room's items: all six, or the first five for an older room saved without Entrance Area.
export const irpItems = (scores, older = false) => (older && !(scores && Object.prototype.hasOwnProperty.call(scores, 'Entrance Area')) ? INSPECTION.slice(0, 5) : INSPECTION);
// Guest Interaction Check criteria (1-10 each) and what each one means.
export const INTERACTION = [['English level', 'Speaks English well and can interact with guests'], ['Guest approaching', 'Has the skill to approach a guest'], ['Introduction', 'Can introduce themselves to a guest']];
export const VEHICLE = ['Tyres', 'Brakes', 'Lights', 'Horn', 'Mirrors', 'Cleanliness', 'Fuel / charge', 'Body condition', 'Steering', 'First aid kit'];
// Reports can be dated up to a week back (late paperwork), never in the future; the server enforces the same rule.
export const REPORT_BACKDATE_DAYS = 7;
// What an Overview "focus" shows on the Reports page, across every kind of report.
export const focusMatch = (item, focus) => (!focus.flagged || item.flagged) && (!focus.personId || item.submittedBy === focus.personId) && (!focus.rooms || (item.itemCount > 0 && !NOT_ROOMS.includes(item.type) && !NOT_INSPECTIONS.includes(item.type))) && (!focus.checks || (item.itemCount > 0 && item.type === 'trolley_pantry'));
// Room care logs (mattress rotation, upholstery, water drainage) list rooms, but they aren't inspections.
export const NOT_INSPECTIONS = ['mattress_rotation', 'upholstery', 'drainage'];
// Not rooms: a Guest Interaction Check is about a person, and Trolley / Pantry counts trolleys and pantries (their own card).
export const NOT_ROOMS = ['guest_interaction', 'trolley_pantry'];
export const reportKind = (report) => (report.type === 'handover' ? 'handovers' : report.type === 'vehicle' ? 'vehicles' : 'reports');
export const emptyEntry = (type) => type === 'mattress_rotation' ? { room: '', hkName: '', remarks: '' } : type === 'upholstery' ? { room: '', items: [], remarks: '' } : type === 'drainage' ? { room: '', status: '', remarks: '' } : type === 'guest_interaction' ? { hkName: '', scores: {}, remarks: '' } : type === 'inspection_rate' ? { room: '', scores: {}, remarks: '' } : type === 'quality' ? { room: '', hkName: '', scores: {}, remarks: '' } : type === 'neglected' ? { room: '', hkName: '', scores: {}, remarks: '' } : type === 'trolley_pantry' ? { block: '', hkName: '', scores: {}, remarks: '' } : { tool: '', quantity: '', status: 'Good', assignedTo: '', remarks: '' };
// How each role is written for people; the stored role names use underscores.
export const ROLE_NAMES = { supervisor: 'Supervisor', driver: 'Driver', storekeeper: 'Storekeeper', store_supervisor: 'Store supervisor', laundry: 'Laundry', assistant_manager: 'Assistant Manager', manager: 'Manager' };
export const ROLE_TYPES = { supervisor: ['neglected', 'quality', 'trolley_pantry', 'handover', 'guest_interaction', 'mattress_rotation', 'upholstery', 'drainage'], storekeeper: ['tools'], store_supervisor: ['tools'], driver: ['vehicle'], laundry: [], manager: Object.keys(TYPES), assistant_manager: Object.keys(TYPES) };
export const typesForRole = (role) => ROLE_TYPES[role] || [];
// The housekeepers a report is about, for the Latest reports list ("Amina Said, Pili Omar +2").
export const HK_REPORT_TYPES = ['quality', 'neglected', 'trolley_pantry', 'guest_interaction'];
// Same bands as the Overview and profiles: 8+ good, 7–7.9 OK, under 7 needs support.
export const SCORE_GOOD = 8;
export const SCORE_OK = 7;
export const scoreTag = (value) => { const score = Number(value) || 0; return !score ? ['neutral', 'Not yet rated'] : score >= SCORE_GOOD ? ['good', 'Good'] : score >= SCORE_OK ? ['ok', 'OK'] : ['support', 'Needs support']; };
