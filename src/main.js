// Client entry. Three modes share one renderer and one frame loop:
//   menu   - landing screen; a local pond sim bobs along in the background
//   solo   - local practice (?practice): you drive all four players
//   online - the server runs the sim; we send our seat's buttons and draw its snapshots

import RAPIER from '@dimforge/rapier2d-compat';
import { createSim, DT, NUM_PLAYERS } from './sim/sim.js';
import { LEVELS, RACE_LEVELS, nextLevel } from './sim/levels.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createHud, fmtMs, fmtTime } from './hud.js';
import { createNet } from './net.js';
import { createStartLights } from './lights.js';
import { createTouchControls } from './touch.js';
import { renderJourney } from './journey.js';

await RAPIER.init();

const $ = (id) => document.getElementById(id);
// phones and tablets get on-screen controls (joystick + fart button)
const isTouch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);
const view = createRenderer($('game'));
const audio = createAudio();
const hud = createHud();
const lights = createStartLights({ audio });

let mode = null;
let frameFn = () => {};

const input = createInput({
  onRespawn: () => (mode === 'solo' ? local && local.sim.respawn() : mode === 'online' && net.send({ t: 'respawn' })),
  onRestart: () => mode === 'solo' && startSolo(soloLevel),
  onToggleHelp: () => mode !== 'menu' && $('help').classList.toggle('hidden'),
  onToggleMute: () => toggleMute(),
  screenToWorld: (x, y) => view.screenToWorld(x, y),
});

const touchControls = isTouch ? createTouchControls(input) : null;

// mute button (top-left) and the M key do the same thing
function showMuteState() {
  const muted = audio.isMuted();
  $('mute').textContent = muted ? '🔇' : '🔊';
  $('mute').setAttribute('aria-pressed', String(muted));
  $('mute').setAttribute('aria-label', muted ? 'Sound is off. Turn sound on' : 'Mute all sounds');
}
function toggleMute() {
  audio.toggleMute();
  showMuteState();
}
$('mute').onclick = (e) => {
  toggleMute();
  e.currentTarget.blur(); // or Space would press this button instead of farting
};
showMuteState();

function setBodyClass(prefix, value) {
  for (const c of [...document.body.classList]) if (c.startsWith(prefix)) document.body.classList.remove(c);
  if (value) document.body.classList.add(prefix + value);
}
function setMode(m) {
  mode = m;
  lights.hide();
  view.setFocusShift(0);
  if (touchControls) touchControls.releaseAll();
  setBodyClass('mode-', m);
  if (m !== 'online') setBodyClass('phase-', null);
}

// --- local sim runner (menu backdrop + solo) -----------------------------------------
let local = null;
function runLocal(levelId, { onEvents = () => {}, commands }) {
  if (local) local.sim.free();
  const sim = createSim(RAPIER, LEVELS[levelId]);
  local = { sim, prev: sim.snapshot(), curr: null, acc: 0 };
  local.curr = local.prev;
  view.setLevel(LEVELS[levelId]);
  return (dt) => {
    local.acc += dt;
    let steps = 0;
    while (local.acc >= DT && steps++ < 6) {
      const events = local.sim.step(commands(local.curr));
      local.prev = local.curr;
      local.curr = local.sim.snapshot();
      onEvents(events, local.curr);
      local.acc -= DT;
    }
    if (steps > 6) local.acc = 0;
    return { prev: local.prev, curr: local.curr, alpha: local.acc / DT };
  };
}

function soundsFor(events, { skipSeat = null } = {}) {
  for (const e of events) {
    if (e.player === skipSeat && (e.type === 'fartStart' || e.type === 'fartEnd')) continue;
    if (e.type === 'fartStart') audio.fartStart(e.player);
    else if (e.type === 'fartEnd') audio.fartEnd(e.player);
    else if (e.type === 'empty') audio.empty(e.player);
  }
}

