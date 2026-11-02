// Bottoms Up! server: serves the built game, the leaderboard API and the WebSocket rooms
// on one port. Every room's physics runs here; browsers only send their buttons.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import RAPIER from '@dimforge/rapier2d-compat';
import { DT } from '../src/sim/sim.js';
import { RACE_LEVELS } from '../src/sim/levels.js';
import { unlockedLevels } from '../src/sim/progress.js';
import { cleanName } from './names.js';
import { openDb } from './db.js';
import { createRooms } from './rooms.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.xml', '.wasm']);

export async function startServer({
  port = 8080,
  host = '0.0.0.0',
  dataDir = './data',
  staticDir = './dist',
  simSpeed = 1,          // >1 only for tests: runs the physics faster than real time
  roomTtlMs = 30_000,    // delete a room this long after the last person leaves
  seatGraceMs = 10_000,  // in the lobby, a disconnected player's seat is kept this long (refresh-proof)
  log = console.log,
} = {}) {
  await RAPIER.init();
  const db = openDb(dataDir);
  const rooms = createRooms({ RAPIER, db, roomTtlMs, seatGraceMs, log });
  const root = resolve(staticDir);
  const compressed = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/health') return json(res, { ok: true, rooms: rooms.rooms.size });
      if (url.pathname === '/api/leaderboard') {
        const level = RACE_LEVELS.includes(url.searchParams.get('level')) ? url.searchParams.get('level') : RACE_LEVELS[0];
        const crew = Math.min(4, Math.max(1, Number(url.searchParams.get('crew')) || 4));
        return json(res, { level, crew, top: db.leaderboard(level, crew, 20), recent: db.recentGames(15) });
      }
      // which levels a name has finished / unlocked, with their best times
      if (url.pathname === '/api/progress') {
        const name = cleanName(url.searchParams.get('name'));
        const cleared = db.progress(name);
        return json(res, { name, cleared, unlocked: unlockedLevels(Object.keys(cleared)) });
      }
      // how many races have been run (overall, per level, per crew size, and yours) + recent ones
      if (url.pathname === '/api/history') {
        const name = cleanName(url.searchParams.get('name'));
        return json(res, { name, ...db.history(name, 50) });
      }
      // static files from the Vite build, falling back to index.html
      let file = normalize(join(root, decodeURIComponent(url.pathname)));
      if (file !== root && !file.startsWith(root + sep)) return send(res, 403, 'forbidden');
      const st = await stat(file).catch(() => null);
      if (st && st.isDirectory()) file = join(file, 'index.html');
      else if (!st) return send(res, 404, 'Nothing here. The game is at /'); // a real 404, so search engines don't index junk URLs
      const body = await readFile(file).catch(() => null);
      if (!body) return send(res, 404, 'Build the client first: npm run build');
      const ext = extname(file);
      const type = MIME[ext] || 'application/octet-stream';
      const cache = file.includes(`${root}${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
      const headers = { 'content-type': type, 'cache-control': cache, vary: 'accept-encoding' };
      // compress text (the game is a 4 MB script); kept in memory so it's only done once per file
      const accepts = String(req.headers['accept-encoding'] || '');
      const encoding = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null;
      if (encoding) {
        const key = `${encoding}:${file}:${body.length}`;
        if (!compressed.has(key)) {
          compressed.set(key, encoding === 'br' ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9 } }) : gzipSync(body));
        }
        headers['content-encoding'] = encoding;
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : compressed.get(key));
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      log('http error', err);
      send(res, 500, 'error');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
  wss.on('connection', (ws) => {
    let room = null;
    let seat = null;
    let budget = 0;
    let budgetAt = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    const reply = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
    const fail = (code) => reply({ t: 'error', code });
    const seated = (r, res) => {
      if (res.error) return fail(res.error);
      room = r;
      seat = res.seat;
      reply({ t: 'welcome', code: r.code, seat, token: res.token });
      reply({ t: 'room', room: r.roomState() });
    };

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      // flood guard for inputs only (a well-behaved client sends ~60/s); control messages
      // like start / lobby / leave must never be dropped
      if (msg.t === 'input') {
        const now = Date.now();
        if (now - budgetAt > 1000) (budget = 0), (budgetAt = now);
        if (++budget > 240) return;
      }

      if (msg.t === 'create' || msg.t === 'join' || msg.t === 'rejoin') {
        if (room) return fail('already-in-room');
        if (msg.t === 'rejoin') {
          const r = rooms.get(msg.code);
          return r ? seated(r, r.rejoin(String(msg.token || ''), ws)) : fail('room-not-found');
        }
        const name = cleanName(msg.name);
        if (!name) return fail('bad-name');
        if (msg.t === 'create') {
          const r = rooms.create();
          return seated(r, r.addPlayer(name, ws));
        }
        const r = rooms.get(String(msg.code || '').trim());
        return r ? seated(r, r.addPlayer(name, ws)) : fail('room-not-found');
      }

      if (!room) return;
      switch (msg.t) {
        case 'input': return room.input(seat, msg);
        case 'start': { const r = room.start(seat, typeof msg.level === 'string' ? msg.level : undefined); return r.error && fail(r.error); }
        case 'level': { const r = room.chooseLevel(seat, String(msg.level)); return r.error && fail(r.error); }
        case 'lobby': { const r = room.toLobby(seat); return r.error && fail(r.error); }
        case 'respawn': return room.respawn();
        case 'leave':
          room.leave(seat, ws);
          room = null;
          seat = null;
          return reply({ t: 'left' });
      }
    });

    ws.on('close', () => room && room.disconnect(seat, ws));
  });

  // drop dead connections (laptop lid closed, wifi gone) so their seats free up
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000);

  // fixed-timestep loop for every room, driven by the wall clock
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000) * simSpeed;
    last = now;
    while (acc >= DT) {
      rooms.step();
      acc -= DT;
    }
    rooms.sweep(Date.now());
  }, 1000 / 120);

  await new Promise((ok) => server.listen(port, host, ok));
  const actualPort = server.address().port;
  log(`Bottoms Up! server on http://${host}:${actualPort} (data in ${resolve(dataDir)})`);

  return {
    port: actualPort,
    rooms,
    db,
    async close() {
      clearInterval(loop);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise((ok) => server.close(ok));
      for (const r of [...rooms.rooms.values()]) r.close();
      db.close();
    },
  };
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function send(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(text);
}
