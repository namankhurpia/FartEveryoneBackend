// three.js view of the sim. Reads snapshots only, never touches physics.
// Sim (x, y) maps to three (x, height, -y); sim angle maps to rotation.y.

import * as THREE from 'three';
import { ALL_SEATS, NUM_PLAYERS, RAFT, RING_THICK, WINDMILL_ARM, WINDMILL_TOWER, arcFor, ringSegments, seatAt } from './sim/sim.js';

export const PLAYER_COLORS = ['#ff5a5f', '#3fa7ff', '#ffc93c', '#5ad16a'];
const DECK_Y = 0.42; // the crew sit on the raft's tube
const CREW_SCALE = 0.85; // a little smaller than the raft's tube is wide, so they look seated in it

export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fdcf5');
  scene.fog = new THREE.Fog('#9fdcf5', 45, 110);

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 300);
  const camOffset = new THREE.Vector3(0, 24, 15);
  const camTarget = new THREE.Vector3();
  let shake = 0;

  scene.add(new THREE.HemisphereLight('#ffffff', '#3a6f8f', 1.6));
  const sun = new THREE.DirectionalLight('#fff4dd', 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  // --- water -------------------------------------------------------------
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color('#1b7bb4') },
        uShallow: { value: new THREE.Color('#47c2e8') },
      },
      vertexShader: /* glsl */ `
        varying vec2 vW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; varying vec2 vW;
        void main() {
          float a = sin(vW.x * 0.35 + uTime * 0.8) * sin(vW.y * 0.3 - uTime * 0.6);
          float b = sin((vW.x + vW.y) * 0.9 + uTime * 1.7);
          vec3 c = mix(uDeep, uShallow, 0.5 + 0.35 * a + 0.12 * b);
          float s = smoothstep(0.86, 0.97, sin(vW.x * 1.7 + uTime) * sin(vW.y * 1.9 - uTime * 1.3));
          gl_FragColor = vec4(c + s * 0.18, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  scene.add(water);
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.22 }),
  );
  shadowCatcher.position.y = 0.01;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  const toWorld = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
  const shadowed = (m) => ((m.castShadow = true), (m.receiveShadow = true), m);

  const woodDark = mat('#7a4a24');
  const woodLight = mat('#b07a45');

  // Everything that belongs to one level lives in this group, so switching levels
  // (lobby pond <-> race) swaps it out inside the same WebGL context.
  let levelGroup = null;
  let flags = [];
  let currentTextures = [];
  let moverMeshes = [];
  let wellGlows = [];

  // A windmill: a tower with arms sweeping round, spikes hanging from them down to the water.
  function buildWindmill(g, m, metal) {
    const tower = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(WINDMILL_TOWER * 0.7, WINDMILL_TOWER, 4.2, 12), mat('#6b5a4a', { roughness: 0.9 })));
    tower.position.y = 2.1;
    const cap = shadowed(new THREE.Mesh(new THREE.ConeGeometry(WINDMILL_TOWER + 0.25, 1, 12), mat('#8f1d1d')));
    cap.position.y = 4.7;
    g.add(tower, cap);
    const beamMat = mat('#4a3322', { roughness: 0.85 });
    const sailMat = mat('#f1ead9', { roughness: 0.9, side: THREE.DoubleSide });
    const spikeGeo = new THREE.ConeGeometry(0.16, 1.5, 6).rotateX(Math.PI); // points down
    for (let k = 0; k < m.blades; k++) {
      const arm = new THREE.Group();
      arm.rotation.y = (k * 2 * Math.PI) / m.blades;
      const beam = shadowed(new THREE.Mesh(new THREE.BoxGeometry(m.radius, 0.22, 0.22), beamMat));
      beam.position.set(m.radius / 2, 3.6, 0);
      const sail = shadowed(new THREE.Mesh(new THREE.BoxGeometry(m.radius * 0.75, 0.05, WINDMILL_ARM + 0.15), sailMat));
      sail.position.set(m.radius * 0.58, 3.78, 0);
      arm.add(beam, sail);
      const n = Math.max(3, Math.round(m.radius / 0.75));
      for (let i = 1; i <= n; i++) {
        const x = (i / n) * (m.radius - 0.15);
        // a rod from the beam down to the spike, whose tip touches the water
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.1), beamMat);
        rod.position.set(x, 2.55, 0);
        const spike = shadowed(new THREE.Mesh(spikeGeo, metal));
        spike.position.set(x, 0.75, 0);
        arm.add(rod, spike);
      }
      g.add(arm);
    }
  }

  // A spike circle: spikes all the way round, with bright posts marking the two openings.
  function buildRing(g, m, metal) {
    const baseMat = mat('#8f1d1d');
    const spikeGeo = new THREE.ConeGeometry(0.17, 0.75, 6);
    const segs = ringSegments(m);
    for (const s of segs) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(s.len, 0.22, RING_THICK), baseMat);
      base.position.set(Math.cos(s.a) * m.r, 0.1, -Math.sin(s.a) * m.r);
      base.rotation.y = s.a + Math.PI / 2;
      const spike = shadowed(new THREE.Mesh(spikeGeo, metal));
      spike.position.set(Math.cos(s.a) * m.r, 0.55, -Math.sin(s.a) * m.r);
      g.add(base, spike);
    }
    const postMat = mat('#ffb020', { emissive: '#ff8a00', emissiveIntensity: 0.4 });
    const halfGap = (m.gapDeg * Math.PI) / 360;
    for (const d of m.gaps) {
      for (const side of [-1, 1]) {
        const a = (d * Math.PI) / 180 + side * halfGap;
        const post = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 1.5, 8), postMat));
        post.position.set(Math.cos(a) * m.r, 0.75, -Math.sin(a) * m.r);
        g.add(post);
      }
    }
  }

  function buildLevel(level) {
    const lg = new THREE.Group();
    // --- docks (walls) -------------------------------------------------------
    for (const w of level.walls) {
      const base = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w.w, 0.7, w.h), woodDark));
      base.position.copy(toWorld(w.x, w.y, 0.15));
      const top = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.1, 0.12, w.h + 0.1), woodLight));
      top.position.copy(toWorld(w.x, w.y, 0.56));
      lg.add(base, top);
      const long = Math.max(w.w, w.h);
      const posts = Math.floor(long / 4);
      for (let i = 0; i <= posts; i++) {
        const t = posts ? i / posts - 0.5 : 0;
        const px = w.w >= w.h ? w.x + t * (w.w - 0.4) : w.x;
        const py = w.w >= w.h ? w.y : w.y + t * (w.h - 0.4);
        const post = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 1.3, 8), woodDark));
        post.position.copy(toWorld(px, py, 0.5));
        lg.add(post);
      }
    }

    // --- spikes ----------------------------------------------------------------
    const metal = mat('#c7ccd6', { metalness: 0.6, roughness: 0.35 });
    const danger = mat('#e8463c');
    const cone = new THREE.ConeGeometry(0.17, 0.6, 6);
    for (const s of level.spikes) {
      const base = shadowed(new THREE.Mesh(new THREE.BoxGeometry(s.w, 0.2, s.h), danger));
      base.position.copy(toWorld(s.x, s.y, 0.42));
      lg.add(base);
      const alongX = s.w >= s.h;
      const long = alongX ? s.w : s.h;
      const n = Math.floor(long / 0.5);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const c = shadowed(new THREE.Mesh(cone, metal));
        c.position.copy(toWorld(s.x + (alongX ? t * long : 0), s.y + (alongX ? 0 : t * long), 0.8));
        lg.add(c);
      }
    }

    // --- checkpoints & finish ----------------------------------------------------
    const poleMat = mat('#f4f4f4');
    const flags = [];
    const zoneEnds = (z) =>
      z.w >= z.h
        ? [{ x: z.x - z.w / 2, y: z.y }, { x: z.x + z.w / 2, y: z.y }]
        : [{ x: z.x, y: z.y - z.h / 2 }, { x: z.x, y: z.y + z.h / 2 }];
    level.checkpoints.forEach((cp, i) => {
      if (!cp.zone) return;
      const flagMat = mat('#ffffff', { side: THREE.DoubleSide });
      for (const end of zoneEnds(cp.zone)) {
        const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6), poleMat));
        pole.position.copy(toWorld(end.x, end.y, 1.3));
        const flag = shadowed(new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), flagMat));
        flag.position.copy(toWorld(end.x, end.y, 2.3)).add(new THREE.Vector3(0.45, 0, 0));
        lg.add(pole, flag);
      }
      flags[i] = flagMat;
    });

    const checker = document.createElement('canvas');
    checker.width = 256;
    checker.height = 32;
    const cg = checker.getContext('2d');
    for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
      cg.fillStyle = (x + y) % 2 ? '#111' : '#fff';
      cg.fillRect(x * 16, y * 16, 16, 16);
    }
    const checkerTex = new THREE.CanvasTexture(checker);
    checkerTex.colorSpace = THREE.SRGBColorSpace;
    if (level.finish) {
      const f = level.finish;
      const ends = zoneEnds(f);
      for (const end of ends) {
        const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 4), poleMat));
        pole.position.copy(toWorld(end.x, end.y, 2));
        lg.add(pole);
      }
      const span = Math.max(f.w, f.h);
      const banner = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.9, span), mat('#ffffff', { map: checkerTex })));
      banner.position.copy(toWorld(f.x, f.y, 3.7));
      if (f.w >= f.h) banner.rotation.y = Math.PI / 2;
      lg.add(banner);
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(span, 0.6).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: checkerTex, transparent: true, opacity: 0.85 }),
      );
      line.position.copy(toWorld(f.x, f.y, 0.03));
      if (f.w < f.h) line.rotation.y = Math.PI / 2;
      lg.add(line);
    }

    // --- currents ------------------------------------------------------------
    const chevron = document.createElement('canvas');
    chevron.width = chevron.height = 64;
    const ch = chevron.getContext('2d');
    ch.strokeStyle = 'rgba(255,255,255,0.75)';
    ch.lineWidth = 7;
    ch.lineCap = 'round';
    ch.beginPath();
    ch.moveTo(14, 22);
    ch.lineTo(32, 42);
    ch.lineTo(50, 22);
    ch.stroke();
    const currentTextures = [];
    // a level-wide river shows its arrows on all of the water
    const flowing = level.flow ? level.water.map((r) => ({ ...r, ...level.flow })) : [];
    for (const c of [...level.currents, ...flowing]) {
      const tex = new THREE.CanvasTexture(chevron);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      // the plane gets turned to point along the flow, so a sideways one swaps its width and height
      const sideways = Math.abs(c.ax) > Math.abs(c.ay);
      const pw = sideways ? c.h : c.w;
      const ph = sideways ? c.w : c.h;
      tex.repeat.set(pw / 2.5, ph / 2.5);
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(pw, ph).rotateX(-Math.PI / 2),
        // stronger currents get bolder, faster arrows
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: Math.min(0.85, 0.3 + Math.hypot(c.ax, c.ay) * 0.12), depthWrite: false }),
      );
      plane.position.copy(toWorld(c.x, c.y, 0.02));
      // chevrons point down the texture (+v). Rotate so they point along the current.
      const flowAngle = Math.atan2(c.ay, c.ax); // sim angle of the flow
      plane.rotation.y = flowAngle + Math.PI / 2;
      lg.add(plane);
      currentTextures.push({ tex, speed: Math.hypot(c.ax, c.ay) * 0.12 });
    }

    // --- movers -----------------------------------------------------------------
    const barrierTex = (() => {
      const cv = document.createElement('canvas');
      cv.width = 128;
      cv.height = 16;
      const g = cv.getContext('2d');
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 ? '#ffffff' : '#ff6b3d';
        g.fillRect(i * 16, 0, 16, 16);
      }
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const moverMeshes = level.movers.map((m) => {
      const g = new THREE.Group();
      if (m.type === 'windmill') buildWindmill(g, m, metal);
      else if (m.type === 'ring') buildRing(g, m, metal);
      else if (m.type === 'rotor') {
        const log = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(m.h / 2, m.h / 2, m.w, 14).rotateZ(Math.PI / 2), mat('#8a5a33')));
        log.position.y = 0.35;
        const hub = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.6, 12), woodDark));
        hub.position.y = 0.4;
        g.add(log, hub);
      } else if (m.spiky) {
        // a spiked beam: dark red bar with steel spikes sticking out of both long sides
        const len = Math.max(m.w, m.h);
        const thick = Math.min(m.w, m.h);
        const bar = new THREE.Group();
        const beam = shadowed(new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, thick), mat('#8f1d1d', { metalness: 0.3, roughness: 0.5 })));
        beam.position.y = 0.3;
        bar.add(beam);
        const n = Math.floor(len / 0.45);
        for (const side of [-1, 1]) {
          for (let k = 0; k < n; k++) {
            const spike = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.45, 6).rotateX((side * Math.PI) / 2), metal));
            spike.position.set(-len / 2 + (k + 0.5) * (len / n), 0.35, side * (thick / 2 + 0.2));
            bar.add(spike);
          }
        }
        if (m.h > m.w) bar.rotation.y = Math.PI / 2;
        g.add(bar);
      } else {
        const tex = barrierTex.clone();
        tex.wrapS = THREE.RepeatWrapping;
        tex.repeat.set(Math.max(m.w, m.h) / 2, 1);
        const box = shadowed(new THREE.Mesh(new THREE.BoxGeometry(Math.max(m.w, m.h), 0.75, Math.min(m.w, m.h)), mat('#ffffff', { map: tex })));
        box.position.y = 0.3;
        if (m.h > m.w) box.rotation.y = Math.PI / 2;
        g.add(box);
      }
      lg.add(g);
      return g;
    });

    // --- wells: holes in the track, glowing from somewhere far below ---------------
    const wellGlows = [];
    for (const w of level.wells || []) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      grad.addColorStop(0, '#000000');
      grad.addColorStop(0.45, '#2a0500');
      grad.addColorStop(0.8, '#a81e05');
      grad.addColorStop(1, '#ff7a1a');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const hole = new THREE.Mesh(new THREE.CircleGeometry(w.r, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex }));
      hole.position.copy(toWorld(w.x, w.y, 0.04));
      const rim = shadowed(new THREE.Mesh(new THREE.TorusGeometry(w.r, 0.16, 8, 40).rotateX(Math.PI / 2), mat('#3a3f47', { roughness: 0.95 })));
      rim.position.copy(toWorld(w.x, w.y, 0.08));
      const glow = new THREE.Mesh(
        new THREE.RingGeometry(w.r, w.r + 0.55, 40).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#ff5a1f', transparent: true, opacity: 0.35, depthWrite: false }),
      );
      glow.position.copy(toWorld(w.x, w.y, 0.05));
      lg.add(hole, rim, glow);
      wellGlows.push(glow.material);
    }

    // --- a drop: water channels on stone towers over a misty chasm ---------------
    if (level.water) {
      const stone = mat('#8d939e', { roughness: 0.95 });
      const lip = mat('#b9bec7', { roughness: 0.9 });
      for (const r of level.water) {
        const surface = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h).rotateX(-Math.PI / 2), water.material);
        surface.position.copy(toWorld(r.x, r.y, 0));
        const catcher = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.22 }));
        catcher.position.copy(toWorld(r.x, r.y, 0.01));
        catcher.receiveShadow = true;
        const tower = new THREE.Mesh(new THREE.BoxGeometry(r.w + 0.5, -FLOOR, r.h + 0.5), stone);
        tower.position.copy(toWorld(r.x, r.y, FLOOR / 2 - 0.06));
        const edge = new THREE.Mesh(new THREE.BoxGeometry(r.w + 0.7, 0.25, r.h + 0.7), lip);
        edge.position.copy(toWorld(r.x, r.y, -0.2));
        lg.add(surface, catcher, tower, edge);
      }
      buildValley(lg, level);
    }

    // --- scenery: little islands outside the canal --------------------------------
    if (!level.water) {
      let seed = 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const b = level.bounds;
      const inCanal = (x, y) => x > b.minX - 3 && x < b.maxX + 3 && y > b.minY - 3 && y < b.maxY + 3;
      const sand = mat('#f2d79b');
      const leaf = mat('#3fae5a');
      const trunk = mat('#7a4a24');
      for (let i = 0; i < 90; i++) {
        const x = b.minX - 35 + rand() * (b.maxX - b.minX + 70);
        const y = b.minY - 30 + rand() * (b.maxY - b.minY + 60);
        if (inCanal(x, y)) continue;
        const r = 1.5 + rand() * 3;
        const island = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, 0.6, 18), sand));
        island.position.copy(toWorld(x, y, 0.05));
        lg.add(island);
        const trees = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < trees; k++) {
          const tx = x + (rand() - 0.5) * r;
          const ty = y + (rand() - 0.5) * r;
          const h = 1.6 + rand() * 1.6;
          const t1 = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, h), trunk));
          t1.position.copy(toWorld(tx, ty, 0.3 + h / 2));
          const top = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(0.7 + rand() * 0.5, 0), leaf));
          top.position.copy(toWorld(tx, ty, 0.4 + h));
          lg.add(t1, top);
        }
      }
    }
    return { lg, flags, currentTextures, moverMeshes, wellGlows };
  }

  // Far below the water channels of levels with a drop: a hazy valley with a winding river,
  // pine trees, rock spires reaching up towards you and layers of mist. Seeded, so every
  // player sees the same valley.
  const FLOOR = -46;
  function buildValley(lg, level) {
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const b = level.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) + 160;
    // keep spires out from under the channels so nothing pokes through
    const nearWater = (x, y, pad) => level.water.some((r) => Math.abs(x - r.x) < r.w / 2 + pad && Math.abs(y - r.y) < r.h / 2 + pad);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(span, span).rotateX(-Math.PI / 2), mat('#4d6a44', { roughness: 1 }));
    ground.position.copy(toWorld(cx, cy, FLOOR));
    lg.add(ground);

    // a river winding along the valley floor
    const riverMat = mat('#3c8fc4', { roughness: 0.4, metalness: 0.1 });
    let px = cx - span / 2;
    let py = cy + Math.sin(0) * 18;
    for (let k = 1; k <= 60; k++) {
      const x = cx - span / 2 + (k / 60) * span;
      const y = cy + Math.sin(k * 0.35) * 18 + Math.sin(k * 0.13) * 10;
      const len = Math.hypot(x - px, y - py);
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len + 1.5, 0.2, 4.5), riverMat);
      seg.position.copy(toWorld((x + px) / 2, (y + py) / 2, FLOOR + 0.1));
      seg.rotation.y = Math.atan2(y - py, x - px);
      lg.add(seg);
      [px, py] = [x, y];
    }

    // rock spires, some tall enough to loom just below the channels
    const rockMats = ['#7b7266', '#8a8277', '#6b645b'].map((c) => mat(c, { roughness: 1, flatShading: true }));
    for (let i = 0; i < 70; i++) {
      const x = cx + (rand() - 0.5) * span * 0.8;
      const y = cy + (rand() - 0.5) * span * 0.8;
      if (nearWater(x, y, 5)) continue;
      const h = 10 + rand() * 26;
      const r = 2 + rand() * 4;
      const spire = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5 + ((rand() * 3) | 0)), rockMats[i % 3]);
      spire.position.copy(toWorld(x, y, FLOOR + h / 2));
      spire.rotation.y = rand() * Math.PI;
      lg.add(spire);
    }

    // pine trees on the valley floor
    const pine = mat('#2f5a34', { roughness: 1, flatShading: true });
    const trunkMat = mat('#5a3d24');
    const pineGeo = new THREE.ConeGeometry(1.4, 4.5, 6);
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.3, 1.2);
    for (let i = 0; i < 220; i++) {
      const x = cx + (rand() - 0.5) * span * 0.85;
      const y = cy + (rand() - 0.5) * span * 0.85;
      const s = 0.7 + rand() * 0.9;
      const top = new THREE.Mesh(pineGeo, pine);
      top.scale.setScalar(s);
      top.position.copy(toWorld(x, y, FLOOR + 1.2 * s + 2.25 * s));
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.scale.setScalar(s);
      trunk.position.copy(toWorld(x, y, FLOOR + 0.6 * s));
      lg.add(top, trunk);
    }

    // drifting mist layers between you and the bottom
    for (const [h, o] of [[-12, 0.1], [-24, 0.14], [-36, 0.18]]) {
      const mist = new THREE.Mesh(
        new THREE.PlaneGeometry(span, span).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#e8f0f7', transparent: true, opacity: o, depthWrite: false }),
      );
      mist.position.copy(toWorld(cx, cy, h));
      lg.add(mist);
    }
  }

  function setLevel(level) {
    if (levelGroup) {
      scene.remove(levelGroup);
      levelGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        for (const m of [].concat(o.material || [])) {
          if (m.map) m.map.dispose();
          if (m !== woodDark && m !== woodLight && m !== water.material) m.dispose();
        }
      });
    }
    const built = buildLevel(level);
    levelGroup = built.lg;
    flags = built.flags;
    currentTextures = built.currentTextures;
    moverMeshes = built.moverMeshes;
    wellGlows = built.wellGlows;
    scene.add(levelGroup);
    // levels with a drop swap the open sea for a misty chasm (and back again for the others)
    const chasm = !!level.water;
    water.visible = !chasm;
    shadowCatcher.visible = !chasm;
    scene.background.set(chasm ? '#7d9bb6' : '#9fdcf5');
    scene.fog.color.set(chasm ? '#7d9bb6' : '#9fdcf5');
    scene.fog.near = chasm ? 40 : 45;
    scene.fog.far = chasm ? 150 : 110; // far enough to see the valley floor, hazy
    firstFrame = true;
  }

  // --- raft & crew ----------------------------------------------------------------
  const raft = new THREE.Group();
  const deck = new THREE.Group();
  raft.add(deck);
  scene.add(raft);
  // round deck: plank texture on the top, a log rim, and each player's quarter marked on the rim
  const R = RAFT.radius;
  // a whitewater raft: a matte orange tube (darker underneath, white stripe, chamber seams),
  // a raised drop-stitch floor so the inside reads as a tub, two inflated thwarts across the
  // middle, a grab rope, and a faint wake where it sits in the water
  const TUBE = 0.3; // tube thickness (radius)
  const skin = document.createElement('canvas');
  skin.width = 1024; // around the raft
  skin.height = 128; // around the tube: rows 0/128 = outer side, 32 = top, 64 = inner side, 96 = underside
  {
    const g = skin.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, '#ee5b16');
    grad.addColorStop(0.25, '#ff7a26');
    grad.addColorStop(0.5, '#e4521a');
    grad.addColorStop(0.78, '#9c3a0e');
    grad.addColorStop(1, '#ee5b16');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 128);
    g.fillStyle = '#f4f4f4';
    g.fillRect(0, 0, 1024, 5); // white stripe along the outer side
    g.fillRect(0, 123, 1024, 5);
    g.fillStyle = 'rgba(70, 20, 0, 0.35)';
    for (let k = 0; k < 4; k++) g.fillRect(k * 256 + 128, 0, 4, 128); // seams between the 4 air chambers
    // white bands wrapping round the tube, like the reflective tape on a real raft
    g.fillStyle = '#f7f7f7';
    for (let k = 0; k < 8; k++) g.fillRect(k * 128 + 54, 0, 20, 128);
  }
  const skinTex = new THREE.CanvasTexture(skin);
  skinTex.colorSpace = THREE.SRGBColorSpace;
  skinTex.anisotropy = 4;
  const rubber = mat('#ffffff', { map: skinTex, roughness: 0.75 });
  const tube = shadowed(new THREE.Mesh(new THREE.TorusGeometry(R - TUBE, TUBE, 20, 96).rotateX(Math.PI / 2), rubber));
  tube.position.y = 0.26;
  deck.add(tube);

  // a wooden floor of planks, raised to the tube's middle so the inside looks like a tub
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = floorCanvas.height = 512;
  {
    const g = floorCanvas.getContext('2d');
    const tones = ['#b98552', '#a8743f', '#c4915c', '#ae7a45', '#bd8a55', '#a36f3c', '#c28e58'];
    const w = 512 / 7;
    tones.forEach((tone, i) => {
      g.fillStyle = tone;
      g.fillRect(i * w, 0, w, 512);
      g.strokeStyle = 'rgba(90, 50, 20, 0.25)'; // wood grain
      g.lineWidth = 2;
      for (let k = 0; k < 5; k++) {
        const x = i * w + 8 + k * (w / 5) + Math.sin(i * 3 + k) * 4;
        g.beginPath();
        g.moveTo(x, 0);
        g.bezierCurveTo(x + 6, 170, x - 6, 340, x + 3, 512);
        g.stroke();
      }
      g.fillStyle = 'rgba(50, 25, 8, 0.65)'; // the gap between planks
      g.fillRect(i * w, 0, 4, 512);
      g.fillStyle = 'rgba(60, 35, 15, 0.8)'; // nail heads
      for (const y of [60, 452]) g.fillRect(i * w + w / 2 - 3, y, 6, 6);
    });
  }
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = 4;
  const floor = shadowed(new THREE.Mesh(
    new THREE.CylinderGeometry(R - TUBE * 1.5, R - TUBE * 1.5, 0.16, 48),
    [mat('#7a4a24'), mat('#ffffff', { map: floorTex, roughness: 0.85 }), mat('#7a4a24')],
  ));
  floor.position.y = 0.18;
  deck.add(floor);

  // inflated thwarts run from the middle to the tube along the borders between players'
  // slices, so they show how far round the rim you can walk (built in buildZones)
  const thwartMat = mat('#e8571a', { roughness: 0.75 });
  const thwartLen = R - TUBE * 2 + 0.05;
  const thwartGeo = new THREE.CapsuleGeometry(0.14, thwartLen - 0.28, 6, 12).rotateZ(Math.PI / 2).translate(thwartLen / 2, 0, 0);
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.22, 20);

  // a faint wake where the raft sits in the water, and a soft dark patch under it
  const foam = new THREE.Mesh(
    new THREE.RingGeometry(R - 0.05, R + 0.22, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false }),
  );
  foam.position.y = 0.03;
  raft.add(foam);
  const underShadow = new THREE.Mesh(
    new THREE.CircleGeometry(R + 0.2, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#0b3a5c', transparent: true, opacity: 0.22, depthWrite: false }),
  );
  underShadow.position.y = 0.02;
  raft.add(underShadow);
  const rope = new THREE.Mesh(new THREE.TorusGeometry(R - 0.02, 0.025, 6, 72).rotateX(Math.PI / 2), mat('#1f2329', { roughness: 0.9 }));
  rope.position.y = 0.36;
  deck.add(rope);
  for (let k = 0; k < 8; k++) {
    // little rope loops (the handles) around the outside of the tube
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.03, 6, 12), mat('#2b2f36'));
    loop.position.set(Math.cos(a) * (R + 0.02), 0.28, -Math.sin(a) * (R + 0.02));
    loop.rotation.y = a + Math.PI / 2;
    deck.add(loop);
  }
  // each player's slice of the rim, rebuilt whenever the crew (1-4 players) changes
  const zones = new THREE.Group();
  deck.add(zones);
  let zonesKey = '';
  function buildZones(crew) {
    const key = crew.join();
    if (key === zonesKey) return;
    zonesKey = key;
    for (const z of [...zones.children]) {
      zones.remove(z);
      if (z.geometry !== thwartGeo && z.geometry !== hubGeo) z.geometry.dispose();
      if (z.material !== woodDark && z.material !== thwartMat) z.material.dispose();
    }
    for (const i of crew) {
      const arc = arcFor(i, crew);
      const color = PLAYER_COLORS[i];
      // whole slice (faint) and the walkable part (stronger); a solo player walks the full ring
      const walk = arc.full ? [arc.lo, arc.hi] : [arc.min, arc.max];
      // the slice on the floor (faint) and the part you can walk along on top of the tube
      for (const [from, to, opacity, inner, outer, y] of [
        [arc.lo, arc.hi, 0.14, 0.3, R - TUBE * 1.5, 0.27],
        [walk[0], walk[1], 0.7, RAFT.rim - 0.06, RAFT.rim + 0.06, 0.57],
      ]) {
        const band = new THREE.Mesh(
          new THREE.RingGeometry(inner, outer, arc.full ? 64 : 24, 1, from, to - from).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
        );
        band.position.y = y;
        zones.add(band);
      }
      if (arc.full) continue; // alone: the whole rim is yours, no thwart
      // a thwart along the border where this slice starts
      const thwart = shadowed(new THREE.Mesh(thwartGeo, thwartMat));
      thwart.position.y = 0.32;
      thwart.rotation.y = arc.lo;
      zones.add(thwart);
    }
    if (crew.length > 1) {
      const hub = shadowed(new THREE.Mesh(hubGeo, thwartMat));
      hub.position.y = 0.32;
      zones.add(hub);
    }
  }
  buildZones(ALL_SEATS);
  const flash = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 0.15, R + 0.15, 0.05, 48),
    new THREE.MeshBasicMaterial({ color: '#ff2a2a', transparent: true, opacity: 0 }),
  );
  flash.position.y = 0.42;
  deck.add(flash);

  const tagLayer = document.createElement('div');
  tagLayer.className = 'tag-layer';
  container.append(tagLayer);

  const crew = PLAYER_COLORS.map((hex, i) => {
    const color = new THREE.Color(hex);
    const g = new THREE.Group();
    deck.add(g);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.62, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    ring.position.y = 0.02;
    g.add(ring);

    // thrust arrow (points +x, rotated to the aim)
    const shape = new THREE.Shape();
    shape.moveTo(1.15, 0);
    shape.lineTo(0.6, 0.28);
    shape.lineTo(0.6, -0.28);
    shape.closePath();
    const arrow = new THREE.Mesh(
      new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    );
    arrow.position.y = 0.05;
    g.add(arrow);

    const body = new THREE.Group();
    g.add(body);
    const blob = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.4, 20, 16), mat(color, { roughness: 0.55 })));
    blob.scale.set(1, 1.15, 1);
    blob.position.y = 0.46;
    body.add(blob);
    const white = mat('#ffffff', { roughness: 0.3 });
    const black = mat('#141414', { roughness: 0.3 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), white);
      eye.position.set(0.31, 0.62, side * 0.14);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), black);
      pupil.position.set(0.41, 0.62, side * 0.14);
      body.add(eye, pupil);
    }
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.3, 4).rotateX(Math.PI),
      new THREE.MeshBasicMaterial({ color }),
    );
    marker.position.y = 1.9;
    g.add(marker);

    // name tag: a small HTML pill in the player's colour that follows their head on screen
    // (HTML so it stays crisp and readable at any camera distance)
    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.style.setProperty('--c', hex);
    const tagName = document.createElement('span');
    tag.append(tagName);
    tagLayer.append(tag);

    return { g, ring, arrow, body, marker, tag, tagName, hex, squash: 0, occupied: true, drop: 1, tagKey: '', label: `P${i + 1}` };
  });

  // mine = this is you (online) or the player you're steering (solo): a thin white outline
  function drawTag(c, text, mine, online) {
    const key = `${text}|${mine}|${online}`;
    if (key === c.tagKey) return;
    c.tagKey = key;
    c.tagName.textContent = text; // other people's names: text only, never HTML
    c.tag.classList.toggle('mine', mine);
  }

  // seats: null (solo / menu: everyone present, tags read P1-P4) or [{ name, occupied }]
  // for online rooms. A seat that becomes occupied plays a drop-in-and-bounce.
  let tagsOn = true;
  let tagsOnline = false;
  function setSeats(seats, { tags = true } = {}) {
    tagsOn = tags;
    tagsOnline = !!seats;
    crew.forEach((c, i) => {
      const seat = seats && seats[i];
      const occupied = !seats || !!(seat && seat.occupied);
      if (occupied && !c.occupied) c.drop = 0;
      c.occupied = occupied;
      c.body.visible = occupied;
      c.arrow.visible = occupied;
      c.label = seats ? (occupied ? seat.name : '') : `P${i + 1}`;
      c.tagKey = '';
    });
  }

  // --- fart puffs -----------------------------------------------------------------
  const puffGeo = new THREE.SphereGeometry(1, 10, 8);
  const puffColors = ['#b9d86a', '#d7e38c', '#a6c25a', '#e2d6a0'].map((c) => new THREE.Color(c));
  const puffs = Array.from({ length: 260 }, () => {
    const m = new THREE.Mesh(puffGeo, new THREE.MeshLambertMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false;
    scene.add(m);
    return { m, life: 0, max: 1, vel: new THREE.Vector3(), size: 0.3 };
  });
  let puffCursor = 0;
  function spawnPuff(pos, vel, size, life) {
    const p = puffs[puffCursor];
    puffCursor = (puffCursor + 1) % puffs.length;
    p.m.position.copy(pos);
    p.vel.copy(vel);
    p.size = size;
    p.life = p.max = life;
    p.m.material.color.copy(puffColors[(Math.random() * puffColors.length) | 0]);
    p.m.visible = true;
  }

  // --- per-frame ------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let time = 0;
  let firstFrame = true;
  let focusShift = 0; // metres ahead of the raft to centre the view on (phones: room for the lobby card)
  const tmp = new THREE.Vector3();

  function render(prev, curr, alpha, frameDt, input) {
    time += frameDt;
    water.material.uniforms.uTime.value = time;
    for (const c of currentTextures) c.tex.offset.y += c.speed * frameDt;
    for (const w of wellGlows) w.opacity = 0.3 + 0.18 * Math.sin(time * 3.1);

    const rx = lerp(prev.raft.x, curr.raft.x, alpha);
    const ry = lerp(prev.raft.y, curr.raft.y, alpha);
    const ra = lerpAngle(prev.raft.angle, curr.raft.angle, alpha);
    // falling off the edge: the raft drops away into the chasm until it respawns
    const drop = curr.cause === 'fell' ? -16 * (1 - curr.respawn) ** 2 : 0;
    raft.position.copy(toWorld(rx, ry, Math.sin(time * 2.2) * 0.04 + drop));
    raft.rotation.y = ra;
    deck.rotation.x = Math.sin(time * 1.7) * 0.025;
    deck.rotation.z = Math.cos(time * 1.3) * 0.025;

    curr.movers.forEach((m, i) => {
      const p = prev.movers[i];
      moverMeshes[i].position.copy(toWorld(lerp(p.x, m.x, alpha), lerp(p.y, m.y, alpha)));
      moverMeshes[i].rotation.y = lerpAngle(p.angle, m.angle, alpha);
    });

    flags.forEach((f, i) => f && f.color.set(curr.checkpoint >= i ? '#4ade80' : '#ffffff'));

    const cos = Math.cos(ra);
    const sin = Math.sin(ra);
    const inCrew = curr.crew || ALL_SEATS;
    buildZones(inCrew);
    curr.players.forEach((pl, i) => {
      const c = crew[i];
      // seats not in this round's crew aren't on the raft at all
      const playing = inCrew.includes(i);
      c.g.visible = playing;
      if (!playing) return;
      // facing direction in raft-local terms: toward the centre, turned by the player's aim
      const pos = lerpAngle(prev.players[i].pos, pl.pos, alpha); // a solo player's angle wraps
      const aim = pos + Math.PI + pl.aim;
      const seat = seatAt(pos);
      c.g.position.set(seat.x, DECK_Y, -seat.y);
      c.arrow.rotation.y = aim;
      c.body.rotation.y = lerpAngle(c.body.rotation.y, aim, 1 - Math.exp(-frameDt * 18));
      const active = input.group || input.active === i;
      c.marker.visible = active;
      c.marker.position.y = 1.9 + Math.sin(time * 5) * 0.08;
      const showTag = tagsOn && c.occupied && !!c.label;
      c.tagShown = showTag;
      if (showTag) drawTag(c, c.label, tagsOnline ? input.seat === i : active, tagsOnline);
      c.ring.visible = false; // the tube band and name tag already say whose spot this is
      // the aim arrow only matters once you've turned away from facing the centre
      const turned = Math.abs(Math.atan2(Math.sin(pl.aim), Math.cos(pl.aim))) > 0.08;
      c.arrow.visible = c.occupied && turned;
      c.arrow.scale.setScalar(0.75);
      c.arrow.material.opacity = pl.empty ? 0.25 : 0.85;

      if (pl.farting) c.squash = Math.max(c.squash, pl.burst > 0 ? 1 : 0.45);
      c.squash = Math.max(0, c.squash - frameDt * 4);
      const sq = c.squash;
      c.body.scale.set((1 + sq * 0.18) * CREW_SCALE, (1 - sq * 0.22) * CREW_SCALE, (1 + sq * 0.18) * CREW_SCALE);
      c.body.position.y = pl.farting ? Math.abs(Math.sin(time * 40)) * 0.04 : 0;
      if (c.drop < 1) {
        // drop onto the raft and bounce: falls from 4 m, lands at 45%, two little bounces
        c.drop = Math.min(1, c.drop + frameDt / 0.9);
        c.body.position.y += 4 * dropCurve(c.drop);
        if (c.drop > 0.45 && c.drop < 0.6) c.squash = 1;
      }

      if (pl.farting) {
        // world-space thrust direction; the puff goes the other way
        const lx = Math.cos(aim);
        const ly = Math.sin(aim);
        const dx = lx * cos - ly * sin;
        const dy = lx * sin + ly * cos;
        const s = seat;
        const sx = rx + s.x * cos - s.y * sin;
        const sy = ry + s.x * sin + s.y * cos;
        const burst = pl.burst > 0;
        const n = burst ? 2 : Math.random() < 0.6 ? 1 : 0;
        for (let k = 0; k < n; k++) {
          tmp.copy(toWorld(sx - dx * 0.45, sy - dy * 0.45, DECK_Y + 0.45));
          const spread = (Math.random() - 0.5) * 1.2;
          const vel = toWorld(
            -dx * (burst ? 5 : 3) - dy * spread + curr.raft.vx * 0.4,
            -dy * (burst ? 5 : 3) + dx * spread + curr.raft.vy * 0.4,
            0.4 + Math.random() * 0.5,
          );
          spawnPuff(tmp, vel, burst ? 0.2 : 0.12, 0.55 + Math.random() * 0.4);
        }
      }
    });

    for (const p of puffs) {
      if (p.life <= 0) continue;
      p.life -= frameDt;
      if (p.life <= 0) {
        p.m.visible = false;
        continue;
      }
      const k = 1 - p.life / p.max;
      p.vel.multiplyScalar(Math.exp(-frameDt * 2.5));
      p.m.position.addScaledVector(p.vel, frameDt);
      p.m.scale.setScalar(p.size * (1 + k * 2));
      p.m.material.opacity = 0.55 * (1 - k);
    }

    flash.material.opacity = curr.phase === 'respawning' ? 0.35 + 0.3 * Math.sin(time * 30) : 0;

    // camera: follow with a little look-ahead in the direction of travel
    const look = toWorld(rx + curr.raft.vx * 0.5, ry + curr.raft.vy * 0.5 + focusShift);
    const k = firstFrame ? 1 : 1 - Math.exp(-frameDt * 4);
    firstFrame = false;
    camTarget.lerp(look, k);
    camera.position.copy(camTarget).add(camOffset);
    if (shake > 0) {
      shake = Math.max(0, shake - frameDt * 2);
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.z += (Math.random() - 0.5) * shake;
    }
    camera.lookAt(camTarget);
    sun.position.copy(camTarget).add(new THREE.Vector3(12, 30, 8));
    sun.target.position.copy(camTarget);

    renderer.render(scene, camera);
    placeTags();
  }

  // pin each name tag just above its player's head, in screen pixels
  const head = new THREE.Vector3();
  const hub = new THREE.Vector3();
  function placeTags() {
    for (const c of crew) {
      const on = c.tagShown && c.g.visible && raft.visible;
      if (!on) {
        c.tag.style.display = 'none';
        continue;
      }
      // just outside the raft's edge, straight out from the player, so it never covers the deck
      c.body.getWorldPosition(head);
      raft.getWorldPosition(hub);
      const dx = head.x - hub.x;
      const dz = head.z - hub.z;
      const d = Math.hypot(dx, dz) || 1;
      head.set(hub.x + (dx / d) * (RAFT.radius + 0.75), 0.3, hub.z + (dz / d) * (RAFT.radius + 0.75));
      head.project(camera);
      if (head.z > 1) {
        c.tag.style.display = 'none';
        continue;
      }
      c.tag.style.display = '';
      const x = ((head.x + 1) / 2) * innerWidth;
      const y = ((1 - head.y) / 2) * innerHeight;
      c.tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  function screenToWorld(sx, sy) {
    const ndc = new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.ray.intersectPlane(waterPlane, new THREE.Vector3());
    return hit ? { x: hit.x, y: -hit.z } : null;
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    // keep the course readable on tall phone screens (?cam=close: a close-up, for screenshots)
    camOffset.set(0, camera.aspect < 1 ? 32 : 24, camera.aspect < 1 ? 18 : 15);
    if (new URLSearchParams(location.search).get('cam') === 'close') camOffset.multiplyScalar(0.35);
  });
  dispatchEvent(new Event('resize'));

  return {
    render,
    screenToWorld,
    setLevel,
    setSeats,
    setFocusShift: (m) => (focusShift = m),
    snapCamera: () => (firstFrame = true),
    shake: (amount = 0.6) => (shake = amount),
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

// 0..1 -> height factor: fall, then two shrinking bounces
function dropCurve(t) {
  if (t < 0.45) return 1 - (t / 0.45) ** 2;
  if (t < 0.75) return 0.18 * Math.sin(((t - 0.45) / 0.3) * Math.PI);
  if (t < 0.92) return 0.06 * Math.sin(((t - 0.75) / 0.17) * Math.PI);
  return 0;
}
function lerpAngle(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export { NUM_PLAYERS };