function commonEvents(events) {
  for (const e of events) {
    if (e.type === 'checkpoint') {
      audio.checkpoint();
      hud.showMessage('Checkpoint!', '', 1200);
    } else if (e.type === 'ouch') {
      audio.ouch();
      view.shake(0.8);
      hud.showMessage('SPLAT!', 'Back to the checkpoint…', 1100);
    } else if (e.type === 'fell') {
      audio.fall();
      hud.showMessage('Off the edge!', 'Back to the checkpoint…', 1200);
    } else if (e.type === 'respawned') {
      view.snapCamera();
    }
  }
}

// --- menu -------------------------------------------------------------------------------
function toMenu() {
  setMode('menu');
  input.setSeat(null);
  view.setSeats(null, { tags: false }); // the menu backdrop has no tags
  hud.hideMessage();
  // attract mode: someone toots now and then so the pond looks alive
  let t = 0;
  const who = Array(NUM_PLAYERS).fill(0);
  const step = runLocal('pond', {
    commands: () => {
      t++;
      if (t % 70 === 0) who[(Math.random() * NUM_PLAYERS) | 0] = 12 + ((Math.random() * 25) | 0);
      return who.map((n, i) => {
        who[i] = Math.max(0, n - 1);
        return { aim: 0, move: 0, fart: n > 0 };
      });
    },
  });
  frameFn = (dt) => {
    const { prev, curr, alpha } = step(dt);
    view.render(prev, curr, alpha, dt, input.state);
  };
  showPage(null);
}

// landing leaderboard: pick a level and a crew size (one board per crew size)
let landingCrew = 1;
let landingLevel = RACE_LEVELS[0];
const fmtPar = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
for (const id of RACE_LEVELS) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = `Leaderboard · Level ${LEVELS[id].number}`;
  $('board-level').append(opt);
}
$('board-level').onchange = (e) => {
  landingLevel = e.target.value;
  refreshLandingBoard();
};
function refreshLandingBoard() {
  $('board-par').textContent = `Faster finish = more points. 1000 pts at par (${fmtPar(LEVELS[landingLevel].par)}).`;
  loadBoard($('landing-board'), landingCrew, null, landingLevel);
}
for (const tab of document.querySelectorAll('#crew-tabs button')) {
  tab.onclick = () => {
    landingCrew = Number(tab.dataset.crew);
    for (const t of document.querySelectorAll('#crew-tabs button')) t.classList.toggle('on', t === tab);
    refreshLandingBoard();
  };
}

// --- solo -------------------------------------------------------------------------------
// best solo-practice time per level, kept in this browser (level 1 keeps its original key)
const bestKey = (id) => (id === 'canal' ? 'tootraft.best.1' : `tootraft.best.${id}`);
function loadBest(id) {
  try {
    return Number(localStorage.getItem(bestKey(id))) || null;
  } catch {
    return null;
  }
}

let soloLevel = RACE_LEVELS[0];
function startSolo(levelId = soloLevel) {
  soloLevel = levelId;
  let best = loadBest(levelId);
  setMode('solo');
  input.setSeat(null);
  view.setSeats(null);
  hud.setPlayers(null);
  hud.setLevel(LEVELS[levelId]);
  $('best').textContent = best ? fmtTime(best) : '—';
  const startCp = Number(new URLSearchParams(location.search).get('cp')) || 0;
  // start lights: everyone sits still for 3 s, then the clock starts at GO
  let countdown = 3 * 60;
  const still = Array.from({ length: NUM_PLAYERS }, () => ({ aim: 0, fart: false, move: 0 }));
  const step = runLocal(levelId, {
    commands: (s) => {
      if (countdown <= 0) return input.getCommands(DT, s);
      countdown--;
      if (countdown === 0) {
        local.sim.go();
        lights.set(0);
      } else lights.set(Math.ceil(countdown / 60));
      return still;
    },
    onEvents: (events, s) => {
      soundsFor(events);
      commonEvents(events);
      for (const e of events) {
        if (e.type === 'go') hud.hideMessage();
        if (e.type !== 'finish') continue;
        audio.finish();
        // only full runs from the start count toward the best time
        const isBest = startCp === 0 && (!best || e.timeTicks < best);
        if (isBest) {
          best = e.timeTicks;
          try {
            localStorage.setItem(bestKey(levelId), String(best));
          } catch {}
          $('best').textContent = fmtTime(best);
        }
        hud.showMessage(`Finished! ${fmtTime(e.timeTicks)}`, `${isBest ? 'New best · ' : ''}${s.deaths} splats · Enter to race again`);
      }
    },
  });
  if (startCp) local.sim.restart(startCp), (local.prev = local.curr = local.sim.snapshot());
  hud.hideMessage();
  $('help').classList.add('hidden'); // the small controls hint is enough; H opens the full help
  frameFn = (dt) => {
    const { prev, curr, alpha } = step(dt);
    view.render(prev, curr, alpha, dt, input.state);
    hud.update(curr, input);
  };
}

