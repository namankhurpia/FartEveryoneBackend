// Level 5: "The Holey Road". A long raised track with no walls and plain holes in the middle of
// it. They pull you in as you get close, and if the raft's centre goes over one it's gone. The
// lanes between them get narrower, then the track turns east and a crosswind joins in.

import { route } from './route.js';

export const WELLS = {
  id: 'wells',
  number: 5,
  name: 'The Holey Road',
  blurb: 'Big holes in the track that drag you in if you get close. Then a crosswind joins in.',
  par: 120,

  water: [
    { x: 0, y: 0, w: 12, h: 12 },      // start pool
    { x: 0, y: 33, w: 12, h: 55 },     // the long track north
    { x: 0, y: 67, w: 16, h: 14 },     // the bend
    { x: 28, y: 67, w: 41, h: 10 },    // the track east
    { x: 54, y: 67, w: 14, h: 14 },    // finish pool
  ],
  wells: [
    { x: -3, y: 12, r: 2.4 },
    { x: 2.5, y: 20, r: 2.6 },
    { x: -2.5, y: 28, r: 2.6 },
    { x: -3.6, y: 36, r: 2 },
    { x: 3.6, y: 36, r: 2 },
    { x: 0, y: 45, r: 3 },
    { x: -4, y: 53, r: 1.8 },
    { x: 1, y: 53, r: 2.2 },
    { x: 16, y: 64.5, r: 2.4 },
    { x: 24, y: 69.5, r: 2.4 },
    { x: 32, y: 64.5, r: 2.4 },
    { x: 40, y: 69.5, r: 2.4 },
  ],
  walls: [],
  spikes: [],
  movers: [],
  currents: [{ x: 28, y: 67, w: 30, h: 10, ax: 0, ay: -1.2 }], // the crosswind on the track east

  checkpoints: [
    { x: 0, y: -1, angle: 0, zone: null },
    { x: 0, y: 40.5, angle: 0, zone: { x: 0, y: 40.5, w: 12, h: 1.5 } },
    { x: 0, y: 67, angle: -Math.PI / 2, zone: { x: 0, y: 67, w: 15, h: 13 } },
    { x: 28, y: 67, angle: -Math.PI / 2, zone: { x: 28, y: 67, w: 1.5, h: 10 } },
  ],
  finish: { x: 54, y: 67, w: 3, h: 13 },

  bounds: { minX: -8, maxX: 61, minY: -6, maxY: 74 },

  route: route([
    [0, -1], [2.5, 8], [3, 12], [-3, 20], [3, 28], [0, 36], [0, 40.5], [4.5, 41.5], [4.5, 54], [3, 61], [8, 67],
    [12, 68], [16, 69.5], [24, 64.5], [32, 69.5], [40, 64.5], [47, 67], [54, 67],
  ]),
};
