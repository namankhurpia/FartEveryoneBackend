// Headless sanity check of the sim with everyone facing the centre by default.
import RAPIER from '@dimforge/rapier2d-compat';
import { WALK_SPEED, arcFor, createSim, DT, FACE_CENTER, NUM_PLAYERS, walkToward } from '../src/sim/sim.js';
import { LEVELS } from '../src/sim/levels.js';

await RAPIER.init();

function run(farting, ticks, aim = FACE_CENTER) {
  const sim = createSim(RAPIER);
  for (let t = 0; t < ticks; t++) {
    sim.step(Array.from({ length: NUM_PLAYERS }, (_, i) => ({ aim, fart: farting.includes(i) })));
  }
  return sim.snapshot();
}

const fmt = (s) => `pos=(${s.raft.x.toFixed(2)}, ${s.raft.y.toFixed(2)}) angle=${s.raft.angle.toFixed(2)} speed=${Math.hypot(s.raft.vx, s.raft.vy).toFixed(2)}`;

const back = run([2, 3], 60);
const solo = run([2], 60);
const all = run([0, 1, 2, 3], 60);
const turned = run([2], 60, 0.8);
console.log('back pair (P3+P4), 1 s:', fmt(back));
console.log('P3 alone, 1 s         :', fmt(solo));
console.log('all four, 1 s         :', fmt(all));
console.log('P3 turned away, 1 s   :', fmt(turned));

let ok = true;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); ok &&= cond; };
check(Math.abs(back.raft.angle) < 0.01 && back.raft.y > -1 && Math.abs(back.raft.x) < 0.01, 'back pair pushes straight forward');
check(Math.abs(solo.raft.angle) < 0.01 && solo.raft.x > 0.3 && solo.raft.y > -1.7, 'one player facing the centre pushes diagonally with no spin');
check(Math.hypot(all.raft.x, all.raft.y + 2) < 0.05, 'all four from their default spots cancel out');
check(Math.abs(turned.raft.angle) > 0.1, 'turning away from the centre spins the raft');
// rim slices by crew size
const deg = (r) => Math.round((r * 180) / Math.PI);
const span = (a) => deg(a.hi - a.lo);
check(arcFor(0, [0]).full && span(arcFor(0, [0])) === 360, '1 player gets the whole rim');
check([0, 2].every((i) => span(arcFor(i, [0, 2])) === 180) && arcFor(1, [0, 2]) === null, '2 players get 180 each; empty seats get none');
check([0, 1, 3].every((i) => span(arcFor(i, [0, 1, 3])) === 120), '3 players get 120 each');
check([0, 1, 2, 3].every((i) => span(arcFor(i)) === 90), '4 players keep their quarters');

// a solo player can walk all the way round (wraps), others stop at their slice edge
function walk(crew, seat, ticks) {
  const sim = createSim(RAPIER, undefined, { crew });
  for (let t = 0; t < ticks; t++) sim.step(Array.from({ length: NUM_PLAYERS }, (_, i) => ({ aim: 0, fart: false, move: i === seat ? 1 : 0 })));
  return sim.snapshot();
}
const lap = walk([0], 0, 60 * 4); // 4 s at 1.8 rad/s = more than a full lap
check(Math.abs(lap.players[0].pos) <= Math.PI + 1e-9, 'solo player walks past 360 and wraps around');
const duo = walk([0, 1], 0, 60 * 4);
check(deg(duo.players[0].pos) === deg(arcFor(0, [0, 1]).max), 'in a duo you stop at the edge of your half');