// --- online -------------------------------------------------------------------------------
const ERRORS = {
  'bad-name': 'That name needs at least one letter.',
  'room-not-found': 'No room with that code. Check the 4 digits?',
  'room-full': 'That room already has 4 players.',
  'in-progress': "That room is mid-race. Wait for them to finish.",
  'not-host': 'Only the host can do that.',
  'already-in-room': 'You are already in a room.',
};
const INTERP_MS = 100; // draw the world this far in the past so there are always two snapshots to blend

const online = { seat: null, room: null, level: null, snaps: [], sent: null, sentAt: 0, myFart: false, lastCount: null };

const net = createNet({
  onStatus: (st) => {
    const bar = $('net-status');
    bar.textContent = st === 'reconnecting' ? 'Connection lost, reconnecting…' : '';
    bar.classList.toggle('show', mode === 'online' && st === 'reconnecting');
  },
  onMessage: (m) => {
    if (m.t === 'welcome') enterOnline(m.seat);
    else if (m.t === 'room') applyRoom(m.room);
    else if (m.t === 'snap') receiveSnap(m);
    else if (m.t === 'error') showError(m.code);
    else if (m.t === 'left') toMenu();
  },
});

function showError(code) {
  if (mode === 'online') return hud.showMessage(ERRORS[code] || 'Something went wrong', '', 1600);
  if (code === 'room-not-found' && net.hasSession()) {
    net.clearSession(); // came back to a room that's gone: nothing to tell them
    $('landing-error').textContent = '';
    return;
  }
  $('landing-error').textContent = ERRORS[code] || 'Something went wrong.';
}

function enterOnline(seat) {
  online.seat = seat;
  online.room = null;
  online.level = null;
  online.snaps = [];
  online.myFart = false;
  setMode('online');
  input.setSeat(seat);
  $('landing-error').textContent = '';
  $('help').classList.add('hidden');
  frameFn = onlineFrame;
}

function applyRoom(room) {
  const was = online.room ? online.room.phase : null;
  online.room = room;
  if (room.level !== online.level) {
    online.level = room.level;
    online.snaps = []; // never blend across a level change
    view.setLevel(LEVELS[room.level]);
    hud.setLevel(LEVELS[room.level]);
  }
  view.setSeats(room.seats.map((s) => s && { name: s.name, occupied: true }));
  hud.setPlayers(room.seats, online.seat);
  setBodyClass('phase-', room.phase);
  // on phones the lobby card covers the top of the screen; look ahead so your raft shows below it
  view.setFocusShift(isTouch && room.phase === 'lobby' ? 9 : 0);
  if (room.phase === 'countdown' && was !== 'countdown') input.setSeat(online.seat); // everyone starts facing the centre
  if (room.phase === 'lobby') {
    if (was !== 'lobby') loadMyProgress(); // just arrived, or back from a race
    if (was && was !== 'lobby') hud.hideMessage(), lights.hide();
    renderLobby(room);
  }
  if (room.phase === 'results' && was !== 'results') {
    audio.finish();
    hud.hideMessage();
    renderResults(room);
  }
  if (room.phase === 'results') renderResultButtons(room);
}

// your own cleared levels (for the ticks and best times on the lobby map)
async function loadMyProgress() {
  const name = typedName() || (online.room && online.room.seats[online.seat] && online.room.seats[online.seat].name);
  if (!name) return;
  try {
    online.cleared = (await (await fetch(`/api/progress?name=${encodeURIComponent(name)}`)).json()).cleared;
    if (online.room && online.room.phase === 'lobby') renderLobby(online.room);
  } catch {}
}

