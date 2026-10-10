import * as THREE from 'three';
import { urlWith } from '../config';
import { RainLens, RainStreaks, Spray } from '../render/Rain';
import type { PostFxOptions } from '../render/PostFx';
import { REFLECT_LAYER, WetReflection } from '../render/WetReflection';
import type { Vehicle } from '../vehicle/Vehicle';
import { TRACK_GRIP } from '../vehicle/Tyres';
import { BUILDING_NIGHT } from './Buildings';
import { GROUND_FX } from './GroundShading';
import type { WorldTheme } from './themes';
import type { Track } from './Track';

/**
 * Weather and time of day, picked in the menu or the URL
 * (`?weather=clear|cloudy|rain&time=day|dusk|night`, remembered locally):
 *
 * - cloudy: overcast sky, soft light.
 * - rain: overcast + mist, falling streaks, spray behind the cars, drops on
 *   the lens onboard, a soaked glossy track with standing water, rain lights
 *   on, rain noise — and ~22% less grip for everyone (TRACK_GRIP; the AI reads
 *   tyre grip and slows down by itself). Real F1 would switch to
 *   intermediates; tyre choice for the wet is a later step.
 * - dusk: low warm sun, long shadows.
 * - night: floodlit race (Bahrain / Singapore style): dark sky with stars,
 *   floodlight towers all round the circuit with glowing lamps, pools of
 *   light on the track from a baked light map, lit windows and garages,
 *   rear lights glowing, stronger bloom.
 */
export type WeatherKind = 'clear' | 'cloudy' | 'drizzle' | 'rain';
export type TimeOfDay = 'day' | 'dusk' | 'night';
export interface WeatherState {
  weather: WeatherKind;
  time: TimeOfDay;
}

const KINDS: [WeatherKind, string, string][] = [
  ['clear', '☀️ 맑음', '건조한 노면'],
  ['cloudy', '☁️ 흐림', '부드러운 빛'],
  ['drizzle', '🌦️ 약한 비', '접지력 −12% · 인터미디어트'],
  ['rain', '🌧️ 비', '접지력 −22% · 물보라'],
];
const TIMES: [TimeOfDay, string, string][] = [
  ['day', '낮', '오후 햇빛'],
  ['dusk', '해 질 녘', '낮은 해 · 긴 그림자'],
  ['night', '밤', '조명탑 야간 레이스'],
];

/** Track grip (vs dry) at full wetness (heavy rain). */
const WET_GRIP = 0.78;

/**
 * How wet the track is: 0 dry, 1 heavy rain. Light rain is a damp track, where the
 * intermediates are the tyre (full wets for the heavy rain), as in the F1 games.
 */