// seats outside the crew can't push
const ghost = createSim(RAPIER, undefined, { crew: [0] });
for (let t = 0; t < 60; t++) ghost.step([{ fart: false }, { aim: 0, fart: true }, { aim: 0, fart: true }, { aim: 0, fart: true }]);
const g = ghost.snapshot();
check(Math.hypot(g.raft.vx, g.raft.vy) < 1e-6 && !g.players[1].farting, 'players who are not in the crew cannot push');
// falling off the edge on levels with a drop
function settle(levelId, x, y) {
  const sim = createSim(RAPIER, LEVELS[levelId]);
  sim.go();
  sim.debugPlace(x, y, 0);
  const ev = [];
  for (let t = 0; t < 5; t++) ev.push(...sim.step([]));
  return { s: sim.snapshot(), ev };
}
const onRoad = settle('plank', 0, 25);
check(onRoad.s.phase === 'playing' && !onRoad.ev.some((e) => e.type === 'fell'), 'raft in the middle of a thin road stays put');
const offRoad = settle('plank', 4, 25);
check(offRoad.s.phase === 'respawning' && offRoad.s.cause === 'fell' && offRoad.ev.some((e) => e.type === 'fell'), 'raft whose centre leaves the water falls and respawns');
const canal = settle('canal', 0, 25);
check(canal.s.phase === 'playing', 'levels without a drop never make you fall');
for (const id of ['plank', 'rapids']) {
  const L = LEVELS[id];
  const inside = (p) => L.water.some((r) => Math.abs(p.x - r.x) <= r.w / 2 && Math.abs(p.y - r.y) <= r.h / 2);
  check(L.checkpoints.every(inside) && inside(L.finish), `${id}: every checkpoint and the finish sit on safe water`);
}
// left / right walk left / right on screen at every raft angle, for every crew size and seat
{
  let wrongWay = 0, stoppedEarly = 0, cases = 0;
  const crews = [[0, 1], [0, 1, 2], [0, 1, 2, 3]]; // slices; a lone player's full circle is tested below
  for (const crew of crews) for (const seat of crew) for (let deg = 0; deg < 360; deg += 15) for (const h of [-1, 1]) for (const f of [0.1, 0.5, 0.9]) {
    const arc = arcFor(seat, crew);
    const angle = (deg * Math.PI) / 180;
    let pos = arc.min + f * (arc.max - arc.min);
    const screenX = (p) => h * Math.cos(p + angle); // bigger = further towards the side we asked for
    let last = screenX(pos);
    for (let t = 0; t < 60 * 6; t++) {
      pos += walkToward(h, pos, angle, arc) * WALK_SPEED * DT;
      pos = Math.max(arc.min, Math.min(arc.max, pos));
      if (screenX(pos) < last - 1e-6) wrongWay++; // not one tick the other way
      last = screenX(pos);
    }
    cases++;
    // ended at the far side of the screen, or at the end of the slice on the way there
    const atEnd = pos <= arc.min + 1e-6 || pos >= arc.max - 1e-6;
    if (!atEnd && last < 0.99) stoppedEarly++;
  }
  check(wrongWay === 0, `left/right never walk the wrong way on screen, not for one tick (${cases} raft angle + seat cases)`);
  check(stoppedEarly === 0, 'left/right carry on until you reach that side of the raft or the end of your slice');
}
{
  // a lone player goes round in full circles through the real sim, and the raft turning
  // never changes which way each key goes
  const lap = 2 * Math.PI;
  const laps = (key, turn) => {
    const sim = createSim(RAPIER, LEVELS.pond, { crew: [0] });
    const arc = arcFor(0, [0]);
    const mem = { side: 0, to: null };
    let total = 0, wrong = 0;
    for (let t = 0; t < 60 * 15; t++) {
      if (turn) sim.debugPlace(0, 0, t * DT * 0.8); // the raft keeps turning under you
      const { players, raft } = sim.snapshot();
      const move = walkToward(key, players[0].pos, raft.angle, arc, mem);
      sim.step([{ aim: 0, fart: false, move }]);
      const after = sim.snapshot().players[0].pos;
      const step = Math.atan2(Math.sin(after - players[0].pos), Math.cos(after - players[0].pos));
      if (Math.sign(step) !== Math.sign(key)) wrong++;
      total += step;
    }
    sim.free();
    return { laps: Math.abs(total) / lap, wrong };
  };
  const results = [laps(-1, false), laps(1, false), laps(-1, true), laps(1, true)];
  check(results.every((r) => r.laps > 4), `lone player holding a key goes round in circles (${results[0].laps.toFixed(1)} laps in 15 s)`);
  check(results.every((r) => r.wrong === 0), 'each key keeps its direction for the whole time, even with the raft turning');
  const back = arcFor(0, [0]).start;
  check(-Math.sin(back) * walkToward(-1, back, 0, arcFor(0, [0])) < 0, 'from the starting spot at the back, left walks left on screen');
}
{
  // parked at the end of your slice, the raft spins: the key must not go dead if the other end
  // of the slice is further that way
  const arc = arcFor(2); // quarter: 197-253 degrees
  const angle = (149 * Math.PI) / 180;
  const mem = { side: 0, to: null };
  let pos = arc.min;
  const start = Math.cos(pos + angle);
  for (let t = 0; t < 120; t++) pos = Math.max(arc.min, Math.min(arc.max, pos + walkToward(-1, pos, angle, arc, mem) * WALK_SPEED * DT));
  check(Math.cos(pos + angle) < start - 0.1, 'left/right never go dead at the end of your slice when the other end is further that way');
}

// level 3's first barrier is spiky: touching it is a splat
{
  const sim = createSim(RAPIER, LEVELS.rapids);
  sim.go();
  const ev = [];
  for (let t = 0; t < 120 && sim.snapshot().phase === 'playing'; t++) {
    const bar = sim.snapshot().movers[0];
    sim.debugPlace(bar.x, bar.y - 1.9, 0); // just under the bar, overlapping its spikes
    ev.push(...sim.step([]));
  }
  check(ev.some((e) => e.type === 'ouch') && sim.snapshot().phase === 'respawning', 'touching the spiky barrier on level 3 is a splat');
}
process.exit(ok ? 0 : 1);
