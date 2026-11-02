// Pure game simulation: no DOM, no three.js. Runs in the browser now and can run
// unchanged on a Node server later (authoritative multiplayer).
//
// Input per tick: an array of NUM_PLAYERS commands { aim, fart, move }.
//   aim  = how far the player has turned away from facing the centre, radians. 0 (default) =
//          facing the centre, bum over the water, so the fart pushes the raft straight through
//          its middle (no spin). Turning away adds spin.
//   fart = true while the player is holding their fart button
//   move = -1..1, walk clockwise / counter-clockwise along your slice of the rim
// The crew (which seats are playing, 1-4 of them) splits the rim evenly; see arcFor().
// step() returns the events that happened this tick (for sound / HUD).

import { LEVELS } from './levels.js';
import { inWater, nearestOnRibbon, onWater } from './track.js';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const NUM_PLAYERS = 4;
export const FACE_CENTER = 0;

export const RAFT = {
  radius: 1.7,            // round deck, 3.4 m across
  rim: 1.3,               // where the crew stand, from the centre
  density: 0.75,          // ~6.8 kg, same as the square prototype
  linearDamping: 0.85,    // fake water drag
  angularDamping: 1.6,
};

// The rim is split evenly between whoever is playing, in raft-local angles (0 = raft right,
// 90 = raft front). Players walk freely inside their slice. Where you stand is your lever: at
// the side your fart spins the raft, at the front or back it drives straight.
//   1 player:  the whole rim, starting at the back
//   2 players: right half (-90..90) and left half (90..270)
//   3 players: 120 degrees each: front-right, front-left, back
//   4 players: quarters: front-right, front-left, back-left, back-right
export const WALK_SPEED = 1.8;   // rad/s along the rim
export const ALL_SEATS = [0, 1, 2, 3];
const ARC_MARGIN = 0.3;          // keeps neighbours from standing inside each other at the borders
const ARC_BASE = { 1: -Math.PI / 2, 2: -Math.PI / 2, 3: -Math.PI / 6, 4: 0 };
// Fart power per player by crew size. A full crew usually has ~2 people able to push in any
// direction; with bigger slices it's often just one, so smaller crews push harder each.
export const CREW_THRUST = { 1: 1.4, 2: 1.35, 3: 1.4, 4: 1 };
// How fast the tank drains while holding, by crew size. A full crew takes turns; a lone
// farter has to keep pushing through a raging corner alone, so their tank lasts longer.
export const CREW_GAS_DRAIN = { 1: 0.5, 2: 0.7, 3: 0.85, 4: 1 };

// seat's slice of the rim for this crew (seats in play, ascending), or null if not playing
export function arcFor(seat, crew = ALL_SEATS) {
  const n = crew.length;
  const k = crew.indexOf(seat);
  if (k === -1) return null;
  const span = (2 * Math.PI) / n;
  const lo = ARC_BASE[n] + k * span;
  if (n === 1) return { lo, hi: lo + span, full: true, start: -Math.PI / 2 };
  return { lo, hi: lo + span, full: false, min: lo + ARC_MARGIN, max: lo + span - ARC_MARGIN, start: lo + span / 2 };
}

export function cleanCrew(crew) {
  const c = [...new Set((crew || ALL_SEATS).filter((i) => Number.isInteger(i) && i >= 0 && i < NUM_PLAYERS))].sort();
  return c.length ? c : [0];
}

// Left / right mean left / right on screen, whatever angle the raft is at: this steps round
// the rim in whichever direction moves you towards that side of the screen right now, and stops
// when you're as far that way as you can go (or at the end of your slice). h: -1 (left) .. 1
// (right). The camera never rotates, so world +x is always screen right.
// A lone player owns the whole rim, so there is no "side" to stop at: left always walks
// clockwise and right counter-clockwise, whatever the raft does, and holding one goes round in
// circles. They start at the back of the raft, where clockwise is left on screen.
// `mem` (optional, one object per player, kept while the key is held) covers the awkward case:
// parked at one end of your slice with the other end further that way. Otherwise the key would
// do nothing there, so it commits to walking across for the rest of the press.
export function walkToward(h, pos, raftAngle, arc, mem) {
  if (mem && Math.sign(h) !== mem.side) {
    mem.side = Math.sign(h);
    mem.to = null;
  }
  if (!h || !arc) return 0;
  if (arc.full) return Math.max(-1, Math.min(1, h));
  const ease = (d) => Math.max(-1, Math.min(1, d / 0.3)) * Math.min(1, Math.abs(h)); // no jitter on a laggy line
  if (mem && mem.to !== null) {
    if (Math.abs(mem.to - pos) > 0.03) return ease(mem.to - pos);
    mem.to = null;
  }
  const goal = (h < 0 ? Math.PI : 0) - raftAngle; // that side of the screen, in raft-local angle
  const diff = Math.atan2(Math.sin(goal - pos), Math.cos(goal - pos));
  if (Math.abs(diff) < 0.03) return 0;
  if (!arc.full && ((diff > 0 && pos >= arc.max) || (diff < 0 && pos <= arc.min))) {
    const other = diff > 0 ? arc.min : arc.max;
    const side = (p) => Math.sign(h) * Math.cos(p + raftAngle); // bigger = further that way
    if (mem && side(other) > side(pos) + 0.05) {
      mem.to = other;
      return ease(other - pos);
    }
    return 0;
  }
  return ease(diff);
}