function renderLobby(room) {
  $('room-code').textContent = room.code;
  const list = $('seats');
  list.textContent = '';
  const colors = ['#ff5a5f', '#3fa7ff', '#ffc93c', '#5ad16a'];
  room.seats.forEach((s, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', colors[i]);
    li.className = s ? `filled${s.connected ? '' : ' away'}` : '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = s ? s.name : 'waiting for a player…';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [i === online.seat ? 'you' : '', i === room.host ? 'host' : '', s && !s.connected ? 'away' : ''].filter(Boolean).join(' · ');
    li.append(dot, who, tag);
    list.append(li);
  });
  const ready = room.seats.filter((s) => s && s.connected).length;
  const isHost = room.host === online.seat;
  const split = { 1: 'the whole raft to yourself', 2: 'half the raft each', 3: 'a third of the raft each', 4: 'a quarter each' }[ready];
  $('lobby-status').textContent = `${ready} player${ready === 1 ? '' : 's'}: ${split}` + (isHost ? '' : '. Waiting for the host…');
  $('start').disabled = !isHost;
  $('start').textContent = ready === NUM_PLAYERS ? 'Start race' : `Start race with ${ready}`;
  $('start').style.display = isHost ? '' : 'none';
  renderLevelPick(room, isHost);
}

// lobby journey map: the host taps a stop to choose the level; everyone sees the raft move there
function renderLevelPick(room, isHost) {
  renderJourney($('level-pick'), {
    levels: RACE_LEVELS.map((id) => LEVELS[id]),
    unlocked: room.unlocked,
    cleared: online.cleared || {},
    fmt: fmtMs,
    current: room.choice,
    pickable: isHost,
    onPick: (id) => net.send({ t: 'level', level: id }),
    dir: 'across', // compact, so the lobby card always fits
  });
}

function renderResults(room) {
  const r = room.result;
  if (!r) return;
  $('result-level').textContent = `Level ${LEVELS[r.level].number} · ${r.levelName}`;
  $('result-time').textContent = fmtMs(r.timeMs);
  $('result-detail').textContent = `${r.points} points · #${r.rank} of ${r.of} ${crewLabel(r.crewSize)} crews`;
  $('result-crew').textContent = `${r.players.join(', ')} · ${r.deaths} splat${r.deaths === 1 ? '' : 's'} (they don't count)`;
  loadBoard($('result-board'), r.crewSize, r.id, r.level);
}

function renderResultButtons(room) {
  const isHost = room.host === online.seat;
  const next = room.result && nextLevel(room.result.level);
  const canNext = !!next && room.unlocked.includes(next);
  $('next-level').style.display = isHost && canNext ? '' : 'none';
  if (canNext) $('next-level').textContent = `Next: ${LEVELS[next].name} →`;
  $('again').style.display = isHost ? '' : 'none';
  $('again').classList.toggle('primary', !canNext);
  $('to-pond').style.display = isHost ? '' : 'none';
  $('to-pond').textContent = room.private ? 'Choose a level' : 'Back to the pond';
  $('results-wait').textContent = isHost ? (next ? '' : 'That was the last level. For now…') : 'Waiting for the host to pick what is next…';
}

function receiveSnap(m) {
  m.at = performance.now();
  online.snaps.push(m);
  if (online.snaps.length > 30) online.snaps.shift();
  for (const e of m.ev) {
    if (e.type === 'empty' && e.player === online.seat && online.myFart) {
      audio.fartEnd(online.seat); // our own fart sound is local; stop it before the deflate squeak
      online.myFart = false;
    }
  }
  soundsFor(m.ev, { skipSeat: online.seat });
  commonEvents(m.ev);
  for (const e of m.ev) {
    if (e.type === 'go' && m.phase === 'race') lights.set(0); // the pond's first fart also says 'go'
  }
}

