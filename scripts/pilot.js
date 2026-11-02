// Autopilot brain shared by the headless checks: follows the level's route (level.route),
// walks each player to the spot behind the raft (relative to where it wants to go) and farts
// with the ones pushing roughly the right way.
import { LEVELS } from '../src/sim/levels.js';
import { RAFT, WINDMILL_ARM } from '../src/sim/sim.js';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createPilot(level = LEVELS.canal, { speed = 4, line = false, cosMin = 0.6 } = {}) {
  const wps = level.route;
  let w = 0;
  // spiky sliders across the route: wait in the left lane until the bar swings right, then dash
  const gates = level.movers
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.spiky && m.from.y === m.to.y)
    .map(({ m, i }) => ({ i, y: m.from.y, cx: (m.from.x + m.to.x) / 2, lane: Math.min(m.from.x, m.to.x) - 0.5, right: Math.max(m.from.x, m.to.x), dash: false }));
  // windmills: wait outside their reach until the whole crossing looks clear of the arms
  const REACH = (m) => m.radius + WINDMILL_ARM / 2 + RAFT.radius + 0.3;
  const mills = level.movers
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.type === 'windmill')
    .map(({ m, i }) => {
      const inside = wps.map(([x, y]) => Math.hypot(x - m.x, y - m.y) < REACH(m));
      const first = inside.indexOf(true);
      return { m, i, first, last: inside.lastIndexOf(true), wait: Math.max(0, first - 1), go: false };
    });
  // would a raft following the route from here at this speed stay clear of every arm?
  function clearCrossing(s, mill, v) {
    const { m, i } = mill;
    const pts = [[s.raft.x, s.raft.y], ...wps.slice(mill.first, mill.last + 2)];
    const armAngle = s.movers[i].angle;
    let t = 0;
    let speedNow = Math.hypot(s.raft.vx, s.raft.vy);
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1];
      const [bx, by] = pts[k];
      const len = Math.hypot(bx - ax, by - ay) || 0.001;
      for (let d = 0; d <= len; d += 0.4) {
        speedNow = Math.min(v, speedNow + 3 * (0.4 / Math.max(speedNow, 0.5))); // starts from a standstill
        t += 0.4 / speedNow;
        const px = ax + ((bx - ax) * d) / len - m.x;
        const py = ay + ((by - ay) * d) / len - m.y;
        for (let n = 0; n < m.blades; n++) {
          const a = armAngle + m.speed * t + (n * 2 * Math.PI) / m.blades;
          const along = Math.max(0, Math.min(m.radius, px * Math.cos(a) + py * Math.sin(a)));
          if (Math.hypot(px - along * Math.cos(a), py - along * Math.sin(a)) < WINDMILL_ARM / 2 + RAFT.radius + 0.3) return false;
        }
      }
    }
    return true;
  }
  return function commands(s, events = []) {
    if (events.some((e) => e.type === 'respawned')) {
      // back at a checkpoint: carry on from the nearest waypoint ahead
      let best = 0;
      wps.forEach(([x, y], i) => {
        if (Math.hypot(x - s.raft.x, y - s.raft.y) < Math.hypot(wps[best][0] - s.raft.x, wps[best][1] - s.raft.y)) best = i;
      });
      w = Math.min(best + 1, wps.length - 1);
    }
    let [tx, ty] = wps[w];
    if (Math.hypot(tx - s.raft.x, ty - s.raft.y) < 2.5 && w < wps.length - 1) [tx, ty] = wps[++w];
    let gate = null; // 'wait' | 'dash' while handling a spiky bar
    for (const mill of mills) {
      if (w > mill.last + 1 || w < mill.wait - 1) {
        mill.go = false;
        continue;
      }
      const ready = s.crew.every((i) => !s.players[i].empty && s.players[i].gas > 0.5);
      if (!mill.go && ready && Math.hypot(wps[mill.wait][0] - s.raft.x, wps[mill.wait][1] - s.raft.y) < 3 && clearCrossing(s, mill, 3.5)) mill.go = true;
      if (mill.go) gate = 'dash';
      else {
        [tx, ty] = wps[mill.wait];
        w = Math.min(w, mill.wait);
        gate = 'wait';
      }
    }
    for (const g of gates) {
      // only when we're in the bar's own canal, just short of it
      if (s.raft.y < g.y - 8 || s.raft.y > g.y + 3.5 || Math.abs(s.raft.x - g.cx) > 7) {
        if (g.dash) {
          // made it past: carry on from the first waypoint beyond the bar, never back towards it
          const ahead = wps.findIndex(([, y]) => y > s.raft.y + 1);
          if (ahead > w) [tx, ty] = wps[(w = ahead)];
        }
        g.dash = false;
        continue;
      }
      const bar = s.movers[g.i];
      const movingRight = bar.x > (g.lastX ?? bar.x);
      g.lastX = bar.x;
      // go as soon as the bar is past the middle heading away from our lane (~3 s window)
      const ready = s.crew.every((i) => s.players[i].gas > 0.7 && !s.players[i].empty);
      if (!g.dash && ready && bar.x > -0.5 && movingRight && Math.abs(s.raft.x - g.lane) < 1.5 && s.raft.y > g.y - 5.5) g.dash = true;
      [tx, ty] = g.dash ? [g.lane, g.y + 5] : [g.lane, g.y - 4]; // wait just short of the bar
      gate = g.dash ? 'dash' : 'wait';
    }
    const dx = tx - s.raft.x, dy = ty - s.raft.y;
    const d = Math.hypot(dx, dy) || 1;
    // steer back onto the line between the previous and next waypoint (thin roads!)
    let cx = 0, cy = 0;
    if (line && w > 0 && !gate) {
      const [px, py] = wps[w - 1];
      const sx = tx - px, sy = ty - py;
      const len = Math.hypot(sx, sy) || 1;
      const off = ((s.raft.x - px) * -sy + (s.raft.y - py) * sx) / len; // signed distance from the line
      cx = (sy / len) * off * 1.5;
      cy = (-sx / len) * off * 1.5;
    }
    // dash flat out; while waiting, slow down near the wait spot (and let the tanks refill)
    const v = gate === 'dash' ? Math.max(speed, 5) : gate === 'wait' ? Math.min(speed, Math.max(0.9, d * 0.8)) : speed;
    const ex = (dx / d) * v + cx - s.raft.vx, ey = (dy / d) * v + cy - s.raft.vy;
    const want = Math.atan2(ey, ex) - s.raft.angle; // desired push, raft-local
    const go = Math.hypot(ex, ey) > 1;
    // at a spiky bar, do what a person would: park by the wall with the tanks refilling, then
    // when the bar swings away, everyone who can pushes straight ahead
    if (gate === 'wait' && d < 2.5) {
      return s.players.map((p) => ({ aim: 0, fart: false, move: Math.sign(wrap(-Math.PI / 2 - p.pos)) })); // walk to the back
    }
    if (gate === 'dash' && !mills.some((m) => m.go)) {
      const lateral = (tx - s.raft.x) * 1.2 - s.raft.vx;
      const fwd = Math.atan2(5, lateral) - s.raft.angle;
      return s.players.map((p) => ({ aim: 0, move: 0, fart: Math.cos(wrap(fwd - (p.pos + Math.PI))) > 0.3 && !p.empty }));
    }

    // like a person would: keep some gas in reserve unless we're badly off course
    const urgent = Math.hypot(ex, ey) > 3 || gate === 'dash';
    return s.players.map((p) => {
      const err = wrap(want - (p.pos + Math.PI)); // facing the centre pushes along pos + PI
      const gasOk = p.farting ? p.gas > 0.05 : p.gas > 0.35 || urgent;
      return { aim: 0, move: Math.abs(err) > 0.05 ? Math.sign(err) : 0, fart: go && gasOk && Math.cos(err) > cosMin };
    });
  };
}