// rim angle -> raft-local position
export function seatAt(pos) {
  return { x: RAFT.rim * Math.cos(pos), y: RAFT.rim * Math.sin(pos) };
}

export const GAS = {
  thrust: 22,              // N while holding (facing the centre, only ~2 players can push any one way)
  burstThrust: 75,         // N for the first few ticks of each fart ("toot!")
  burstTicks: 7,
  burstCost: 0.07,         // gas spent on every new fart, so spamming taps costs more
  drainPerSec: 0.42,       // a full tank lasts ~2.2 s of holding
  rechargePerSec: 0.34,
  rechargeDelayTicks: 30,  // must stop farting for 0.5 s before recharging starts
  refillThreshold: 0.2,    // after running dry you are locked out until the tank reaches this
};

export const RESPAWN_TICKS = 50;
const RIVER_CALM_TICKS = 90;

export function createSim(RAPIER, level = LEVELS.canal, { crew = ALL_SEATS } = {}) {
  const world = new RAPIER.World({ x: 0, y: 0 });
  world.timestep = DT;

  const kinds = new Map(); // collider handle -> { kind, index }

  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const w of level.walls) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(w.w / 2, w.h / 2).setTranslation(w.x, w.y).setRestitution(0.35).setFriction(0.35),
      fixed,
    );
  }
  const addSensor = (r, kind, index) => {
    const c = world.createCollider(
      RAPIER.ColliderDesc.cuboid(r.w / 2, r.h / 2).setTranslation(r.x, r.y).setRotation(r.angle || 0).setSensor(true),
      fixed,
    );
    kinds.set(c.handle, { kind, index });
  };
  level.spikes.forEach((r, i) => addSensor(r, 'spike', i));
  level.checkpoints.forEach((cp, i) => cp.zone && addSensor(cp.zone, 'checkpoint', i));
  if (level.finish) addSensor(level.finish, 'finish', 0); // the lobby pond has no finish

  const movers = level.movers.map((def) => {
    const pose = moverPose(def, 0);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pose.x, pose.y).setRotation(pose.angle),
    );
    // everything on this body that hurts: a sensor at (x, y) rotated by `angle`, half-sizes hx, hy
    const spikes = (hx, hy, x, y, angle) => {
      const c = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy).setTranslation(x, y).setRotation(angle).setSensor(true), body);
      kinds.set(c.handle, { kind: 'spike', index: -1 });
    };
    if (def.type === 'windmill') {
      // a solid tower in the middle, and arms you can't touch sweeping round it
      world.createCollider(RAPIER.ColliderDesc.ball(WINDMILL_TOWER).setRestitution(0.5).setFriction(0.35), body);
      for (let k = 0; k < def.blades; k++) {
        const a = (k * 2 * Math.PI) / def.blades;
        spikes(def.radius / 2, WINDMILL_ARM / 2, (Math.cos(a) * def.radius) / 2, (Math.sin(a) * def.radius) / 2, a);
      }
      return { def, body };
    }
    if (def.type === 'ring') {
      // a circle of spikes, solid all the way round except for its openings
      for (const seg of ringSegments(def)) spikes(seg.len / 2, RING_THICK / 2, Math.cos(seg.a) * def.r, Math.sin(seg.a) * def.r, seg.a + Math.PI / 2);
      return { def, body };
    }
    world.createCollider(RAPIER.ColliderDesc.cuboid(def.w / 2, def.h / 2).setRestitution(0.5).setFriction(0.35), body);
    // a spiky mover: touching it is a splat, like the spike strips
    if (def.spiky) {
      const sensor = world.createCollider(RAPIER.ColliderDesc.cuboid(def.w / 2 + 0.2, def.h / 2 + 0.2).setSensor(true), body);
      kinds.set(sensor.handle, { kind: 'spike', index: -1 });
    }
    return { def, body };
  });

  const start = level.checkpoints[0];
  const raft = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(start.x, start.y)
      .setRotation(start.angle)
      .setLinearDamping(RAFT.linearDamping)
      .setAngularDamping(RAFT.angularDamping)
      .setCanSleep(false)
      .setCcdEnabled(true),
  );
  const raftCollider = world.createCollider(
    RAPIER.ColliderDesc.ball(RAFT.radius).setDensity(RAFT.density).setFriction(0.35).setRestitution(0.3),
    raft,
  );

  const state = {
    tick: 0,
    phase: 'ready',        // ready (waiting for the first fart) | playing | respawning | finished
    timeTicks: 0,          // race clock, starts on the first fart
    checkpoint: 0,
    respawnTimer: 0,
    cause: null,
    deaths: 0,
    crew: cleanCrew(crew),
    players: [],
    calm: 0,               // ticks the river leaves you alone after a respawn, to get your bearings
  };
  const riverWater = level.river && level.water.find((r) => r.type === 'ribbon');
  state.players = Array.from({ length: NUM_PLAYERS }, (_, i) => newPlayer(i));

  function newPlayer(i) {
    const arc = arcFor(i, state.crew);
    return { pos: arc ? arc.start : 0, aim: FACE_CENTER, farting: false, gas: 1, burst: 0, idleTicks: 0, empty: false };
  }

  // Change who is playing (lobby: people join and leave). Everyone gets their new slice's start spot.
  function setCrew(next) {
    const c = cleanCrew(next);
    if (c.join() === state.crew.join()) return [];
    const events = [];
    state.players.forEach((p, i) => p.farting && events.push({ type: 'fartEnd', player: i }));
    state.crew = c;
    state.players = Array.from({ length: NUM_PLAYERS }, (_, i) => newPlayer(i));
    return events;
  }

  function placeAtCheckpoint() {
    const cp = level.checkpoints[state.checkpoint];
    raft.setTranslation({ x: cp.x, y: cp.y }, true);
    raft.setRotation(cp.angle, true);
    raft.setLinvel({ x: 0, y: 0 }, true);
    raft.setAngvel(0, true);
    for (const p of state.players) Object.assign(p, { farting: false, gas: 1, burst: 0, idleTicks: 0, empty: false });
    state.calm = RIVER_CALM_TICKS;
  }

  function step(cmds) {
    const events = [];
    state.tick++;

    if (state.phase === 'respawning' && --state.respawnTimer <= 0) {
      placeAtCheckpoint();
      state.phase = state.timeTicks > 0 ? 'playing' : 'ready';
      events.push({ type: 'respawned' });
    }

    const canAct = state.phase === 'ready' || state.phase === 'playing';
    const pos = raft.translation();
    const angle = raft.rotation();
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const boost = CREW_THRUST[state.crew.length];
    const drain = GAS.drainPerSec * CREW_GAS_DRAIN[state.crew.length];
    state.players.forEach((p, i) => {
      const arc = arcFor(i, state.crew);
      if (!arc) return; // not playing this round
      const cmd = cmds[i] || { aim: p.aim, fart: false };
      if (Number.isFinite(cmd.aim)) p.aim = cmd.aim;
      if (cmd.move) {
        const move = Math.max(-1, Math.min(1, cmd.move));
        const next = p.pos + move * WALK_SPEED * DT;
        p.pos = arc.full ? Math.atan2(Math.sin(next), Math.cos(next)) : Math.max(arc.min, Math.min(arc.max, next));
      }

      const active = canAct && cmd.fart && !p.empty && p.gas > 0;
      if (active && !p.farting) {
        p.burst = GAS.burstTicks;
        p.gas = Math.max(0, p.gas - GAS.burstCost);
        events.push({ type: 'fartStart', player: i });
        if (state.phase === 'ready') {
          state.phase = 'playing';
          events.push({ type: 'go' });
        }
      } else if (!active && p.farting) {
        events.push({ type: 'fartEnd', player: i });
      }
      p.farting = active;

      if (active) {
        const force = (p.burst > 0 ? GAS.burstThrust : GAS.thrust) * boost;
        if (p.burst > 0) p.burst--;
        p.idleTicks = 0;
        p.gas -= drain * DT;
        if (p.gas <= 0) {
          p.gas = 0;
          p.empty = true;
          p.farting = false;
          events.push({ type: 'fartEnd', player: i }, { type: 'empty', player: i });
        }
        // thrust direction: local -> world
        // facing the centre pushes along pos + PI (from the rim toward the middle)
        const dir = p.pos + Math.PI + p.aim;
        const lx = Math.cos(dir);
        const ly = Math.sin(dir);
        const dx = lx * cos - ly * sin;
        const dy = lx * sin + ly * cos;
        // seat position: local -> world. Off-centre pushes create torque, which is the whole game.
        const s = seatAt(p.pos);
        const px = pos.x + s.x * cos - s.y * sin;
        const py = pos.y + s.x * sin + s.y * cos;
        raft.applyImpulseAtPoint({ x: dx * force * DT, y: dy * force * DT }, { x: px, y: py }, true);
      } else {
        p.burst = 0;
        p.idleTicks++;
        if (p.idleTicks > GAS.rechargeDelayTicks) p.gas = Math.min(1, p.gas + GAS.rechargePerSec * DT);
        if (p.empty && p.gas >= GAS.refillThreshold) p.empty = false;
      }
    });

    const mass = raft.mass();
    for (const c of level.currents) {
      if (inRect(pos, c)) raft.applyImpulse({ x: c.ax * mass * DT, y: c.ay * mass * DT }, true);
    }
    // wells suck: the closer you get, the harder they drag the raft in
    for (const w of level.wells || []) {
      const dx = w.x - pos.x;
      const dy = w.y - pos.y;
      const d = Math.hypot(dx, dy);
      const edge = d - w.r; // how far from the lip of the well
      if (d > 0 && edge < WELL_PULL_RANGE) {
        const a = ((level.wellPull ?? WELL_PULL) * (1 - Math.max(0, edge) / WELL_PULL_RANGE) * mass * DT) / d;
        raft.applyImpulse({ x: dx * a, y: dy * a }, true);
      }
    }
    // a river: carries you along the channel and slings you at the outside of every bend (the
    // pools at each end are still, and so is the moment before you've set off or just respawned)
    if (state.calm > 0) state.calm--;
    if (riverWater && state.phase === 'playing' && !state.calm) {
      const n = nearestOnRibbon(riverWater, pos.x, pos.y);
      const inPool = level.water.some((r) => r.type === 'circle' && inWater(r, pos.x, pos.y));
      if (n.d <= riverWater.hw && !inPool) {
        const ax = n.tx * level.river.along + n.ty * n.bend * level.river.out;
        const ay = n.ty * level.river.along - n.tx * n.bend * level.river.out;
        raft.applyImpulse({ x: ax * mass * DT, y: ay * mass * DT }, true);
      }
    }

    const t = state.tick * DT;
    for (const m of movers) {
      const pose = moverPose(m.def, t);
      m.body.setNextKinematicTranslation({ x: pose.x, y: pose.y });
      m.body.setNextKinematicRotation(pose.angle);
    }

    world.step();

    if (state.phase === 'playing') state.timeTicks++;

    // Levels with a drop list their safe water; if the raft's centre leaves all of it, it falls.
    if (level.water && (state.phase === 'playing' || state.phase === 'ready')) {
      const at = raft.translation();
      if (!onWater(level, at.x, at.y)) startRespawn('fell', events);
    }
    // wells: holes in the track. Let the raft's centre over one and it's gone
    if (level.wells && (state.phase === 'playing' || state.phase === 'ready')) {
      const at = raft.translation();
      if (level.wells.some((w) => Math.hypot(at.x - w.x, at.y - w.y) < w.r)) startRespawn('fell', events);
    }

    world.intersectionPairsWith(raftCollider, (other) => {
      const k = kinds.get(other.handle);
      if (!k) return;
      if (k.kind === 'spike' && (state.phase === 'playing' || state.phase === 'ready')) {
        startRespawn('spike', events);
      } else if (k.kind === 'checkpoint' && k.index > state.checkpoint && state.phase === 'playing') {
        state.checkpoint = k.index;
        events.push({ type: 'checkpoint', index: k.index });
      } else if (k.kind === 'finish' && state.phase === 'playing') {
        state.phase = 'finished';
        state.players.forEach((p, i) => {
          if (p.farting) events.push({ type: 'fartEnd', player: i });
          p.farting = false;
        });
        events.push({ type: 'finish', timeTicks: state.timeTicks });
      }
    });

    return events;
  }

  // cause: 'spike' (splat) or 'fell' (off the edge). Back to the last checkpoint after a beat.
  function startRespawn(cause, events) {
    state.phase = 'respawning';
    state.respawnTimer = RESPAWN_TICKS;
    state.cause = cause;
    state.deaths++;
    state.players.forEach((p, i) => {
      if (p.farting) events.push({ type: 'fartEnd', player: i });
      p.farting = false;
    });
    events.push({ type: cause === 'fell' ? 'fell' : 'ouch' });
  }

  function snapshot() {
    const p = raft.translation();
    const v = raft.linvel();
    return {
      tick: state.tick,
      phase: state.phase,
      timeTicks: state.timeTicks,
      checkpoint: state.checkpoint,
      deaths: state.deaths,
      crew: state.crew,
      cause: state.phase === 'respawning' ? state.cause : null,
      respawn: state.phase === 'respawning' ? state.respawnTimer / RESPAWN_TICKS : 0, // 1 -> 0
      raft: { x: p.x, y: p.y, angle: raft.rotation(), vx: v.x, vy: v.y, av: raft.angvel() },
      players: state.players.map((pl) => ({ ...pl })),
      movers: movers.map((m) => {
        const mp = m.body.translation();
        return { x: mp.x, y: mp.y, angle: m.body.rotation() };
      }),
    };
  }

  // Back to the last checkpoint (player-requested, e.g. stuck). Costs a death.
  function respawn() {
    if (state.phase !== 'playing' && state.phase !== 'ready') return;
    state.phase = 'respawning';
    state.respawnTimer = 1;
    state.cause = 'manual';
    state.deaths++;
  }

  function restart(checkpoint = 0) {
    state.checkpoint = Math.max(0, Math.min(level.checkpoints.length - 1, checkpoint | 0));
    state.timeTicks = 0;
    state.deaths = 0;
    state.phase = 'ready';
    state.respawnTimer = 0;
    placeAtCheckpoint();
  }

  // Start the race clock now (online races start at GO, not on the first fart).
  function go() {
    if (state.phase === 'ready') state.phase = 'playing';
  }

  // Rapier worlds live in WASM memory; rooms must free theirs when they're done.
  function free() {
    world.free();
  }

  // Debug/tuning only: drop the raft somewhere.
  function debugPlace(x, y, angle = 0) {
    raft.setTranslation({ x, y }, true);
    raft.setRotation(angle, true);
    raft.setLinvel({ x: 0, y: 0 }, true);
    raft.setAngvel(0, true);
  }

  return { level, step, snapshot, respawn, restart, go, free, setCrew, debugPlace };
}

