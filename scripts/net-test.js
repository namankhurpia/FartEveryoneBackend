// End-to-end multiplayer test: a real server, 4 WebSocket clients, physics sped up 10x.
// Covers rooms, starting with 1-4 players, host-only actions, disconnect-while-farting,
// rejoin, a full race driven by the autopilot over the network, score saving, the
// leaderboard API and room cleanup.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { createPilot } from './pilot.js';

const dataDir = mkdtempSync(join(tmpdir(), 'toot-test-'));
const server = await startServer({ port: 0, dataDir, staticDir: './dist', simSpeed: 10, roomTtlMs: 600, seatGraceMs: 400, log: () => {} });
const url = `ws://127.0.0.1:${server.port}/ws`;

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(label) {
  const ws = new WebSocket(url);
  const c = { label, ws, inbox: [], room: null, snap: null, seat: null, token: null, code: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'room') c.room = m.room;
    if (m.t === 'snap') c.snap = m;
    if (m.t === 'welcome') Object.assign(c, { seat: m.seat, token: m.token, code: m.code });
    c.inbox.push(m);
    c.onSnap && m.t === 'snap' && c.onSnap(m);
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.open = new Promise((r) => ws.on('open', r));
  c.waitFor = async (pred, ms = 5000, what = 'message') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = c.inbox.find(pred);
      if (hit) {
        c.inbox.splice(c.inbox.indexOf(hit), 1);
        return hit;
      }
      await sleep(5);
    }
    throw new Error(`${label}: timed out waiting for ${what}`);
  };
  c.close = () => new Promise((r) => (ws.on('close', r), ws.close()));
  return c;
}