function onlineFrame(dt, now) {
  const snaps = online.snaps;
  if (!snaps.length) return; // nothing from the server yet
  const latest = snaps[snaps.length - 1];

  // interpolate between the two snapshots around (now - INTERP_MS)
  const t = now - INTERP_MS;
  let a = snaps[0];
  let b = snaps[0];
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].at <= t) {
      a = snaps[i - 1];
      b = snaps[i];
      break;
    }
  }
  if (t >= latest.at) a = b = latest;
  const alpha = b.at > a.at ? Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))) : 1;
  view.render(a.s, b.s, alpha, dt, input.state);
  hud.update(latest.s, input);

  if (latest.phase === 'countdown') {
    const n = Math.ceil(latest.cd / 60);
    if (n !== online.lastCount && n > 0) {
      online.lastCount = n;
      hud.hideMessage();
      lights.set(n);
    }
  } else online.lastCount = null;

  // our seat's buttons -> server (on change, plus a heartbeat)
  const mine = input.getCommands(dt, latest.s)[online.seat];
  const canFart = latest.phase === 'lobby' || latest.phase === 'race';
  // play our own fart instantly instead of waiting a round trip for the server's event
  if (mine.fart && !online.myFart && canFart && !latest.s.players[online.seat].empty) {
    online.myFart = true;
    audio.fartStart(online.seat);
  } else if (!mine.fart && online.myFart) {
    online.myFart = false;
    audio.fartEnd(online.seat);
  }
  const s = online.sent;
  const changed = !s || s.fart !== mine.fart || s.move !== mine.move || Math.abs(s.aim - mine.aim) > 0.02;
  if (changed || now - online.sentAt > 100) {
    net.send({ t: 'input', fart: mine.fart, move: mine.move, aim: Math.round(mine.aim * 1000) / 1000 });
    online.sent = mine;
    online.sentAt = now;
  }
}

function leaveRoom() {
  if (mode === 'online') {
    net.send({ t: 'leave' });
    net.close();
    if (online.myFart) audio.fartEnd(online.seat);
  }
  toMenu();
}

// --- leaderboard ------------------------------------------------------------------------
const crewLabel = (n) => ({ 1: 'solo', 2: '2-player', 3: '3-player', 4: '4-player' })[n] || '';

async function loadBoard(table, crewSize = 4, highlightId = null, level = RACE_LEVELS[0]) {
  try {
    const res = await fetch(`/api/leaderboard?level=${level}&crew=${crewSize}`);
    if (!res.ok) throw new Error(res.status);
    renderBoard(table, (await res.json()).top.slice(0, 10), highlightId);
  } catch {
    renderBoard(table, null);
  }
}

function renderBoard(table, rows, highlightId) {
  table.textContent = '';
  const head = table.insertRow();
  for (const h of ['#', 'Crew', 'Time', 'Points', 'When']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  if (!rows || !rows.length) {
    const tr = table.insertRow();
    tr.className = 'empty-row';
    const td = tr.insertCell();
    td.colSpan = 5;
    td.textContent = rows ? 'No races yet. Be the first crew on the board!' : 'Leaderboard is offline right now.';
    return;
  }
  rows.forEach((r, i) => {
    const tr = table.insertRow();
    if (r.id === highlightId) tr.className = 'mine';
    const cells = [
      [String(i + 1), 'num'],
      [r.players.join(', '), 'crew'],
      [fmtMs(r.time_ms), 'num'],
      [String(r.points), 'num'],
      [new Date(r.finished_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), 'when'],
    ];
    for (const [text, cls] of cells) {
      const td = tr.insertCell();
      td.textContent = text;
      td.className = cls;
    }
  });
}

// --- landing buttons --------------------------------------------------------------------
const nameInput = $('name');
try {
  nameInput.value = localStorage.getItem('tootraft.name') || '';
} catch {}
// nobody should have to stop and type a name to play: there's always a fun one to start with
const FUN_NAMES = ['Captain Toot', 'Sir Blows-a-lot', 'Gassy Gary', 'Admiral Poot', 'Rafty McRaft', 'Windy Wendy', 'Tooty Fruity', 'Baron von Toot'];
if (!nameInput.value.trim()) nameInput.value = FUN_NAMES[(Math.random() * FUN_NAMES.length) | 0];
function playerName() {
  const name = nameInput.value.trim() || FUN_NAMES[0];
  nameInput.value = name;
  try {
    localStorage.setItem('tootraft.name', name);
  } catch {}
  return name;
}
$('create').onclick = () => {
  net.open();
  net.send({ t: 'create', name: playerName() });
};
function join() {
  const name = playerName();
  const code = $('code').value.trim();
  if (!/^\d{4}$/.test(code)) {
    $('landing-error').textContent = 'Room codes are 4 digits.';
    return $('code').focus();
  }
  net.open();
  net.send({ t: 'join', name, code });
}
$('join').onclick = join;
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && join());
$('code').addEventListener('input', (e) => (e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4)));
$('leave').onclick = leaveRoom;
$('start').onclick = () => net.send({ t: 'start' });
$('again').onclick = () => net.send({ t: 'start', level: online.room.result.level });
$('next-level').onclick = () => net.send({ t: 'start', level: nextLevel(online.room.result.level) });
$('play-single').onclick = () => showPage('single');
$('play-multi').onclick = () => showPage('multi');
$('open-board').onclick = () => showPage('board');
$('open-history').onclick = () => showPage('history');

