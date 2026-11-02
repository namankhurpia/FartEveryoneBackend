// Level 6: "The Inferno". Everything at once, on a river that never stops: the whole level flows
// east, shoving you towards the edge the entire way. Two spike circles you have to steer into
// and out of through their openings, wells, and a windmill right across the track.

import { route } from './route.js';

export const INFERNO = {
  id: 'inferno',
  number: 6,
  name: 'The Inferno',
  blurb: 'A river that never stops pushing you off the edge, spike circles, wells and a windmill.',
  par: 180,

  flow: { ax: 0.8, ay: 0 }, // the river: east, everywhere, always
  wellPull: 1.5, // the river already drags you towards them; full-strength wells on top is impossible alone

  water: [
    { x: 0, y: 0, w: 16, h: 12 },       // start pool
    { x: 0, y: 58, w: 16, h: 105 },     // the long track north
    { x: 0, y: 116, w: 20, h: 12 },     // finish pool
  ],
  wells: [
    { x: 4, y: 36, r: 2.6 },
    { x: -4.5, y: 41, r: 2.4 },
    { x: 4, y: 46, r: 2.6 },
    { x: -4, y: 101, r: 2.6 },
    { x: 5, y: 106, r: 2.2 },
  ],
  walls: [],
  spikes: [],
  currents: [],

  checkpoints: [
    { x: 0, y: -1, angle: 0, zone: null },
    { x: -2, y: 31, angle: 0, zone: { x: 0, y: 31, w: 16, h: 2 } },
    { x: 0, y: 51, angle: 0, zone: { x: 0, y: 51, w: 16, h: 2 } },
    { x: 0, y: 75, angle: 0, zone: { x: 0, y: 75, w: 16, h: 2 } },
    { x: 2, y: 96, angle: 0, zone: { x: 0, y: 96, w: 16, h: 2 } },
  ],
  finish: { x: 0, y: 116, w: 19, h: 3 },

  movers: [
    // in from the south, out through the north-west: you have to turn inside it
    { type: 'ring', x: 0, y: 22, r: 6.5, gaps: [270, 150], gapDeg: 75 },
    { type: 'windmill', x: 0, y: 62, radius: 7.5, blades: 3, speed: 0.5 },
    // both openings on the east side, the side the river is pushing you towards
    { type: 'ring', x: 0, y: 86, r: 6.5, gaps: [300, 60], gapDeg: 75 },
  ],

  bounds: { minX: -10, maxX: 10, minY: -6, maxY: 122 },

  route: route([
    [0, -1], [-0.6, 12], [-0.6, 15.5], [-2.5, 22], [-6.1, 24.2], [-7.4, 25.2], [-5, 29], [-2, 30.5], [-1, 36], [0, 41], [-1, 46], [0, 52],
    [4, 58], [4, 66], [2, 72], [4.5, 77], [3.6, 80], [0, 86], [3.25, 91.6], [3, 94], [1, 101], [-0.5, 106], [0, 110], [0, 116],
  ]),
};
