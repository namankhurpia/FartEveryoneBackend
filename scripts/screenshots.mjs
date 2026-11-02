// Takes the README screenshots: starts a throwaway server (its own port and data folder),
// drives headless Chrome over the DevTools protocol as 4 players, and saves PNGs to
// docs/screenshots/. Usage: npm run build && npm run screenshots
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a throwaway server with a little history, so the boards and pages aren't empty
const dataDir = mkdtempSync(join(tmpdir(), 'bottoms-shots-'));
const server = await startServer({ port: 0, dataDir, log: () => {} });
const base = `http://127.0.0.1:${server.port}`;
const day = (d, h) => new Date(Date.UTC(2026, 9, d, h, 12)).toISOString();
const seed = [
  ['canal', ['Naman', 'Priya', 'Arjun', 'Sam'], 64200, 'Oct 20'],
  ['canal', ['Naman', 'Priya'], 81900, 'Oct 21'],
  ['canal', ['Zoe', 'Kai', 'Lena', 'Omar'], 70400, 'Oct 22'],
  ['plank', ['Naman', 'Priya', 'Arjun', 'Sam'], 66100, 'Oct 23'],
  ['canal', ['Solo Steve'], 96000, 'Oct 24'],
  ['plank', ['Zoe', 'Kai', 'Lena', 'Omar'], 74800, 'Oct 25'],
  ['canal', ['Mia', 'Raj', 'Tom'], 77300, 'Oct 26'],
];
seed.forEach(([level, players, timeMs], i) => {
  const par = { canal: 75, plank: 70 }[level];
  server.db.saveGame({ level, room: '1234', players, crewSize: players.length, timeMs, points: Math.round((1000 * par * 1000) / timeMs), deaths: i % 3, startedAt: day(20 + i, 18), finishedAt: day(20 + i, 19) });
});

// --- headless Chrome + a tiny DevTools-protocol client
const profile = mkdtempSync(join(tmpdir(), 'bottoms-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--no-first-run',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800', '--hide-scrollbars', '--mute-audio',
], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  wsUrl = await fetch('http://127.0.0.1:9333/json/version').then((r) => r.json()).then((j) => j.webSocketDebuggerUrl).catch(() => null);
}
const cdp = new WebSocket(wsUrl);
await new Promise((r) => cdp.on('open', r));
let nextId = 1;
const pending = new Map();
cdp.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) {
    const { ok, fail } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? fail(new Error(m.error.message)) : ok(m.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, { ok, fail });
    cdp.send(JSON.stringify({ id, method, params, sessionId }));
  });

async function openTab({ width = 1280, height = 800, mobile = false } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile }, sessionId);
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  // headless tabs count as hidden; keep their frames running like a real foreground tab
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  const tab = {
    sessionId,
    eval: async (expr) => (await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, sessionId)).result.value,
    go: async (url) => {
      await send('Page.navigate', { url }, sessionId);
      await sleep(2500);
    },
    shot: async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
      console.log('saved docs/screenshots/' + name);
    },
    key: (code, down = true) => send('Runtime.evaluate', { expression: `dispatchEvent(new KeyboardEvent('${down ? 'keydown' : 'keyup'}', { code: '${code}' }))` }, sessionId),
  };
  return tab;
}

try {
  // 1. start page with leaderboard
  const host = await openTab();
  await host.go(base);
  await host.eval(`document.getElementById('name').value = 'Naman';`);
  await sleep(800);
  await host.shot('start.png');

  // 2. levels page and race history
  await host.eval(`document.getElementById('play-single').click();`);
  await sleep(1200);
  await host.shot('levels.png');
  await host.eval(`document.querySelector('#levels-page [data-back]').click(); document.getElementById('open-history').click();`);
  await sleep(1200);
  await host.shot('history.png');
  await host.eval(`document.querySelector('#history-page [data-back]').click();`);

  // 3. a room with 4 players paddling in the practice pond
  await host.eval(`document.getElementById('create').click();`);
  await sleep(1500);
  const code = await host.eval(`return __toot.online.room.code;`);
  const friends = [];
  for (const name of ['Priya', 'Arjun', 'Sam']) {
    const t = await openTab();
    await t.go(base);
    await t.eval(`document.getElementById('name').value = '${name}'; document.getElementById('code').value = '${code}'; document.getElementById('join').click();`);
    friends.push(t);
    await sleep(900);
  }
  await sleep(1500);
  await host.shot('lobby.png');

  // 4. the F1 start lights, then the race with some farting
  await host.eval(`document.getElementById('start').click();`);
  await sleep(2400);
  await host.shot('start-lights.png');
  await sleep(1600);
  for (const t of [host, ...friends]) await t.key('Space');
  await sleep(900);
  await host.shot('race.png');
  for (const t of [host, ...friends]) await t.key('Space', false);

  // 5. the drop levels, in solo practice (unlocked for Naman by the seeded games)
  for (const [i, file, x, y] of [[1, 'level2.png', 0, 30], [2, 'level3.png', 76, 40]]) {
    const t = await openTab();
    await t.go(base);
    await t.eval(`document.getElementById('name').value = 'Naman'; document.getElementById('play-single').click();`);
    await sleep(1200);
    await t.go(base + '/?practice');
    await sleep(4300);
    await t.eval(`document.getElementById('help').classList.add('hidden'); __toot.sim.debugPlace(${x}, ${y}, 0);`);
    await sleep(1500);
    await t.shot(file);
  }

  // 6. a close-up of the raft and crew
  const close = await openTab();
  await close.go(base + '/?cam=close&practice');
  await sleep(4500);
  for (const k of ['KeyC', 'KeyV']) await close.key(k);
  await sleep(500);
  await close.shot('raft.png');
  for (const k of ['KeyC', 'KeyV']) await close.key(k, false);

  // 7. on a phone: the lobby with the joystick and fart button
  const phone = await openTab({ width: 390, height: 844, mobile: true });
  await phone.go(base);
  await phone.eval(`document.getElementById('name').value = 'Zoe'; document.getElementById('create').click();`);
  await sleep(2500);
  await phone.shot('phone.png');
  // README-friendly: JPEGs about a tenth the size of the PNGs (macOS's sips)
  if (process.platform === 'darwin') {
    const { execFileSync } = await import('node:child_process');
    const { readdirSync, unlinkSync } = await import('node:fs');
    for (const f of readdirSync(OUT).filter((f) => f.endsWith('.png'))) {
      const width = f === 'phone.png' ? 700 : 1600;
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(width), join(OUT, f), '--out', join(OUT, f.replace('.png', '.jpg'))], { stdio: 'ignore' });
      unlinkSync(join(OUT, f));
    }
    console.log('converted to JPEG');
  }
} finally {
  cdp.close();
  chrome.kill();
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
