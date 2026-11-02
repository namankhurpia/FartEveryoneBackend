// Rooms: a 4-digit code, 4 seats, one authoritative sim.
// Phases: lobby (practice pond, anyone can paddle) -> countdown -> race -> results -> (race again | lobby)
// The host can start with 1 to 4 players; the raft's rim is split evenly between them.

import { randomBytes } from 'node:crypto';
import { createSim, DT, NUM_PLAYERS, TICK_RATE } from '../src/sim/sim.js';
import { LEVELS, RACE_LEVELS } from '../src/sim/levels.js';
import { unlockedLevels } from '../src/sim/progress.js';
import { pointsFor } from '../src/sim/scoring.js';

const COUNTDOWN_TICKS = 3 * TICK_RATE;
const SNAP_EVERY = 2; // 30 snapshots/s
const IDLE = () => ({ aim: 0, fart: false, move: 0 });
// Clients resend input at least every 100 ms while their tab is visible. A seat that has gone
// quiet longer than this (background tab, phone switched apps) is treated as letting go.
const STALE_INPUT_MS = 500;

export function createRooms({ RAPIER, db, roomTtlMs = 30_000, seatGraceMs = 10_000, log = () => {} }) {
  const rooms = new Map();

  function newCode() {
    for (let i = 0; i < 1000; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      if (!rooms.has(code)) return code;
    }
    throw new Error('no free room codes');
  }

  class Room {
    constructor() {
      this.code = newCode();
      this.seats = Array(NUM_PLAYERS).fill(null); // { name, token, ws, connected, cmd, leftAt }
      this.phase = 'lobby';
      this.countdown = 0;
      this.levelId = 'pond';
      this.sim = createSim(RAPIER, LEVELS.pond, { crew: [] }); // re-split as people sit down
      this.events = [];
      this.ticks = 0;
      this.emptySince = null;
      this.startedAt = null;
      this.lastResult = null;
      this.levelChoice = RACE_LEVELS[0]; // what the host picked for the next race
      rooms.set(this.code, this);
      log(`room ${this.code} created`);
    }

    get hostSeat() {
      const i = this.seats.findIndex((s) => s && s.connected);
      return i === -1 ? null : i;
    }

    get connectedCount() {
      return this.seats.filter((s) => s && s.connected).length;
    }

    addPlayer(name, ws) {
      if (this.phase !== 'lobby') return { error: 'in-progress' };
      const seat = this.seats.findIndex((s) => !s);
      if (seat === -1) return { error: 'room-full' };
      const token = randomBytes(12).toString('hex');
      this.seats[seat] = { name, token, ws, connected: true, cmd: IDLE(), lastInput: 0, leftAt: null };
      this.emptySince = null;
      this.seatsChanged();
      return { seat, token };
    }

    rejoin(token, ws) {
      const seat = this.seats.findIndex((s) => s && s.token === token);
      if (seat === -1) return { error: 'room-not-found' };
      const s = this.seats[seat];
      if (s.ws && s.ws !== ws) s.ws.close(4000, 'replaced');
      Object.assign(s, { ws, connected: true, cmd: IDLE(), leftAt: null });
      this.emptySince = null;
      this.broadcastRoom();
      return { seat, token };
    }

    disconnect(seat, ws) {
      const s = this.seats[seat];
      if (!s || s.ws !== ws) return;
      // stop pushing: a player who drops mid-fart must not keep farting
      Object.assign(s, { ws: null, connected: false, cmd: IDLE(), leftAt: Date.now() });
      if (this.connectedCount === 0) this.emptySince = Date.now();
      this.broadcastRoom();
    }

    leave(seat, ws) {
      if (!this.seats[seat] || this.seats[seat].ws !== ws) return;
      this.disconnect(seat, ws);
      if (this.phase === 'lobby') {
        this.seats[seat] = null;
        this.seatsChanged();
      }
    }

    get seated() {
      return this.seats.flatMap((s, i) => (s ? [i] : []));
    }

    // Someone sat down or left. In the pond the raft re-splits between whoever is on it.
    seatsChanged() {
      if (this.phase === 'lobby') this.events.push(...this.sim.setCrew(this.seated));
      this.broadcastRoom();
    }

    input(seat, msg) {
      const s = this.seats[seat];
      if (!s) return;
      const move = Number(msg.move);
      const aim = Number(msg.aim);
      s.lastInput = Date.now();
      s.cmd = {
        fart: msg.fart === true,
        move: Number.isFinite(move) ? Math.max(-1, Math.min(1, move)) : 0,
        aim: Number.isFinite(aim) ? Math.atan2(Math.sin(aim), Math.cos(aim)) : 0,
      };
    }

    // Levels this room can play: anything unlocked by anyone sitting in it.
    unlocked() {
      const cleared = new Set();
      for (const s of this.seats) if (s) for (const id of Object.keys(db.progress(s.name))) cleared.add(id);
      return unlockedLevels(cleared);
    }

    // the host's pick, or the furthest unlocked level if whoever unlocked it has left
    effectiveLevel(unlocked = this.unlocked()) {
      return unlocked.includes(this.levelChoice) ? this.levelChoice : unlocked[unlocked.length - 1];
    }

    // host: choose the level for the next race
    chooseLevel(seat, id) {
      if (seat !== this.hostSeat) return { error: 'not-host' };
      if (!RACE_LEVELS.includes(id)) return { error: 'bad-level' };
      if (!this.unlocked().includes(id)) return { error: 'locked' };
      this.levelChoice = id;
      this.broadcastRoom();
      return {};
    }

    // host: start (or restart) the race with whoever is here, 1 to 4 players.
    // Anyone seated but disconnected gives up their seat; the crew is everyone left.
    // `level` (optional) picks the level in the same step, e.g. "Next level" on the results screen.
    start(seat, level) {
      if (seat !== this.hostSeat) return { error: 'not-host' };
      if (this.phase !== 'lobby' && this.phase !== 'results') return { error: 'in-progress' };
      this.seats = this.seats.map((s) => (s && !s.connected ? null : s));
      const unlocked = this.unlocked();
      if (level !== undefined) {
        if (!RACE_LEVELS.includes(level)) return { error: 'bad-level' };
        if (!unlocked.includes(level)) return { error: 'locked' };
        this.levelChoice = level;
      }
      this.load(this.effectiveLevel(unlocked));
      this.phase = 'countdown';
      this.countdown = COUNTDOWN_TICKS;
      this.lastResult = null;
      this.broadcastRoom();
      return {};
    }

    // host: back to the practice pond (also aborts a race)
    toLobby(seat) {
      if (seat !== this.hostSeat) return { error: 'not-host' };
      // anyone who left during the race gives up their seat now
      this.seats = this.seats.map((s) => (s && !s.connected ? null : s));
      this.load('pond');
      this.phase = 'lobby';
      this.broadcastRoom();
      return {};
    }

    respawn() {
      if (this.phase === 'race') this.sim.respawn();
    }

    load(levelId) {
      this.sim.free();
      this.levelId = levelId;
      this.sim = createSim(RAPIER, LEVELS[levelId], { crew: this.seated });
      this.events = [];
      for (const s of this.seats) if (s) s.cmd = IDLE();
    }

    step(now = Date.now()) {
      this.ticks++;
      const racing = this.phase === 'race';
      const free = this.phase === 'lobby' || this.phase === 'results';
      // inputs count in the lobby pond and the race; during the countdown everyone sits still
      const live = (s) => s && s.connected && now - s.lastInput < STALE_INPUT_MS;
      const cmds = this.seats.map((s) => (live(s) && (racing || free) ? s.cmd : IDLE()));
      if (this.phase === 'results') cmds.fill(IDLE()); // the finished raft just drifts
      const ev = this.sim.step(cmds);
      this.events.push(...ev);

      if (this.phase === 'countdown' && --this.countdown <= 0) {
        this.phase = 'race';
        this.sim.go();
        this.startedAt = new Date().toISOString();
        this.events.push({ type: 'go' });
        this.broadcastRoom();
      }
      if (racing) {
        const fin = ev.find((e) => e.type === 'finish');
        if (fin) this.finish(fin.timeTicks);
      }

      if (this.ticks % SNAP_EVERY === 0) {
        this.broadcast({ t: 'snap', phase: this.phase, cd: this.countdown, s: compact(this.sim.snapshot()), ev: this.events });
        this.events = [];
      }
    }

    finish(timeTicks) {
      const level = LEVELS[this.levelId];
      const timeMs = Math.round((timeTicks * 1000) / TICK_RATE);
      const points = pointsFor(level, timeMs);
      const snap = this.sim.snapshot();
      const players = snap.crew.map((i) => (this.seats[i] ? this.seats[i].name : '?'));
      const deaths = snap.deaths;
      const crewSize = players.length;
      const saved = db.saveGame({
        level: level.id, room: this.code, players, crewSize, timeMs, points, deaths,
        startedAt: this.startedAt || new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
      this.phase = 'results';
      this.lastResult = { level: level.id, levelName: level.name, players, crewSize, timeMs, points, deaths, ...saved };
      log(`room ${this.code} finished ${level.id} with ${crewSize} in ${timeMs} ms (${points} pts, rank ${saved.rank})`);
      this.broadcastRoom();
    }

    roomState() {
      const unlocked = this.unlocked();
      return {
        code: this.code,
        phase: this.phase,
        level: this.levelId,
        choice: this.effectiveLevel(unlocked),
        unlocked,
        host: this.hostSeat,
        seats: this.seats.map((s) => (s ? { name: s.name, connected: s.connected } : null)),
        result: this.lastResult,
      };
    }

    broadcastRoom() {
      this.broadcast({ t: 'room', room: this.roomState() });
    }

    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const s of this.seats) if (s && s.ws && s.ws.readyState === 1) s.ws.send(data);
    }

    close() {
      this.sim.free();
      rooms.delete(this.code);
      log(`room ${this.code} removed`);
    }
  }

  // housekeeping: free lobby seats of people who left, delete rooms nobody is in
  function sweep(now) {
    for (const room of [...rooms.values()]) {
      if (room.emptySince && now - room.emptySince > roomTtlMs) {
        room.close();
        continue;
      }
      if (room.phase === 'lobby') {
        let changed = false;
        room.seats = room.seats.map((s) => {
          if (s && !s.connected && now - s.leftAt > seatGraceMs) {
            changed = true;
            return null;
          }
          return s;
        });
        if (changed) room.seatsChanged();
      }
    }
  }

  return {
    rooms,
    create: () => new Room(),
    get: (code) => rooms.get(String(code)),
    step: () => rooms.forEach((r) => r.step()),
    // who's here right now, for /analytics
    stats() {
      const out = { rooms: 0, inRooms: 0, racing: 0 };
      rooms.forEach((r) => {
        const n = r.connectedCount;
        if (!n) return;
        out.rooms++;
        out.inRooms += n;
        if (r.phase === 'countdown' || r.phase === 'race') out.racing += n;
      });
      return out;
    },
    sweep,
  };
}

// trim floats so snapshots stay small on the wire
function compact(s) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return {
    tick: s.tick, phase: s.phase, timeTicks: s.timeTicks, checkpoint: s.checkpoint, deaths: s.deaths, crew: s.crew, cause: s.cause, respawn: r(s.respawn),
    raft: { x: r(s.raft.x), y: r(s.raft.y), angle: r(s.raft.angle), vx: r(s.raft.vx), vy: r(s.raft.vy), av: r(s.raft.av) },
    players: s.players.map((p) => ({
      pos: r(p.pos), aim: r(p.aim), farting: p.farting, gas: r(p.gas), burst: p.burst, empty: p.empty,
    })),
    movers: s.movers.map((m) => ({ x: r(m.x), y: r(m.y), angle: r(m.angle) })),
  };
}

export { DT };
