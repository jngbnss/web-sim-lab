import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import type { WorldTheme } from './themes';

export interface EnvironmentOptions {
  shadows: boolean;
  shadowMapSize: number;
  theme: WorldTheme;
}

/**
 * Sky, lights, haze (exponential, so distant hills fade like real air). The sun's shadow camera follows the player with a tight
 * frustum, so one modest shadow map stays sharp around the car regardless of
 * track size (cheap compared to covering the whole track).
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  private readonly sunOffset = new THREE.Vector3(-60, 90, 40);
  private readonly sky: THREE.Mesh;
  private readonly lights: THREE.Light[] = [];
  private readonly ambient: THREE.AmbientLight;
  private readonly hemi: THREE.HemisphereLight;
  private envMap: THREE.Texture | null = null;
  private skyTexture: THREE.Texture | null = null;
  private readonly theme: WorldTheme;

  constructor(
    private readonly scene: THREE.Scene,
    options: EnvironmentOptions,
  ) {
    const theme = (this.theme = options.theme);
    scene.background = new THREE.Color(theme.skyHorizon);
    scene.fog = new THREE.FogExp2(theme.skyHorizon, theme.fogDensity);

    this.sky = this.createSky(new THREE.Color(theme.skyTop), new THREE.Color(theme.skyHorizon), theme.night ? 1 : 0);
    scene.add(this.sky);

    const ambient = (this.ambient = new THREE.AmbientLight(0xffffff, theme.night ? 0.06 : 0.35));
    const hemi = (this.hemi = theme.night ? new THREE.HemisphereLight(0x5a6c94, 0x10140e, 0.5) : new THREE.HemisphereLight(0xcfe6ff, 0x4f6b3a, 1.1));
    // Night: the "sun" stands in for the floodlights, high above the track.
    if (theme.night) this.sunOffset.set(-35, 125, 25);
    this.sun = new THREE.DirectionalLight(theme.sunColor, theme.sunIntensity);
    this.sun.position.copy(this.sunOffset);

    if (options.shadows) {
      this.sun.castShadow = true;
      const cam = this.sun.shadow.camera;
      const extent = 45;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.near = 10;
      cam.far = 250;
      this.sun.shadow.mapSize.set(options.shadowMapSize, options.shadowMapSize);
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.03;
    }

    scene.add(ambient, hemi, this.sun, this.sun.target);
    this.lights.push(ambient, hemi, this.sun);
  }

  /**
   * Streams in an equirectangular HDRI (loaded after the game is already
   * running): becomes the visible sky, the image-based lighting for PBR
   * materials (car paint reflections), and drives sun direction + fog color.
   */
  async loadSky(baseUrl: string, renderer: THREE.WebGLRenderer): Promise<void> {
    if (this.theme.night) {
      this.nightSky(renderer);
      return;
    }
    // Half-float EXR with lossy DWAA compression (~1 MB; the Poly Haven .hdr files were ~4.6 MB).
    const texture = await new EXRLoader().loadAsync(`${baseUrl}hdri/${this.theme.hdri}`);
    texture.mapping = THREE.EquirectangularReflectionMapping;

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromEquirectangular(texture).texture;
    pmrem.dispose();

    this.skyTexture = texture;
    this.scene.background = texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = this.theme.envIntensity;
    this.sky.visible = false;
    // IBL now provides the ambient term.
    this.ambient.intensity = 0;
    this.hemi.intensity = this.theme.hemiIntensity;

    const { sunDir, horizon } = analyzeEquirect(texture, this.theme.minSunElevation ?? 0.35);
    if (sunDir) this.sunOffset.copy(sunDir).multiplyScalar(130);
    if (horizon && this.scene.fog) this.scene.fog.color.copy(horizon);
  }

  /**
   * Night lighting for PBR materials: no HDRI, a dark sky with a ring of
   * floodlight banks and a warm glow of the town on the horizon, so car
   * paint and wet tarmac still catch bright reflections.
   */
  private nightSky(renderer: THREE.WebGLRenderer): void {
    const env = new THREE.Scene();
    const dome = this.createSky(new THREE.Color(0x03060d), new THREE.Color(0x1c2233), 0);
    dome.scale.setScalar(0.01);
    env.add(dome);
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(120, 120, 18, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.22, 0.12), side: THREE.BackSide }),
    );
    glow.position.y = 2;
    env.add(glow);
    const panel = new THREE.PlaneGeometry(14, 5);
    const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 8.6, 7.8), side: THREE.DoubleSide });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const m = new THREE.Mesh(panel, lamp);
      m.position.set(Math.cos(a) * 100, 42 + (i % 3) * 6, Math.sin(a) * 100);
      m.lookAt(0, 0, 0);
      env.add(m);
    }
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromScene(env, 0.02).texture;
    pmrem.dispose();
    env.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    });
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = this.theme.envIntensity;
    this.ambient.intensity = 0;
  }

  /** Keep the shadow frustum and sky centred on the player. */
  update(focus: THREE.Vector3): void {
    // Snap to a grid to avoid shadow-edge shimmering while moving.
    const snap = 2;
    const fx = Math.round(focus.x / snap) * snap;
    const fz = Math.round(focus.z / snap) * snap;
    // Follow the height too (Spa's road spans ~100 m): the shadow box stays around the car.
    const fy = Math.round(focus.y / snap) * snap;
    this.sun.target.position.set(fx, fy, fz);
    this.sun.position.set(fx + this.sunOffset.x, fy + this.sunOffset.y, fz + this.sunOffset.z);
    this.sky.position.set(focus.x, 0, focus.z);
  }

  dispose(): void {
    for (const l of this.lights) {
      l.removeFromParent();
      l.dispose();
    }
    this.sky.removeFromParent();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.envMap?.dispose();
    this.skyTexture?.dispose();
  }

  /** Vertical-gradient sky dome (with stars at night); 1 draw call, no textures. */
  private createSky(top: THREE.Color, horizon: THREE.Color, stars: number): THREE.Mesh {
    // Inside the camera far plane, beyond the distant hills.
    const geo = new THREE.SphereGeometry(13000, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: top },
        horizon: { value: horizon },
        stars: { value: stars },
      },
      vertexShader: /* glsl */ `
        varying float vHeight;
        varying vec3 vDir;
        void main() {
          vHeight = normalize(position).y;
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 horizon;
        uniform float stars;
        varying float vHeight;
        varying vec3 vDir;
        void main() {
          float t = pow(clamp(vHeight, 0.0, 1.0), 0.6);
          vec3 col = mix(horizon, top, t);
          if (stars > 0.0) {
            vec3 cell = floor(vDir * 420.0);
            float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            float star = step(0.9965, h) * smoothstep(0.08, 0.35, vHeight);
            col += vec3(0.8, 0.85, 1.0) * star * (0.4 + 0.6 * fract(h * 97.0)) * stars;
          }
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.name = 'Sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    return sky;
  }
}

/**
 * Finds the sun (brightest region) and the average horizon color in an
 * equirectangular HDR DataTexture (RGBA half-float, rows top->bottom, flipY).
 */
function analyzeEquirect(texture: THREE.Texture, minElevation: number): { sunDir: THREE.Vector3 | null; horizon: THREE.Color | null } {
  const image = texture.image as { data?: ArrayLike<number>; width: number; height: number };
  const data = image.data;
  if (!data || !(data instanceof Uint16Array || data instanceof Float32Array)) return { sunDir: null, horizon: null };
  const half = data instanceof Uint16Array;
  const read = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  const { width: w, height: h } = image;
  // Row y counted from the top of the sky (EXRLoader stores the bottom row first, flipY off).
  const row = (y: number) => (texture.flipY ? y : h - 1 - y);

  let best = -1;
  let bx = 0;
  let by = 0;
  const step = 2;
  // Only the upper hemisphere can hold the sun.
  for (let y = 0; y < h / 2; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (row(y) * w + x) * 4;
      const lum = 0.2126 * read(i) + 0.7152 * read(i + 1) + 0.0722 * read(i + 2);
      if (lum > best) {
        best = lum;
        bx = x;
        by = y;
      }
    }

  // Three.js equirect convention: u = atan2(z, x) / 2π + 0.5, v = asin(y) / π + 0.5 (v = 1 at top row).
  const u = (bx + 0.5) / w;
  const v = 1 - (by + 0.5) / h;
  const phi = (u - 0.5) * Math.PI * 2;
  const lat = Math.max((v - 0.5) * Math.PI, minElevation); // keep shadows reasonable if the sun is very low
  const sunDir = new THREE.Vector3(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)).normalize();

  // Horizon band: just above the horizon line.
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const y0 = Math.floor(h * 0.44);
  const y1 = Math.floor(h * 0.49);
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < w; x += 8) {
      const i = (row(y) * w + x) * 4;
      r += read(i);
      g += read(i + 1);
      b += read(i + 2);
      n++;
    }
  const horizon = n > 0 ? new THREE.Color().setRGB(r / n, g / n, b / n) : null;
  return { sunDir, horizon };
}