export function wetness(w: WeatherState): number {
  return w.weather === 'rain' ? 1 : w.weather === 'drizzle' ? 0.55 : 0;
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readWeather(search = window.location.search): WeatherState {
  const p = new URLSearchParams(search);
  const w = p.get('weather') ?? stored('weather');
  const t = p.get('time') ?? stored('time');
  return {
    weather: KINDS.some(([k]) => k === w) ? (w as WeatherKind) : 'clear',
    time: TIMES.some(([k]) => k === t) ? (t as TimeOfDay) : 'day',
  };
}

/** The circuit's look adjusted for the weather and the time of day. */
export function weatherTheme(theme: WorldTheme, w: WeatherState): WorldTheme {
  let t: WorldTheme = { ...theme };
  if (w.time === 'dusk') {
    t = {
      ...t,
      hdri: 'qwantani_dusk_2_puresky_2k.exr',
      sunColor: 0xff9248,
      sunIntensity: 3.3,
      envIntensity: 0.9,
      hemiIntensity: 0.12,
      exposure: 1.05,
      minSunElevation: 0.11,
      fogDensity: theme.fogDensity * 1.3,
      skyTop: 0x3b4a6b,
      skyHorizon: 0xe8a070,
    };
  } else if (w.time === 'night') {
    t = {
      ...t,
      night: true,
      sunColor: 0xe4ecff,
      sunIntensity: 0.55,
      envIntensity: 0.8,
      hemiIntensity: 0.5,
      exposure: 1.0,
      fogDensity: 0.0011,
      skyTop: 0x03060d,
      skyHorizon: 0x161c2a,
    };
  }
  if (w.weather !== 'clear') {
    const rain = w.weather === 'rain';
    const drizzle = w.weather === 'drizzle';
    if (w.time !== 'night') {
      t.hdri = 'kloofendal_overcast_puresky_2k.exr';
      t.sunColor = w.time === 'dusk' ? 0xffc8a0 : 0xeef0f2;
      t.sunIntensity *= rain ? 0.22 : drizzle ? 0.28 : 0.35;
      t.hemiIntensity = 0.3;
      t.envIntensity = rain ? 0.95 : 1.1;
      t.exposure *= w.time === 'dusk' ? 0.75 : rain ? 0.92 : 1;
      t.skyTop = 0x7d858f;
      t.skyHorizon = 0xa9b0b8;
    }
    t.fogDensity *= rain ? 2.1 : drizzle ? 1.7 : 1.4;
  }
  return t;
}

/** Bloom / lens settings for the post-processing chain. */
export function weatherPostFx(w: WeatherState): PostFxOptions & { lens: RainLens | null } {
  return {
    bloom: w.time === 'night' ? 0.9 : w.time === 'dusk' ? 0.5 : 0.35,
    bloomThreshold: w.time === 'night' ? 0.62 : 0.9,
    lens: wetness(w) > 0 ? new RainLens() : null,
  };
}

/** Two rows of cards in the start menu; the choice goes to the URL (kept for the race) and local storage. */
export function mountWeatherPicker(el: HTMLElement): void {
  let state = readWeather();
  const row = (items: [string, string, string][], current: () => string, pick: (k: string) => void) => {
    const grid = document.createElement('div');
    grid.className = 'menu-grid';
    const render = () =>
      grid.replaceChildren(
        ...items.map(([k, title, sub]) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'menu-card' + (k === current() ? ' selected' : '');
          const strong = document.createElement('strong');
          strong.textContent = title;
          const span = document.createElement('span');
          span.textContent = sub;
          b.append(strong, span);
          b.addEventListener('click', () => {
            pick(k);
            render();
          });
          return b;
        }),
      );
    render();
    return grid;
  };
  const save = () => {
    try {
      localStorage.setItem('weather', state.weather);
      localStorage.setItem('time', state.time);
    } catch {
      /* storage blocked: the URL still carries it */
    }
    history.replaceState(null, '', urlWith({ weather: state.weather, time: state.time }));
  };
  const title = document.createElement('h2');
  title.textContent = '날씨 · 시간';
  el.replaceChildren(
    title,
    row(KINDS, () => state.weather, (k) => {
      state = { ...state, weather: k as WeatherKind };
      save();
    }),
    row(TIMES, () => state.time, (k) => {
      state = { ...state, time: k as TimeOfDay };
      save();
    }),
  );
}

// --------------------------------------------------------------------------

/** Cars mirrored in the wet track (nearest to the camera). */
const REFLECTED_CARS = 6;

/** Floodlight tower spacing along the track (m, each side) and lamp height. */
const POLE_SPACING = 75;
const POLE_HEIGHT = 24;

