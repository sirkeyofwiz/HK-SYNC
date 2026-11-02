// The hotel's rooms, block by block, as on the room care sheets (the server keeps the same list in backend/roomcare.js):
// blocks 1-18 have rooms x01-x08, block 19 has 1901-1910, the suites are 2001-2003, and blocks 21-25 have x01-x10.
const range = (block, count) => Array.from({ length: count }, (_, index) => String(block * 100 + index + 1));
export const BLOCKS = [
  ...Array.from({ length: 18 }, (_, index) => ({ name: `Block ${index + 1}`, rooms: range(index + 1, 8) })),
  { name: 'Block 19', rooms: range(19, 10) },
  { name: 'Suites', rooms: range(20, 3) },
  ...[21, 22, 23, 24, 25].map((block) => ({ name: `Block ${block}`, rooms: range(block, 10) }))
];
export const ROOMS = BLOCKS.flatMap((block) => block.rooms);
export const UPHOLSTERY_ITEMS = ['Armchair', 'Luggage rack', 'Carpet', 'Sofa', 'Pouf'];
export const ROOM_CARE_TYPES = ['mattress_rotation', 'upholstery', 'drainage'];
// How often each is due, as the Room care tab says it.
export const ROOM_CARE_EVERY = { mattress_rotation: 'every 4 months', upholstery: 'every month', drainage: 'every month' };
export const DRAINAGE_STEPS = ['Open all taps and the shower in the bathroom', 'Let the water flow for 5 minutes', 'Report any plumbing issue to Maintenance'];
