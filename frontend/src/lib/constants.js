export const TYPES = { neglected: 'Neglected Area', quality: 'Quality Checklist', trolley_pantry: 'Trolley / Pantry', handover: 'Shift Handover', vehicle: 'Vehicle Checklist', tools: 'Tools Control', inspection_rate: 'Inspection Rate Program', guest_interaction: 'Guest Interaction Check' };
export const QUALITY = ['Doors / balcony', 'Wardrobe', 'Minibar / cabinet', 'Kettle / tray', 'Bench / tables', 'Fan / AC', 'Bed / phone', 'Wall decor / lamp', 'Curtains', 'Armchair / carpet', 'Desk / TV', 'Mirror / glass', 'Counter / sink', 'Shower', 'Towel holder', 'Toilet / WC', 'Floor / skirting'];
// 'Cleaning time' is off the form until the hotel's standard times per room category and status are agreed (14 Oct 2026).
export const INSPECTION = ['Bathroom', 'Bedroom', 'Balcony', 'Maintenance', 'Presentation Room'];
// Guest Interaction Check criteria (1-10 each) and what each one means.
export const INTERACTION = [['English level', 'Speaks English well and can interact with guests'], ['Guest approaching', 'Has the skill to approach a guest'], ['Introduction', 'Can introduce themselves to a guest']];
export const VEHICLE = ['Tyres', 'Brakes', 'Lights', 'Horn', 'Mirrors', 'Cleanliness', 'Fuel / charge', 'Body condition', 'Steering', 'First aid kit'];
// Reports can be dated up to a week back (late paperwork), never in the future; the server enforces the same rule.
export const REPORT_BACKDATE_DAYS = 7;
export const reportKind = (report) => (report.type === 'handover' ? 'handovers' : report.type === 'vehicle' ? 'vehicles' : 'reports');
export const emptyEntry = (type) => type === 'guest_interaction' ? { hkName: '', scores: {}, remarks: '' } : type === 'inspection_rate' ? { room: '', scores: {}, remarks: '' } : type === 'quality' ? { room: '', hkName: '', scores: {}, remarks: '' } : type === 'neglected' ? { room: '', hkName: '', scores: {}, remarks: '' } : type === 'trolley_pantry' ? { block: '', hkName: '', scores: {}, remarks: '' } : { tool: '', quantity: '', status: 'Good', assignedTo: '', remarks: '' };
export const ROLE_TYPES = { supervisor: ['neglected', 'quality', 'trolley_pantry', 'handover', 'guest_interaction'], storekeeper: ['tools'], driver: ['vehicle'], manager: Object.keys(TYPES), assistant_manager: Object.keys(TYPES) };
export const typesForRole = (role) => ROLE_TYPES[role] || [];
// The housekeepers a report is about, for the Latest reports list ("Amina Said, Pili Omar +2").
export const HK_REPORT_TYPES = ['quality', 'neglected', 'trolley_pantry', 'guest_interaction'];
// Same bands as the Overview and profiles: 8+ good, 7–7.9 OK, under 7 needs support.
export const SCORE_GOOD = 8;
export const SCORE_OK = 7;
export const scoreTag = (value) => { const score = Number(value) || 0; return !score ? ['neutral', 'Not yet rated'] : score >= SCORE_GOOD ? ['good', 'Good'] : score >= SCORE_OK ? ['ok', 'OK'] : ['support', 'Needs support']; };