// about popup: closes with the ×, Esc or a click outside the card
const about = $('about');
const closeAbout = () => (about.hidden = true);
$('open-about').onclick = () => {
  about.hidden = false;
  $('about-close').focus();
};
$('about-close').onclick = closeAbout;
about.addEventListener('click', (e) => e.target === about && closeAbout());
addEventListener('keydown', (e) => e.key === 'Escape' && !about.hidden && closeAbout());
for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => showPage(null);

// --- menu pages: levels and race history --------------------------------------------------
function showPage(page) {
  setBodyClass('page-', page);
  $('landing-error').textContent = '';
  if (page === 'single') renderSinglePage();
  if (page === 'board') refreshLandingBoard();
  if (page === 'history') renderHistoryPage();
  if (page === 'multi') playerName();
}

const typedName = () => nameInput.value.trim();

// single player: tap any level on the map, press Play
let singlePick = null;
async function renderSinglePage() {
  const name = playerName();
  let prog = { cleared: {}, unlocked: RACE_LEVELS };
  try {
    prog = await (await fetch(`/api/progress?name=${encodeURIComponent(name)}`)).json();
  } catch {}
  const levels = RACE_LEVELS.map((id) => LEVELS[id]);
  // start on the level you picked last, otherwise the first one you haven't finished
  singlePick = singlePick || RACE_LEVELS.find((id) => !prog.cleared[id]) || RACE_LEVELS[0];
  const draw = () => {
    renderJourney($('levels-map'), {
      levels, unlocked: prog.unlocked, cleared: prog.cleared, current: singlePick, pickable: true, fmt: fmtMs,
      onPick: (id) => ((singlePick = id), draw()),
    });
    const L = LEVELS[singlePick];
    const done = prog.cleared[singlePick];
    const box = $('level-detail');
    box.textContent = '';
    const title = document.createElement('h3');
    title.textContent = `${L.number}. ${L.name}`;
    const blurb = document.createElement('p');
    blurb.textContent = `${L.blurb} Par ${fmtPar(L.par)}.`;
    const state = document.createElement('div');
    state.className = 'state';
    state.textContent = done ? `✓ Best ${fmtMs(done.best_ms)} · ${done.best_points} pts` : 'Not finished yet';
    const play = document.createElement('button');
    play.className = 'primary';
    play.textContent = 'Play';
    play.onclick = () => {
      net.open();
      net.send({ t: 'create', name: playerName(), private: true, level: singlePick });
    };
    box.append(title, blurb, state, play);
  };
  draw();
}

let historyScope = 'mine';
for (const tab of document.querySelectorAll('#history-tabs button')) {
  tab.onclick = () => {
    historyScope = tab.dataset.scope;
    for (const t of document.querySelectorAll('#history-tabs button')) t.classList.toggle('on', t === tab);
    renderHistoryPage();
  };
}

