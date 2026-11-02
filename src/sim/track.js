// Water that isn't a rectangle. A level's `water` list can mix three shapes:
//   { x, y, w, h }                     a rectangle
//   { type: 'circle', x, y, r }        a round pool
//   { type: 'ribbon', path, hw, ... }  a curving channel: within hw metres of a line of points
// No DOM, no physics: used by the sim, the renderer and the checks alike.

// Evenly spaced points along a line, so distances along a ribbon are easy.
export function ribbon(points, hw, step = 2) {
  const path = [points[0]];
  let last = points[0];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    let [x0, y0] = last;
    let len = Math.hypot(x1 - x0, y1 - y0);
    while (carry + len >= step) {
      const k = (step - carry) / len;
      x0 += (x1 - x0) * k;
      y0 += (y1 - y0) * k;
      path.push([x0, y0]);
      len = Math.hypot(x1 - x0, y1 - y0);
      carry = 0;
    }
    carry += len;
    last = [x1, y1];
  }
  return { type: 'ribbon', path, hw, step, length: (path.length - 1) * step };
}

// The spot `s` metres along a ribbon and `lat` metres to the left of its middle, with the
// direction of travel there (angle).
export function along(rib, s, lat = 0) {
  const f = Math.max(0, Math.min(rib.path.length - 1.001, s / rib.step));
  const i = Math.floor(f);
  const [x0, y0] = rib.path[i];
  const [x1, y1] = rib.path[i + 1];
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const x = x0 + (x1 - x0) * (f - i) - Math.sin(angle) * lat;
  const y = y0 + (y1 - y0) * (f - i) + Math.cos(angle) * lat;
  return { x, y, angle };
}

// Closest point of a ribbon's middle line to (x, y): how far it is and which way the channel runs.
export function nearestOnRibbon(rib, x, y) {
  const { path } = rib;
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i];
    const sx = path[i + 1][0] - ax;
    const sy = path[i + 1][1] - ay;
    const k = Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / (sx * sx + sy * sy)));
    const dx = x - ax - sx * k;
    const dy = y - ay - sy * k;
    const d = dx * dx + dy * dy;
    if (d < best) [best, at] = [d, i];
  }
  const a = path[at];
  const b = path[at + 1];
  const tx = (b[0] - a[0]) / rib.step;
  const ty = (b[1] - a[1]) / rib.step;
  // which way the channel is bending here: +1 left, -1 right
  const c = path[Math.min(at + 4, path.length - 1)];
  const bend = Math.sign(tx * (c[1] - b[1]) - ty * (c[0] - b[0]));
  return { d: Math.sqrt(best), tx, ty, bend };
}

export function inWater(r, x, y, pad = 0) {
  if (r.type === 'circle') return Math.hypot(x - r.x, y - r.y) <= r.r + pad;
  if (r.type === 'ribbon') return nearestOnRibbon(r, x, y).d <= r.hw + pad;
  return Math.abs(x - r.x) <= r.w / 2 + pad && Math.abs(y - r.y) <= r.h / 2 + pad;
}

export function onWater(level, x, y, pad = 0) {
  return level.water.some((r) => inWater(r, x, y, pad));
}