export class WeatherFx {
  private readonly group = new THREE.Group();
  private readonly rain: RainStreaks | null = null;
  private readonly spray: Spray | null = null;
  private readonly disposables: { dispose(): void }[] = [];
  /** Rear / rain light materials of every car (found once). */
  private readonly carLights = new Set<THREE.MeshStandardMaterial>();
  private readonly lightLevel: number;
  /** Brightness of the (unlit) impostor trees: they would glow in the dark otherwise. */
  private readonly treeShade: number;
  private forestDone = false;
  private frame = 0;
  private noise: AudioBufferSourceNode | null = null;
  private readonly reflection: WetReflection | null = null;
  /** Vehicles already tagged for the reflection (remote cars can join later). */
  private readonly tagged = new WeakSet<Vehicle>();
  private readonly carRoots = new Set<THREE.Object3D>();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    readonly state: WeatherState,
    private readonly track: Track,
    private readonly vehicles: readonly Vehicle[],
    private readonly lens: RainLens | null,
  ) {
    this.group.name = 'Weather';
    // Profiling switch: ?wxoff=refl,streaks,spray turns parts of the rain off.
    const off = new URLSearchParams(window.location.search).get('wxoff') ?? '';
    scene.add(this.group);
    const wetLevel = wetness(state);
    const wet = wetLevel > 0;
    const night = state.time === 'night';
    TRACK_GRIP.value = 1 - (1 - WET_GRIP) * wetLevel;
    GROUND_FX.uWet.value = wetLevel;
    GROUND_FX.uNight.value = night ? 1 : 0;
    BUILDING_NIGHT.value = night ? 1 : 0;
    this.lightLevel = wet ? 3.5 * wetLevel : night ? 2.2 : 0;
    this.treeShade = night ? 0.22 : state.time === 'dusk' ? 0.72 : wet ? 0.7 : state.weather === 'cloudy' ? 0.82 : 1;
    if (wet && !off.includes('streaks')) {
      this.rain = new RainStreaks(night ? 0xd4dbe6 : 0xa9b1ba);
      this.group.add(this.rain.mesh);
    }
    if (wet && !off.includes('spray')) {
      this.spray = new Spray(night ? 0x77808e : 0xc2c7cc);
      this.group.add(this.spray.mesh);
    }
    if (night) this.buildFloodlights();
    if (night) this.lightUpTrackside();
    if (wet && !off.includes('refl')) {
      this.reflection = new WetReflection();
      GROUND_FX.uReflMap.value = this.reflection.target.texture;
      GROUND_FX.uReflOn.value = 1;
      // What the wet track mirrors: lights, the gantry, banners and garages (cars are tagged as they appear).
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight) o.layers.enable(REFLECT_LAYER);
      });
      const names = new Set(['FloodlightLamps', 'FloodlightGlow', 'StartGantry', 'Billboards', 'PitGarages']);
      track.root.traverse((o) => {
        if (names.has(o.name)) o.traverse((c) => c.layers.enable(REFLECT_LAYER));
      });
      this.group.traverse((o) => {
        if (names.has(o.name)) o.layers.enable(REFLECT_LAYER);
      });
    }
  }

  /** Mixes a rain noise loop into the game audio (synthesised: no recording needed). */
  attachAudio(ctx: AudioContext, master: GainNode): void {
    if (wetness(this.state) === 0 || this.noise) return;
    const len = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buffer.getChannelData(c);
      let b = 0;
      for (let i = 0; i < len; i++) {
        // Pinkish noise with sparse louder ticks (drops hitting the car / ground).
        b = 0.97 * b + 0.03 * (Math.random() * 2 - 1);
        d[i] = (Math.random() * 2 - 1) * 0.5 + b * 2 + (Math.random() < 0.0015 ? (Math.random() - 0.5) * 2 : 0);
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 350;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6500;
    const gain = ctx.createGain();
    gain.gain.value = 0.16 * wetness(this.state);
    src.connect(hp).connect(lp).connect(gain).connect(master);
    src.start();
    this.noise = src;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, onboard: boolean): void {
    dt = Math.max(0, dt);
    if (!this.forestDone && this.treeShade < 1) {
      // The forest streams in after the start.
      const forest = this.scene.getObjectByName('ImpostorForest') as THREE.Mesh | undefined;
      if (forest) {
        (forest.material as THREE.MeshBasicMaterial).color.setScalar(this.treeShade);
        this.forestDone = true;
      }
    }
    if (this.reflection) {
      for (const v of this.vehicles) {
        if (this.tagged.has(v)) continue;
        this.tagged.add(v);
        this.carRoots.add(v.object3D);
        v.object3D.traverse((o) => o.layers.enable(REFLECT_LAYER));
      }
      // Every other frame: at a third of the resolution and blurred by ripples, nobody sees the lag.
      if ((this.frame++ & 1) === 0) {
        // Only the cars, the lights and the floodlights are mirrored: hide every other
        // top-level branch so the renderer doesn't even walk the scenery.
        const hidden: THREE.Object3D[] = [];
        // Nearest cars only: further back they are lost in the spray anyway.
        const cam = camera.position;
        const near = [...this.carRoots].sort((a, b) => a.position.distanceToSquared(cam) - b.position.distanceToSquared(cam)).slice(0, REFLECTED_CARS);
        const keep = new Set<THREE.Object3D>(near);
        for (const o of this.scene.children) {
          if (!o.visible || o === this.group || (o as THREE.Light).isLight || keep.has(o)) continue;
          o.visible = false;
          hidden.push(o);
        }
        const ok = this.reflection.render(this.renderer, this.scene, camera);
        for (const o of hidden) o.visible = true;
        GROUND_FX.uReflOn.value = ok ? 1 : 0;
        GROUND_FX.uReflMatrix.value.copy(this.reflection.textureMatrix);
      }
    }
    if (this.rain) this.rain.update(dt, camera);
    if (this.spray) this.spray.update(dt, this.vehicles, camera);
    if (this.lens) {
      this.lens.amount = onboard ? 1 : 0;
      this.lens.tick(dt, camera.aspect);
    }
    if (this.lightLevel > 0) {
      if (!this.carLights.size) this.findCarLights();
      // Rain light on (wet races) / glowing at night, still flashing brighter when harvesting.
      for (const m of this.carLights) m.emissiveIntensity = Math.max(m.emissiveIntensity, this.lightLevel);
    }
  }

  private findCarLights(): void {
    for (const v of this.vehicles)
      v.object3D.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m?.emissive && m.emissive.r > 0.9 && m.emissive.g < 0.3 && m.emissive.b < 0.3) this.carLights.add(m);
      });
  }

  /** Billboards and banners are lit at night, garages and hospitality glow. */
  private lightUpTrackside(): void {
    this.track.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const m = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (!m || !('emissive' in m)) return;
      if (o.name === 'Billboards' || o.name === 'FenceBanners' || o.name === 'DistanceBoards') {
        m.emissive.set(0xffffff);
        m.emissiveMap = m.map;
        m.emissiveIntensity = 0.45;
        m.needsUpdate = true;
      } else if (o.name === 'PitGarages') {
        m.emissiveIntensity = 0.9;
      } else if (o.name === 'PitGlass') {
        m.emissive.set(0xffc488);
        m.emissiveIntensity = 0.35;
      }
    });
  }

  /**
   * Floodlight towers on both sides of the whole lap (behind the barriers,
   * not in front of the pit building), lamps that glow and bloom, and a
   * light map of the pools they throw on the track for the ground shaders.
   */
  private buildFloodlights(): void {
    const pts = this.track.getCenterline();
    const rights = this.track.getRights();
    const pit = this.track.pit;
    const n = pts.length;
    const poles: { pos: THREE.Vector3; toward: THREE.Vector3; tangent: THREE.Vector3 }[] = [];
    const p = new THREE.Vector3();
    for (const side of [-1, 1]) {
      let next = side > 0 ? 0 : POLE_SPACING / 2;
      let dist = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        dist += pts[i].distanceTo(pts[j]);
        if (dist < next) continue;
        next = dist + POLE_SPACING;
        if (pit && pit.side === side && pit.inRange(i)) continue;
        const r = rights[i];
        let found = -1;
        for (let o = this.track.halfWidth + 6; o < this.track.halfWidth + 70; o += 2) {
          p.copy(pts[i]).addScaledVector(r, side * o);
          if (this.track.isOutOfBounds(p)) {
            found = o + 2;
            break;
          }
        }
        if (found < 0) continue;
        const pos = pts[i].clone().addScaledVector(r, side * found).setY(0);
        const tangent = pts[j].clone().sub(pts[i]).setY(0).normalize();
        poles.push({ pos, toward: r.clone().multiplyScalar(-side).setY(0).normalize(), tangent });
      }
    }
    if (!poles.length) return;

    // Tower: lattice-ish mast + crossbar; the lamp bank faces the track (+Z in local space), tilted down.
    const steelGeo = mergeBoxes([
      [0.5, POLE_HEIGHT, 0.5, 0, POLE_HEIGHT / 2, 0],
      [4.6, 0.3, 0.3, 0, POLE_HEIGHT + 0.2, 0],
      [4.6, 0.3, 0.3, 0, POLE_HEIGHT + 2.1, 0],
      [0.25, 2.2, 0.25, -2.2, POLE_HEIGHT + 1.1, 0],
      [0.25, 2.2, 0.25, 2.2, POLE_HEIGHT + 1.1, 0],
    ]);
    const lampGeo = new THREE.BoxGeometry(4.2, 1.7, 0.35).rotateX(-0.55).translate(0, POLE_HEIGHT + 1.15, 0.45);
    const steel = new THREE.MeshStandardMaterial({ color: 0x6d737b, metalness: 0.6, roughness: 0.5 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff4e0, emissiveIntensity: 6 });
    const steelMesh = new THREE.InstancedMesh(steelGeo, steel, poles.length);
    const lampMesh = new THREE.InstancedMesh(lampGeo, lamp, poles.length);
    steelMesh.name = 'FloodlightTowers';
    lampMesh.name = 'FloodlightLamps';
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const glowPos: number[] = [];
    poles.forEach((pole, k) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(pole.toward.x, pole.toward.z));
      m.compose(pole.pos, q, one);
      steelMesh.setMatrixAt(k, m);
      lampMesh.setMatrixAt(k, m);
      const head = pole.pos.clone().addScaledVector(pole.toward, 0.7);
      glowPos.push(head.x, POLE_HEIGHT + 1.2, head.z);
    });
    steelMesh.castShadow = false;
    steelMesh.computeBoundingSphere();
    lampMesh.computeBoundingSphere();

    // Halo around every lamp: additive points, visible from far away (no fog).
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
    const glowTex = haloTexture(64);
    const glowMat = new THREE.PointsMaterial({
      map: glowTex,
      color: 0xffe6c0,
      size: 7,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const glow = new THREE.Points(glowGeo, glowMat);
    glow.name = 'FloodlightGlow';
    this.group.add(steelMesh, lampMesh, glow);
    this.disposables.push(steelGeo, lampGeo, steel, lamp, glowGeo, glowMat, glowTex);

    // Light map: an elongated pool on the track in front of each tower.
    const b = this.track.bounds;
    const pad = 80;
    const x0 = b.min.x - pad;
    const z0 = b.min.z - pad;
    const w = b.max.x - b.min.x + 2 * pad;
    const d = b.max.z - b.min.z + 2 * pad;
    const res = 2;
    const W = Math.ceil(w / res);
    const H = Math.ceil(d / res);
    const acc = new Float32Array(W * H);
    for (const pole of poles) {
      const c = pole.pos.clone().addScaledVector(pole.toward, 20);
      const reach = 70;
      const i0 = Math.max(0, Math.floor((c.x - reach - x0) / res));
      const i1 = Math.min(W - 1, Math.ceil((c.x + reach - x0) / res));
      const j0 = Math.max(0, Math.floor((c.z - reach - z0) / res));
      const j1 = Math.min(H - 1, Math.ceil((c.z + reach - z0) / res));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const dx = x0 + (i + 0.5) * res - c.x;
          const dz = z0 + (j + 0.5) * res - c.z;
          const along = dx * pole.tangent.x + dz * pole.tangent.z;
          const across = dx * pole.toward.x + dz * pole.toward.z;
          acc[j * W + i] += 0.75 * Math.exp(-((along / 40) ** 2) - (across / 30) ** 2);
        }
    }
    const data = new Uint8Array(W * H * 4);
    for (let k = 0; k < W * H; k++) {
      const v = Math.round(255 * (1 - Math.exp(-1.5 * acc[k])));
      data[k * 4] = v;
      data[k * 4 + 3] = 255;
    }
    const map = new THREE.DataTexture(data, W, H);
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearFilter;
    map.needsUpdate = true;
    this.disposables.push(map);
    GROUND_FX.uLightMap.value = map;
    GROUND_FX.uLightRect.value.set(x0, z0, w, d);
  }

  dispose(): void {
    this.noise?.stop();
    this.rain?.dispose();
    this.spray?.dispose();
    this.reflection?.dispose();
    GROUND_FX.uReflOn.value = 0;
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
    TRACK_GRIP.value = 1;
    GROUND_FX.uWet.value = 0;
    GROUND_FX.uNight.value = 0;
    BUILDING_NIGHT.value = 0;
  }
}

function mergeBoxes(boxes: [number, number, number, number, number, number][]): THREE.BufferGeometry {
  const parts = boxes.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed());
  const count = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return geo;
}

/** Soft radial halo with a bright core. */
function haloTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, 1 - r) ** 2.2 * 0.6 + Math.max(0, 1 - r * 4) ** 2 * 0.4;
      data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4);
    }
  const tex = new THREE.DataTexture(data, size, size);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}
