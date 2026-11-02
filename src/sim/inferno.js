// Level 6: "The Inferno". One long river, high in the air, spiralling in towards a round pool in
// the middle. It never stops: the water carries you on and slings you at the outside of every
// bend. On the way: spinning spike circles you have to time your way in and out of, holes that
// drag you in, and windmills right across the channel.

import { along, ribbon } from './track.js';

const HW = 7; // half the channel's width: spike circles fill it, so there's no way round them
const R0 = 58; // how far out it starts
const PITCH = 20; // how much closer in each full lap is

const points = [];
for (let deg = -90; deg <= 630; deg++) {
  // a steady spiral for 1.75 laps, then a last sweep into the middle
  const k = Math.max(0, (deg - 540) / 90);
  const r = R0 - (PITCH * Math.min(deg + 90, 630)) / 360 - 18 * k * k * (3 - 2 * k);
  const a = (deg * Math.PI) / 180;
  points.push([Math.cos(a) * r, Math.sin(a) * r]);
}
const river = ribbon(points, HW);

const spot = (s, lat = 0) => along(river, s, lat);
const hole = (s, lat, r) => ({ ...xy(s, lat), r });
const xy = (s, lat = 0) => {
  const { x, y } = spot(s, lat);
  return { x, y };
};
// a checkpoint, s metres along: the raft faces downstream, the flags go across the channel
const checkpoint = (s, lat = 0) => {
  const { x, y, angle } = spot(s, lat);
  const mid = spot(s);
  return { x, y, angle: angle - Math.PI / 2, zone: { x: mid.x, y: mid.y, w: 2 * HW, h: 2, angle: angle - Math.PI / 2 } };
};
const ring = (s, speed, gaps, gapDeg = 90) => ({ type: 'ring', ...xy(s), r: 6.5, speed, gaps, gapDeg });
const windmill = (s, speed, blades = 3) => ({ type: 'windmill', ...xy(s), radius: 7.5, blades, speed });

// the line the test autopilot takes: [metres along, metres left of the middle]. It passes each
// windmill on the side where the arms sweep the same way you're going.
const LANE = [
  [0, 0], [90, 0], [100, -2.5], [112, 2.5], [126, -2.5], [146, 0],
  [160, -4.8], [182, -4.8], [200, 0], [262, 0], [275, 3.5], [290, 3.5], [305, -2.5], [325, 0],
  [335, -4.8], [357, -4.8], [375, 0], [425, 0], [438, -3], [452, 0],
];
const laneAt = (s) => {
  const i = LANE.findIndex(([at]) => at > s);
  if (i === -1) return 0;
  const [s0, l0] = LANE[i - 1];
  const [s1, l1] = LANE[i];
  return l0 + ((l1 - l0) * (s - s0)) / (s1 - s0);
};
const routePoints = [];
for (let s = 0; s < river.length; s += 3) {
  const { x, y } = spot(s, laneAt(s));
  routePoints.push([x, y]);
}

const start = spot(0);

export const INFERNO = {
  id: 'inferno',
  number: 6,
  name: 'The Inferno',
  blurb: 'A long river spiralling into the middle, spinning spike circles, holes that pull you in and windmills.',
  par: 300,
  theme: { sky: '#ffd6a0', ground: '#d99a55', pines: ['#e8682b', '#f3a530', '#d9472b'], rocks: ['#b0694a', '#c27a55', '#99583f'], valleyRiver: '#39c0c8' },

  river: { along: 0.7, out: 0.45 }, // m/s^2: carries you on, and slings you at the outside of a bend
  wellPull: 1.6, // the river already drags you about; full-strength holes on top is impossible alone

  water: [
    { type: 'circle', x: start.x, y: start.y, r: 10 }, // start pool
    river,
    { type: 'circle', x: 0, y: 0, r: 13 }, // finish pool
  ],
  wells: [
    hole(100, 3.5, 2.6), hole(112, -3.5, 2.4), hole(126, 3.5, 2.6),
    hole(275, -3, 2.4), hole(290, -3, 2.4), hole(305, 3.5, 2.6),
    hole(438, 3.5, 2.6),
  ],
  walls: [],
  spikes: [],
  currents: [],

  checkpoints: [
    { x: start.x, y: start.y, angle: start.angle - Math.PI / 2, zone: null }, // facing downstream
    checkpoint(78), checkpoint(146), checkpoint(202), checkpoint(258), checkpoint(325), checkpoint(378), checkpoint(428),
  ],
  finish: { x: 0, y: 0, w: 24, h: 3 },

  movers: [
    ring(48, 0.22, [0, 180]), // openings opposite each other: in, straight across, out
    windmill(170, 0.45),
    ring(232, -0.25, [0, 130]), // openings side by side: you'll be waiting in the middle
    windmill(346, 0.45, 2), // two long arms: a bigger gap, on a tighter bend
    ring(402, 0.27, [0, 120, 240], 80), // three smaller openings, and quicker
  ],

  bounds: { minX: -72, maxX: 72, minY: -72, maxY: 72 },

  route: [...routePoints, [0, -2], [0, 0]],
};
