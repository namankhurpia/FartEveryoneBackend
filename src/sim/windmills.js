// Level 4: "Windmill Ridge". A raised road with no walls, blocked three times by windmills whose
// spiked arms reach right across the water. The only way through is between the arms. They
// get faster. They all turn counter-clockwise, so the way through is to ride round with the
// rotation, staying in the gap between two arms; against it you'd meet every arm head-on.

import { route } from './route.js';

export const WINDMILLS = {
  id: 'windmills',
  number: 4,
  name: 'Windmill Ridge',
  blurb: 'No walls and three giant windmills with spikes down to the water. Slip between the arms.',
  par: 150,

  water: [
    { x: 0, y: 0, w: 10, h: 12 },       // start pool
    { x: 0, y: 13, w: 6, h: 15 },       // road north
    { x: 0, y: 28, w: 16, h: 16 },      // windmill A's pool
    { x: 0, y: 43, w: 6, h: 15 },       // road north
    { x: 0, y: 58, w: 18, h: 16 },      // windmill B's pool
    { x: 23.5, y: 58, w: 30, h: 6 },    // road east
    { x: 46, y: 58, w: 16, h: 16 },     // windmill C's pool
    { x: 46, y: 40, w: 6, h: 21 },      // road south
    { x: 46, y: 24, w: 12, h: 12 },     // finish pool
  ],
  walls: [],
  spikes: [],
  currents: [],

  checkpoints: [
    { x: 0, y: -1, angle: 0, zone: null },
    { x: 0, y: 43, angle: 0, zone: { x: 0, y: 43, w: 6, h: 3 } },
    { x: 24, y: 58, angle: -Math.PI / 2, zone: { x: 24, y: 58, w: 3, h: 6 } },
    { x: 46, y: 40, angle: Math.PI, zone: { x: 46, y: 40, w: 6, h: 3 } },
  ],
  finish: { x: 46, y: 24, w: 11, h: 3 },

  movers: [
    { type: 'windmill', x: 0, y: 28, radius: 6.5, blades: 3, speed: 0.45 },
    { type: 'windmill', x: 0, y: 58, radius: 7.5, blades: 3, speed: 0.5 },
    { type: 'windmill', x: 46, y: 58, radius: 6.5, blades: 3, speed: 0.55 },
  ],

  bounds: { minX: -9, maxX: 54, minY: -6, maxY: 66 },

  route: route([[0, -1], [0, 18], [4, 25], [4, 31], [0, 38], [0, 50], [4.5, 54.5], [9, 58], [38, 58], [42, 54], [46, 51], [46, 30], [46, 24]]),
};
