// The journey map: a river winding between one stop per level. Cleared stops get a tick and
// your best time, locked ones a padlock, and a little raft sits on the level you're on.
// Used in the room lobby (the host picks by tapping a stop) and on the Levels page.
//
// renderJourney(el, {
//   levels:   [{ id, number, name }]           in play order
//   unlocked: [id]                              levels you may play
//   cleared:  { id: { best_ms } }               levels finished, with best times (optional)
//   current:  id                                where the raft sits
//   pickable: true/false                        can stops be tapped?
//   onPick:   (id) => {}
//   dir:      'down' | 'across'                 'across' fits short spaces (phones)
// })

const NS = 'http://www.w3.org/2000/svg';

export function renderJourney(el, { levels, unlocked, cleared = {}, current, pickable = false, onPick = () => {}, dir = 'down', fmt = (ms) => '' }) {
  el.textContent = '';
  el.className = `journey journey-${dir}`;
  const stops = [...levels, { id: null, number: '…', name: 'More soon' }];
  const across = dir === 'across';
  const step = across ? 78 : 86;
  const W = across ? 40 + step * (stops.length - 1) + 40 : 260;
  const H = across ? 132 : 44 + step * (stops.length - 1) + 44;
  // stops zig-zag either side of the centre line so the river winds between them
  const pos = stops.map((_, i) =>
    across ? { x: 40 + i * step, y: i % 2 ? 84 : 44 } : { x: i % 2 ? 190 : 70, y: 44 + i * step },
  );
  el.style.width = `${W}px`;
  el.style.height = `${H}px`;

  // the river: a smooth curve through every stop, wide blue with a dashed white line
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  let d = `M ${pos[0].x} ${pos[0].y}`;
  for (let i = 1; i < pos.length; i++) {
    const a = pos[i - 1];
    const b = pos[i];
    d += across
      ? ` C ${a.x + step / 2} ${a.y}, ${b.x - step / 2} ${b.y}, ${b.x} ${b.y}`
      : ` C ${a.x} ${a.y + step / 2}, ${b.x} ${b.y - step / 2}, ${b.x} ${b.y}`;
  }
  for (const [cls] of [['river'], ['river-flow']]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    svg.append(p);
  }
  el.append(svg);

  stops.forEach((lvl, i) => {
    const { x, y } = pos[i];
    const soon = lvl.id === null;
    const open = !soon && unlocked.includes(lvl.id);
    const done = !soon && !!cleared[lvl.id];
    const here = lvl.id === current;
    const stop = document.createElement(pickable && open ? 'button' : 'div');
    stop.className = ['stop', done && 'done', open ? 'open' : 'locked', here && 'here', soon && 'soon', i % 2 ? 'right' : 'left'].filter(Boolean).join(' ');
    stop.style.left = `${x}px`;
    stop.style.top = `${y}px`;
    if (pickable && open) stop.onclick = () => onPick(lvl.id);
    stop.setAttribute('aria-label', soon ? 'More levels coming soon' : `Level ${lvl.number}: ${lvl.name}${done ? ', cleared' : open ? '' : ', locked'}${here ? ', selected' : ''}`);

    const disc = document.createElement('span');
    disc.className = 'disc';
    disc.textContent = soon ? '?' : open ? String(lvl.number) : '🔒';
    stop.append(disc);
    if (done) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = '✓';
      stop.append(tick);
    }
    if (here) {
      const raft = document.createElement('span');
      raft.className = 'raft-marker';
      raft.setAttribute('aria-hidden', 'true');
      stop.append(raft);
    }
    const label = document.createElement('span');
    label.className = 'label';
    const name = document.createElement('b');
    name.textContent = lvl.name;
    const sub = document.createElement('small');
    sub.textContent = soon ? '' : done ? `best ${fmt(cleared[lvl.id].best_ms)}` : open ? (here ? 'selected' : 'tap to pick') : `finish level ${levels[i - 1].number}`;
    label.append(name, sub);
    stop.append(label);
    el.append(stop);
  });
}