export const WELL_PULL = 3.5; // m/s^2 at the lip of a well, fading to nothing...
export const WELL_PULL_RANGE = 3.5; // ...this far from it
export const WINDMILL_TOWER = 0.6; // radius of the solid tower
export const WINDMILL_ARM = 0.7; // width of the deadly part of an arm
export const RING_THICK = 0.55;

// One spike circle as short straight pieces, leaving out the openings. def.gaps are the middle of
// each opening in degrees (0 = east, 90 = north), def.gapDeg how wide each one is.
export function ringSegments(def) {
  const out = [];
  const step = 0.8 / def.r; // pieces about 0.8 m long
  const gaps = def.gaps.map((d) => (d * Math.PI) / 180);
  const halfGap = (def.gapDeg * Math.PI) / 360;
  for (let a = 0; a < 2 * Math.PI; a += step) {
    const inGap = gaps.some((g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < halfGap);
    if (!inGap) out.push({ a, len: 0.8 * 1.15 });
  }
  return out;
}

export function moverPose(def, t) {
  if (def.type === 'slider') {
    const s = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / def.period + (def.phase || 0));
    return { x: def.from.x + (def.to.x - def.from.x) * s, y: def.from.y + (def.to.y - def.from.y) * s, angle: 0 };
  }
  return { x: def.x, y: def.y, angle: (def.speed || 0) * t + (def.phase || 0) };
}

function inRect(p, r) {
  return Math.abs(p.x - r.x) <= r.w / 2 && Math.abs(p.y - r.y) <= r.h / 2;
}