try {
  const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(client);
  await Promise.all([a, b, c, d, e].map((x) => x.open));

  e.send({ t: 'create', name: '   ' });
  check((await e.waitFor((m) => m.t === 'error')).code === 'bad-name', 'blank name is rejected');
  e.send({ t: 'join', name: 'Eve', code: '0000' });
  check((await e.waitFor((m) => m.t === 'error')).code === 'room-not-found', 'unknown room code is rejected');

  a.send({ t: 'create', name: '<b>Ann</b>' });
  await a.waitFor((m) => m.t === 'welcome');
  check(/^\d{4}$/.test(a.code) && a.seat === 0, `room created with 4-digit code ${a.code}, creator in seat 1`);
  check(a.room.seats[0].name === 'bAnn/b', 'angle brackets are stripped from names');

  for (const [x, name] of [[b, 'Bob'], [c, 'Cat']]) {
    x.send({ t: 'join', name, code: a.code });
    await x.waitFor((m) => m.t === 'welcome');
  }
  await a.waitFor((m) => m.t === 'snap' && m.s.crew.join() === '0,1,2', 3000, 'lobby crew of 3');
  check(true, 'lobby raft re-splits between the 3 seated players');

  // a lone player can start a race: crew of 1
  const f = client('F');
  await f.open;
  f.send({ t: 'create', name: 'Solo' });
  await f.waitFor((m) => m.t === 'welcome');
  f.send({ t: 'start' });
  const cd = await f.waitFor((m) => m.t === 'room' && m.room.phase === 'countdown', 3000, 'solo countdown');
  const soloSnap = await f.waitFor((m) => m.t === 'snap' && m.phase === 'countdown', 3000, 'solo snap');
  check(cd.room.level === 'canal' && soloSnap.s.crew.join() === '0', 'host can start alone: race with a crew of 1');
  f.send({ t: 'lobby' });
  await f.waitFor((m) => m.t === 'room' && m.room.phase === 'lobby', 3000, 'solo back to lobby');

  // every level is open for now; finishing one is still tracked
  server.db.saveGame({ level: 'canal', room: f.code, players: ['Solo'], crewSize: 1, timeMs: 80000, points: 938, deaths: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  const prog = await (await fetch(`http://127.0.0.1:${server.port}/api/progress?name=sOLO`)).json();
  check(!!prog.cleared.canal && prog.unlocked.join() === 'canal,plank,rapids', 'progress API: finished levels are tracked (any case), every level is open');
  f.inbox.length = 0;
  f.send({ t: 'level', level: 'plank' });
  const picked = await f.waitFor((m) => m.t === 'room' && m.room.choice === 'plank', 3000, 'level picked');
  check(picked.room.unlocked.join() === 'canal,plank,rapids', 'room can pick any level');
  f.send({ t: 'level', level: 'nope' });
  check((await f.waitFor((m) => m.t === 'error')).code === 'bad-level', 'a made-up level is refused');
  f.send({ t: 'start' });
  const lvl2 = await f.waitFor((m) => m.t === 'room' && m.room.phase === 'countdown', 3000, 'level 2 countdown');
  check(lvl2.room.level === 'plank', 'race starts on the picked level');
  f.send({ t: 'lobby' });
  await f.waitFor((m) => m.t === 'room' && m.room.phase === 'lobby', 3000, 'back to lobby');
  await f.close();

  d.send({ t: 'join', name: 'Dan', code: a.code });
  await d.waitFor((m) => m.t === 'welcome');
  check(d.seat === 3, 'fourth player gets seat 4');
  e.send({ t: 'join', name: 'Eve', code: a.code });
  check((await e.waitFor((m) => m.t === 'error')).code === 'room-full', 'fifth player is turned away');

  // /analytics: live players, and visits with bots filtered out and no double-counting of uniques
  const api = `http://127.0.0.1:${server.port}`;
  const browser = { headers: { 'user-agent': 'Mozilla/5.0 Safari/605', 'x-test': '1' } };
  await fetch(api + '/', browser);
  await fetch(api + '/', browser);
  await fetch(api + '/', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
  await fetch(api + '/og.jpg', browser);
  await fetch(api + '/api/ping?id=testtab01&mode=solo', { method: 'POST' });
  const stats = await (await fetch(api + '/api/analytics')).json();
  check(stats.now.inRooms === 4 && stats.now.rooms === 1 && stats.now.single === 1 && stats.now.onSite === 5, 'analytics: live counts of players in rooms and solo tabs');
  check(stats.totalViews === 2 && stats.totalVisitors === 1, 'analytics: 2 views by 1 visitor; the bot and image requests are not counted');
  check(stats.days[0].views === 2 && stats.days[0].peak >= 5, 'analytics: per-day numbers and peak');
  const page = await fetch(api + '/analytics');
  check(page.status === 200 && (await page.text()).includes('noindex') , '/analytics page is served and kept out of search results');

  // single player: straight into a race on the chosen level, no lobby, and nobody can join
  const g = client('G');
  await g.open;
  g.send({ t: 'create', name: 'Lone', private: true, level: 'rapids' });
  const lone = await g.waitFor((m) => m.t === 'room' && m.room.phase === 'countdown', 3000, 'single player countdown');
  check(lone.room.private && lone.room.level === 'rapids' && lone.room.seats.filter(Boolean).length === 1, 'single player starts straight away on the chosen level');
  const snoop = client('S');
  await snoop.open;
  snoop.send({ t: 'join', name: 'Snoop', code: g.code });
  check((await snoop.waitFor((m) => m.t === 'error')).code === 'room-not-found', 'nobody can join a single player game');
  await snoop.close();
  await g.close();

  // a tab that goes quiet mid-fart (backgrounded, phone switched apps) must stop farting
  c.send({ t: 'input', fart: true, move: 0, aim: 0 });
  await a.waitFor((m) => m.t === 'snap' && m.s.players[2].farting, 3000, 'C farting');
  await sleep(1000);
  a.inbox.length = 0;
  await a.waitFor((m) => m.t === 'snap', 3000);
  check(!a.snap.s.players[2].farting, 'a player whose input goes quiet mid-fart stops farting');

  // disconnect while holding fart -> must stop farting; then rejoin with the token
  d.send({ t: 'input', fart: true, move: 0, aim: 0 });
  await a.waitFor((m) => m.t === 'snap' && m.s.players[3].farting, 3000, 'D farting');
  const token = d.token;
  await d.close();
  await a.waitFor((m) => m.t === 'room' && m.room.seats[3] && !m.room.seats[3].connected, 3000, 'D marked disconnected');
  a.inbox.length = 0;
  await a.waitFor((m) => m.t === 'snap', 3000);
  await a.waitFor((m) => m.t === 'snap', 3000);
  check(!a.snap.s.players[3].farting, 'a player who disconnects mid-fart stops farting');

  const d2 = client('D2');
  await d2.open;
  d2.send({ t: 'rejoin', code: a.code, token });
  await d2.waitFor((m) => m.t === 'welcome');
  check(d2.seat === 3 && a.room.seats[3].connected, 'rejoin with token gets the same seat back');

  b.send({ t: 'start' });
  check((await b.waitFor((m) => m.t === 'error')).code === 'not-host', 'only the host can start');

  // race: every client runs the autopilot and sends only its own seat's command
  const crew = [a, b, c, d2];
  for (const x of crew) {
    const pilot = createPilot();
    x.onSnap = (m) => {
      if (m.phase !== 'race') return;
      x.send({ t: 'input', ...pilot(m.s, m.ev)[x.seat] });
    };
  }
  a.send({ t: 'start' });
  await a.waitFor((m) => m.t === 'room' && m.room.phase === 'countdown', 3000, 'countdown');
  check(true, 'host start with 4 players begins the countdown');
  await a.waitFor((m) => m.t === 'room' && m.room.phase === 'race', 3000, 'race');
  check(a.room.level === 'canal', 'race runs on level 1 (canal)');
  const res = await a.waitFor((m) => m.t === 'room' && m.room.phase === 'results', 60000, 'results');
  const r = res.room.result;
  console.log(`     race finished: ${(r.timeMs / 1000).toFixed(1)} s, ${r.points} points, rank ${r.rank}/${r.of}, ${r.deaths} splats`);
  check(r.points > 0 && r.rank === 1 && r.crewSize === 4 && r.players.join() === 'bAnn/b,Bob,Cat,Dan', 'result saved with points, rank, crew size and all 4 names');

  const lb = await (await fetch(`http://127.0.0.1:${server.port}/api/leaderboard?level=canal&crew=4`)).json();
  check(lb.top.length === 1 && lb.top[0].points === r.points && !!Date.parse(lb.top[0].finished_at), 'leaderboard API returns the game with its date/time');
  const lb1 = await (await fetch(`http://127.0.0.1:${server.port}/api/leaderboard?level=canal&crew=1`)).json();
  check(!lb1.top.some((g) => g.id === r.id), '4-player games stay off the solo leaderboard');
  const hist = await (await fetch(`http://127.0.0.1:${server.port}/api/history?name=Bob`)).json();
  check(hist.total === 2 && hist.byLevel.canal === 2 && hist.byCrew['4'] === 1 && hist.mine === 1 && hist.games[0].id === r.id,
    'history API counts all races, per level, per crew size, and yours');

  a.inbox.length = 0;
  a.send({ t: 'lobby' });
  const back = await a.waitFor((m) => m.t === 'room' && m.room.phase === 'lobby', 3000, 'back to lobby');
  check(back.room.level === 'pond', 'host can take everyone back to the practice pond');

  await Promise.all([a, b, c, d2, e].map((x) => x.close()));
  await sleep(1200);
  check(server.rooms.rooms.size === 0, 'room is removed once everyone has left');
} catch (err) {
  console.log('FAIL', err.message);
  failures++;
} finally {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