async function renderHistoryPage() {
  const name = typedName();
  const scope = name ? historyScope : 'all';
  const stats = $('history-stats');
  const table = $('history-table');
  let h;
  try {
    h = await (await fetch(`/api/history${scope === 'mine' ? `?name=${encodeURIComponent(name)}` : ''}`)).json();
  } catch {
    stats.textContent = 'History is offline right now.';
    table.textContent = '';
    return;
  }
  const tiles = [['Races, everyone', h.total]];
  if (name) {
    const mine = scope === 'mine' ? h.mine : null;
    if (mine !== null) tiles.push([`${name}'s races`, mine]);
  }
  for (const id of RACE_LEVELS) tiles.push([`Level ${LEVELS[id].number}`, h.byLevel[id] || 0]);
  for (const n of [1, 2, 3, 4]) if (h.byCrew[n]) tiles.push([n === 1 ? 'Solo crews' : `${n}-player crews`, h.byCrew[n]]);
  stats.textContent = '';
  for (const [k, v] of tiles) {
    const d = document.createElement('div');
    d.className = 'stat';
    const vv = document.createElement('div');
    vv.className = 'v';
    vv.textContent = String(v);
    const kk = document.createElement('div');
    kk.className = 'k';
    kk.textContent = k;
    d.append(vv, kk);
    stats.append(d);
  }
  $('history-tabs').style.display = name ? '' : 'none';
  table.textContent = '';
  const head = table.insertRow();
  for (const t of ['When', 'Level', 'Crew', 'Time', 'Points']) {
    const th = document.createElement('th');
    th.textContent = t;
    head.append(th);
  }
  if (!h.games.length) {
    const td = table.insertRow().insertCell();
    td.colSpan = 5;
    td.textContent = scope === 'mine' ? `No races for ${name} yet.` : 'No races yet.';
    td.parentElement.className = 'empty-row';
    return;
  }
  for (const g of h.games) {
    const tr = table.insertRow();
    const cells = [
      [new Date(g.finished_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), 'when'],
      [LEVELS[g.level] ? `${LEVELS[g.level].number}. ${LEVELS[g.level].name}` : g.level, ''],
      [g.players.join(', '), 'crew'],
      [fmtMs(g.time_ms), 'num'],
      [String(g.points), 'num'],
    ];
    for (const [text, cls] of cells) {
      const td = tr.insertCell();
      td.textContent = text;
      td.className = cls;
    }
  }
}
$('to-pond').onclick = () => {
  if (!online.room.private) return net.send({ t: 'lobby' });
  leaveRoom();
  showPage('single');
};

// A hidden tab stops running frames, so tell the server we let go of everything.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || mode !== 'online') return;
  net.send({ t: 'input', fart: false, move: 0, aim: online.sent ? online.sent.aim : 0 });
  online.sent = null;
  if (online.myFart) {
    online.myFart = false;
    audio.fartEnd(online.seat);
  }
});

// --- go -----------------------------------------------------------------------------------
toMenu();
if (net.hasSession()) {
  $('landing-error').textContent = 'Rejoining your game…';
  net.open();
} else if (new URLSearchParams(location.search).has('practice')) {
  startSolo(); // one person drives all four: handy for testing and screenshots (?practice)
}

// a little "still here" ping for /analytics, only while the tab is actually visible
const pingId = Math.random().toString(36).slice(2, 12).padEnd(8, '0');
function pingAnalytics() {
  if (!document.hidden) fetch(`/api/ping?id=${pingId}&mode=${mode}`, { method: 'POST' }).catch(() => {});
}
pingAnalytics();
setInterval(pingAnalytics, 30_000);
document.addEventListener('visibilitychange', pingAnalytics);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frameFn(dt, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handle for debugging / automated checks in the console.
window.__toot = {
  input, online, net,
  get mode() { return mode; },
  get sim() { return local && local.sim; },
  get state() { return mode === 'online' ? online.snaps.at(-1)?.s : local && local.curr; },
};
