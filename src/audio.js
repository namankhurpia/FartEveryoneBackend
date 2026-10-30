// Synthesised sound effects (no audio files). Farts come from fartsynth.js; each player
// has their own voice, a few variations of it, a sputter tail and a "deflate" for running dry.

import { VOICES, synthFart } from './fartsynth.js';

const VARIANTS = 3;

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false; // set on master, which every sound goes through; remembered between visits
  try {
    muted = localStorage.getItem('tootraft.muted') === '1';
  } catch {}
  let bank = null; // bank[player] = { hold: [AudioBuffer], tail: [AudioBuffer], deflate: AudioBuffer }
  const voices = [];
  const tails = [];

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
    const toBuffer = (data) => {
      const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.copyToChannel(data, 0);
      return b;
    };
    const sr = ctx.sampleRate;
    bank = VOICES.map((v, p) => ({
      hold: Array.from({ length: VARIANTS }, (_, k) => toBuffer(synthFart(sr, v, { mode: 'hold', seed: p * 10 + k + 1 }))),
      tail: Array.from({ length: VARIANTS }, (_, k) => toBuffer(synthFart(sr, v, { mode: 'tail', seed: p * 10 + k + 5 }))),
      deflate: toBuffer(synthFart(sr, v, { mode: 'deflate', seed: p + 3 })),
    }));
    return true;
  }
  addEventListener('keydown', ensure);
  addEventListener('pointerdown', ensure);

  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  function play(buffer, { rate = 1, gain = 1, when = 0 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start(when || ctx.currentTime);
    return { src, gain: g };
  }

  function fartStart(player) {
    if (!ctx || ctx.state !== 'running' || !bank) return;
    stopVoice(player, 0.02);
    stopTail(player);
    const rate = 0.92 + Math.random() * 0.16;
    voices[player] = { ...play(pick(bank[player].hold), { rate }), started: ctx.currentTime, rate };
  }

  function stopVoice(player, fade) {
    const v = voices[player];
    if (!v) return null;
    voices[player] = null;
    const now = ctx.currentTime;
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + fade);
    v.src.stop(now + fade + 0.01);
    return v;
  }

  function stopTail(player) {
    if (!tails[player]) return;
    try {
      tails[player].src.stop();
    } catch {}
    tails[player] = null;
  }

  function fartEnd(player) {
    if (!ctx || !bank) return;
    const v = stopVoice(player, 0.05);
    // anything longer than a tap ends with a little "pbbt-pt"
    if (v && ctx.currentTime - v.started > 0.25) {
      tails[player] = play(pick(bank[player].tail), { rate: v.rate, gain: 0.8, when: ctx.currentTime + 0.03 });
    }
  }

  // ran dry: swap the sputter for a sad deflating squeak
  function empty(player) {
    if (!ctx || !bank) return;
    stopTail(player);
    play(bank[player].deflate, { gain: 0.9 });
  }

  function blip(freqs, dur = 0.12, type = 'square', vol = 0.18) {
    if (!ctx || ctx.state !== 'running') return;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * dur;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.95);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur);
    });
  }

  // race start: a short beep per light, then a bright rising chord with a whoosh for GO
  function startBeep() {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 587; // D5
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.01);
    g.gain.setValueAtTime(0.16, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.32);
  }

  // fell off the edge: a cartoon slide whistle going down
  function fall() {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const vib = ctx.createOscillator();
    const vibAmt = ctx.createGain();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1400, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 1.1);
    vib.frequency.value = 9;
    vibAmt.gain.value = 25;
    vib.connect(vibAmt).connect(o.frequency);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.05);
    g.gain.setValueAtTime(0.18, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    o.connect(g).connect(master);
    o.start(t);
    vib.start(t);
    o.stop(t + 1.25);
    vib.stop(t + 1.25);
  }

  function startGo() {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    for (const [f, type, vol] of [[1175, 'square', 0.13], [1480, 'sawtooth', 0.06], [587, 'square', 0.08]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.06, t + 0.7);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.015);
      g.gain.setValueAtTime(vol, t + 0.55);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.95);
    }
    // whoosh: filtered noise sweeping up
    const src = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * 0.8);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(3500, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
  }

  return {
    fartStart,
    fartEnd,
    startBeep,
    startGo,
    fall,
    checkpoint: () => blip([660, 880], 0.1),
    finish: () => blip([523, 659, 784, 1047], 0.14),
    ouch: () => blip([220, 110], 0.16, 'sawtooth', 0.22),
    empty,
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.6;
      try {
        localStorage.setItem('tootraft.muted', muted ? '1' : '0');
      } catch {}
      return muted;
    },
    isMuted: () => muted,
  };
}
