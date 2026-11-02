// Renders public/og.jpg, the 1200x630 picture shown when a link to the game is shared, from the
// real game in headless Chrome. Usage: npm run build && node scripts/og-image.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = mkdtempSync(join(tmpdir(), 'bottoms-og-'));
const profile = mkdtempSync(join(tmpdir(), 'bottoms-og-chrome-'));
const server = await startServer({ port: 0, dataDir, log: () => {} });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9335', `--user-data-dir=${profile}`, '--no-first-run', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  wsUrl = await fetch('http://127.0.0.1:9335/json/version').then((r) => r.json()).then((j) => j.webSocketDebuggerUrl).catch(() => null);
}
const cdp = new WebSocket(wsUrl);
await new Promise((r) => cdp.on('open', r));
let id = 1;
const pending = new Map();
cdp.on('message', (d) => {
  const m = JSON.parse(d);
  if (pending.has(m.id)) pending.get(m.id)(m.result), pending.delete(m.id);
});
const send = (method, params = {}, sessionId) =>
  new Promise((ok) => {
    const i = id++;
    pending.set(i, ok);
    cdp.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await send('Page.navigate', { url: `http://127.0.0.1:${server.port}/?cam=close` }, sessionId);
  await sleep(3000);
  const ev = async (e) => (await send('Runtime.evaluate', { expression: `(async()=>{${e}})()`, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  await ev(`document.getElementById('solo').click();`);
  // wait for GO (software rendering is slow, so go by the game's own state)
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if ((await ev(`return __toot.state.phase`)) === 'playing') break;
  }
  await sleep(1500);
  // no game UI, just the raft and the title
  await ev(`
    const style = document.createElement('style');
    style.textContent = '#hud, .mute-btn, .about-btn, .tag-layer { display: none !important; }';
    document.head.append(style);
    const title = document.createElement('div');
    title.style.cssText = 'position:fixed;left:56px;top:50%;transform:translateY(-50%);z-index:99;color:#fff;font-family:ui-rounded,system-ui,sans-serif;text-shadow:0 4px 0 rgba(18,48,74,.55),0 10px 30px rgba(18,48,74,.4);max-width:520px';
    title.innerHTML = '<div style="font-size:92px;font-weight:900;line-height:1">Bottoms Up!</div><div style="font-size:34px;font-weight:800;margin-top:14px;line-height:1.2">One round raft.<br>Up to four friends.<br>Only farts for power.</div>';
    document.body.append(title);
    const k = (t, code) => dispatchEvent(new KeyboardEvent(t, { code }));
    k('keydown', 'KeyC'); k('keydown', 'KeyV');
  `);
  await sleep(1800);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const png = join(dataDir, 'og.png');
  writeFileSync(png, Buffer.from(data, 'base64'));
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', 'public/og.jpg'], { stdio: 'ignore' });
  console.log('saved public/og.jpg');
} finally {
  cdp.close();
  chrome.kill();
  await server.close();
  await sleep(500);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
