// Drives a level headlessly with the shared pilot, trying a few driving styles: a level counts
// as beatable for a crew size if any style finishes it. Also checks the sensors fire.
// Usage: node scripts/autopilot.js [crew size 1-4] [level id] [-q]   (default: 4 canal)
import RAPIER from '@dimforge/rapier2d-compat';
import { createSim } from '../src/sim/sim.js';
import { LEVELS } from '../src/sim/levels.js';
import { createPilot } from './pilot.js';
import { route } from '../src/sim/route.js';

export const STYLES = [
  { name: 'aim-at-waypoint', speed: 4, line: false, cosMin: 0.6 },
  { name: 'follow-the-line', speed: 3.5, line: true, cosMin: 0.45 },
  { name: 'careful', speed: 2.5, line: true, cosMin: 0.3 },
];

export function drive(RAPIER, level, crewSize, style, { log = () => {}, maxSeconds = 1200 } = {}) {
  const sim = createSim(RAPIER, level, { crew: [0, 1, 2, 3].slice(0, crewSize) });
  const pilot = createPilot(level, style);
  let events = [];
  // progress = how far along the route we've got; no progress for 40 s means we're pinned or
  // being batted about, so do what a player would: press R (back to the last checkpoint)
  const path = route(level.route, 1); // a point every metre, so progress shows up on long stretches too
  const along = (s) => {
    let best = 0;
    path.forEach(([x, y], i) => {
      if (Math.hypot(x - s.raft.x, y - s.raft.y) < Math.hypot(path[best][0] - s.raft.x, path[best][1] - s.raft.y)) best = i;
    });
    return best;
  };
  let bestAlong = 0;
  let bestAt = 0;
  for (let t = 0; t < 60 * maxSeconds; t++) {
    const s = sim.snapshot();
    if (s.phase === 'finished') break;
    const a = along(s);
    if (a > bestAlong) [bestAlong, bestAt] = [a, t];
    else if (t - bestAt > 40 * 60 && s.phase === 'playing') {
      sim.respawn();
      [bestAlong, bestAt] = [-1, t]; // measure progress afresh from the checkpoint
    }
    events = sim.step(pilot(s, events));
    for (const e of events) if (!e.type.startsWith('fart') && e.type !== 'empty') log(`${(t / 60).toFixed(1)}s ${e.type}${e.index ?? ''} @ (${s.raft.x.toFixed(1)}, ${s.raft.y.toFixed(1)})`);
  }
  const s = sim.snapshot();
  sim.free();
  return { finished: s.phase === 'finished', seconds: s.timeTicks / 60, deaths: s.deaths, x: s.raft.x, y: s.raft.y };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await RAPIER.init();
  const crewSize = Number(process.argv[2]) || 4;
  const level = LEVELS[process.argv[3] || 'canal'];
  const quiet = process.argv.includes('-q');
  let ok = false;
  for (const style of STYLES) {
    const r = drive(RAPIER, level, crewSize, style, { log: quiet ? () => {} : console.log });
    console.log(`${level.id} crew ${crewSize} [${style.name}]: ${r.finished ? 'finished' : 'did not finish'} in ${r.seconds.toFixed(1)} s, ${r.deaths} deaths${r.finished ? '' : ` (stuck near ${r.x.toFixed(1)}, ${r.y.toFixed(1)})`}`);
    if (r.finished) {
      ok = true;
      break;
    }
  }
  process.exit(ok ? 0 : 1);
}
