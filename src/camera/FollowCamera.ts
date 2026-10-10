import * as THREE from 'three';

export interface FollowCameraOptions {
  /** Distance behind and height above the target. */
  distance: number;
  height: number;
  /** Point the camera looks at, relative to the car (up / ahead). */
  lookHeight: number;
  lookAhead: number;
  /** Exponential smoothing rate (1/s) of the heading the camera follows. Higher = stiffer. */
  rotationDamping: number;
  baseFov: number;
  /** Extra FOV at top speed for a sense of speed. */
  speedFov: number;
}

const DEFAULTS: FollowCameraOptions = {
  distance: 6.8,
  height: 2.6,
  lookHeight: 1.1,
  lookAhead: 3,
  rotationDamping: 4.5,
  baseFov: 62,
  speedFov: 8,
};

/** Camera views, cycled with C (like the F1 games: chase, far chase, T-cam, cockpit, nose). */
export type CameraMode = 'chase' | 'far' | 'tcam' | 'cockpit' | 'driver' | 'nose' | 'tv';
export const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'tcam', 'cockpit', 'driver', 'nose', 'tv'];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: '체이스',
  far: '먼 체이스',
  tcam: 'T-캠',
  cockpit: '콕핏',
  driver: '드라이버 시점',
  nose: '노즈캠',
  tv: 'TV 중계',
};

/** Camera shake strength levels (0 = off), cycled with K and remembered. */
export const SHAKE_LEVELS = [0, 0.5, 1, 1.6];
export const SHAKE_LABELS = ['끔', '약하게', '보통', '강하게'];
const SHAKE_KEY = 'cameraShake';

/** TV cameras: one every ~TV_SPACING m of centreline, outside the corner, on the runoff just inside the barrier. */
const TV_SPACING = 230;
const TV_OFFSET = 14;
/** Distance (m) past the tarmac edge (real circuits have 8 m to the barrier). */
const TV_RUNOFF = 4;
const TV_HEIGHT = 5;
/** Half-height (m) of what the TV camera frames around the car (sets its zoom). */
const TV_FRAME = 4.5;
type OnboardMode = 'tcam' | 'cockpit' | 'driver' | 'nose';
const isOnboard = (m: CameraMode): m is OnboardMode => m === 'tcam' || m === 'cockpit' || m === 'driver' || m === 'nose';

/**
 * Onboard camera mounts in car space (m; +X right, +Y up, -Z forward,
 * origin = chassis centre), matched to the 2026 F1 body: driver's eyes
 * under the halo, T-cam on top of the airbox, nose cam ahead of the cockpit.
 */
const ONBOARD: Record<OnboardMode, { pos: THREE.Vector3; look: THREE.Vector3; fov: number }> = {
  tcam: { pos: new THREE.Vector3(0, 0.62, 0.2), look: new THREE.Vector3(0, 0.25, -12), fov: 68 },
  cockpit: { pos: new THREE.Vector3(0, 0.44, -0.55), look: new THREE.Vector3(0, 0.2, -12), fov: 78 },
  nose: { pos: new THREE.Vector3(0, 0.12, -2.2), look: new THREE.Vector3(0, 0.05, -14), fov: 74 },
  // Inside the helmet: halo pillar, steering wheel and mirrors in view.
  driver: { pos: new THREE.Vector3(0, 0.31, -0.26), look: new THREE.Vector3(0, 0.0, -12), fov: 80 },
};
const _local = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Frame-rate independent smoothing factor. */
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const _forward = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * Third-person chase camera (NFS/Forza style).
 * Only the car's *yaw* is followed (smoothed), so pitch/roll from suspension
 * and bumps never shake the view. The camera keeps a fixed distance behind the
 * car (a lagging position surged in and out with every brake and throttle) and
 * follows its height slowly (no bobbing over bumps and kerbs).
 */
export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly options: FollowCameraOptions;
  private yaw = 0;
  /** Smoothed height of the car (chase views) and pitch of its nose (onboard views). */
  private height = 0;
  private pitch = 0;
  private initialized = false;
  private readonly lookTarget = new THREE.Vector3();
  mode: CameraMode = 'chase';

  // --- camera feel: shake from speed, kerbs and impacts ---------------------
  /** Index into SHAKE_LEVELS (off by default: players found the view wobbly). */
  shakeLevel = 0;
  /** 0..1: how rough the surface under the car is (kerbs, grass, gravel); set by the game. */
  private roughness = 0;
  /** Decaying 0..1 kick from impacts (sudden velocity changes). */
  private jolt = 0;
  private shakeTime = 0;
  private readonly shakeOffset = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly _vel = new THREE.Vector3();
  private hasPrev = false;

  // --- TV cameras -----------------------------------------------------------
  private tvCams: THREE.Vector3[] = [];
  private tvIndex = -1;
  private readonly tvLook = new THREE.Vector3();

  constructor(aspect: number, options: Partial<FollowCameraOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.camera = new THREE.PerspectiveCamera(this.options.baseFov, aspect, 0.3, 15000); // distant hills; small scenery is distance-culled by the track
    try {
      const saved = Number(localStorage.getItem(SHAKE_KEY));
      if (localStorage.getItem(SHAKE_KEY) !== null && saved >= 0 && saved < SHAKE_LEVELS.length) this.shakeLevel = saved;
    } catch {
      /* storage blocked: default level */
    }
  }

  /** Next shake level (remembered); returns its label. */
  cycleShake(): string {
    this.shakeLevel = (this.shakeLevel + 1) % SHAKE_LEVELS.length;
    try {
      localStorage.setItem(SHAKE_KEY, String(this.shakeLevel));
    } catch {
      /* not remembered */
    }
    return SHAKE_LABELS[this.shakeLevel];
  }

  /** Surface roughness under the car (0 = smooth tarmac, 1 = gravel). */
  setRoughness(r: number): void {
    this.roughness = r;
  }

  /**
   * Places the TV cameras along the circuit: every TV_SPACING m, on the
   * outside of the bend on the runoff, raised, and never closer than its offset - 3 m to any
   * part of the track (so they don't stand on another straight).
   */
  setTrack(points: readonly THREE.Vector3[], rights: readonly THREE.Vector3[], onTarmac?: (p: THREE.Vector3) => boolean): void {
    this.tvCams = [];
    const n = points.length;
    if (n < 8) return;
    let run = TV_SPACING / 2;
    for (let i = 0; i < n; i++) {
      run += points[i].distanceTo(points[(i + 1) % n]);
      if (run < TV_SPACING) continue;
      const a = points[(i - 6 + n) % n];
      const b = points[(i + 6) % n];
      const turn = (points[i].x - a.x) * (b.z - points[i].z) - (points[i].z - a.z) * (b.x - points[i].x);
      // Outside of the bend (left turn -> right side); on straights alternate.
      const sides = Math.abs(turn) > 4 ? [turn < 0 ? 1 : -1, turn < 0 ? -1 : 1] : this.tvCams.length % 2 ? [1, -1] : [-1, 1];
      for (const side of sides) {
        // On the runoff a few metres past the tarmac, inside the barrier: nothing
        // stands between it and the cars (banners, billboards and trees are all
        // behind the barrier).
        let offset = TV_OFFSET;
        if (onTarmac) {
          let edge = 2;
          const probe = new THREE.Vector3();
          while (edge < 30 && onTarmac(probe.copy(points[i]).addScaledVector(rights[i], side * edge))) edge += 0.5;
          offset = edge + TV_RUNOFF;
        }
        const c = points[i].clone().addScaledVector(rights[i], side * offset);
        let clear = true;
        for (let j = 0; j < n && clear; j += 2) if ((points[j].x - c.x) ** 2 + (points[j].z - c.z) ** 2 < (offset - 3) ** 2) clear = false;
        if (!clear) continue;
        c.y = points[i].y + TV_HEIGHT;
        this.tvCams.push(c);
        run = 0;
        break;
      }
    }
    this.tvIndex = -1;
  }

  /**
   * @param target car root (interpolated pose)
   * @param speedRatio 0..1 of top speed, drives FOV
   */
  update(target: THREE.Object3D, speedRatio: number, dt: number): void {
    // Remove last frame's shake before the smoothed views lerp from it.
    this.camera.position.sub(this.shakeOffset);
    this.shakeOffset.set(0, 0, 0);
    this.trackMotion(target, dt);
    if (this.mode === 'tv' && this.tvCams.length) this.updateTv(target, dt);
    else if (isOnboard(this.mode)) this.updateOnboard(target, speedRatio, dt);
    else this.updateChase(target, speedRatio, dt);
    this.applyShake(speedRatio, dt);
  }

  /** Impact detection from the car's own motion: a velocity change beyond what grip can do. */
  private trackMotion(target: THREE.Object3D, dt: number): void {
    this.jolt *= Math.exp(-5 * dt);
    if (dt < 0.004) return;
    this._vel.subVectors(target.position, this.prevPos).divideScalar(dt);
    const jumped = this.prevPos.distanceToSquared(target.position) > 400; // reset / teleport
    if (this.hasPrev && !jumped) {
      const accel = this._vel.distanceTo(this.prevVel) / dt;
      // Braking + cornering together stay under ~6 G; beyond ~9 G something was hit.
      if (accel > 90) this.jolt = Math.min(1, Math.max(this.jolt, (accel - 90) / 160));
    }
    this.prevVel.copy(jumped ? this.prevVel.set(0, 0, 0) : this._vel);
    this.prevPos.copy(target.position);
    this.hasPrev = true;
  }

  /** Small positional + rotational noise; strongest onboard, subtle on the chase cams, none on TV. */
  private applyShake(speedRatio: number, dt: number): void {
    const k = SHAKE_LEVELS[this.shakeLevel];
    if (k <= 0 || this.mode === 'tv') return;
    this.shakeTime += dt;
    const onboard = isOnboard(this.mode);
    const v = Math.min(Math.max(speedRatio, 0), 1);
    const amp = onboard ? 0.0035 * v ** 3 + 0.012 * this.roughness * Math.min(1, v * 4) + 0.05 * this.jolt : 0.006 * this.roughness * Math.min(1, v * 4) + 0.12 * this.jolt;
    if (amp < 1e-5) return;
    const t = this.shakeTime;
    // Sum of incommensurate sines: cheap, smooth, never repeats visibly.
    const n1 = Math.sin(t * 37.1) * 0.5 + Math.sin(t * 61.7 + 1.3) * 0.3 + Math.sin(t * 89.3 + 2.1) * 0.2;
    const n2 = Math.sin(t * 43.9 + 0.7) * 0.5 + Math.sin(t * 71.3 + 2.9) * 0.3 + Math.sin(t * 97.1 + 0.4) * 0.2;
    const n3 = Math.sin(t * 29.3 + 1.9) * 0.6 + Math.sin(t * 53.7 + 0.2) * 0.4;
    const a = amp * k;
    this.shakeOffset.set(n1 * a, n2 * a, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.add(this.shakeOffset);
    this.camera.rotateZ(n3 * a * (onboard ? 1.6 : 0.6));
    this.camera.rotateX(n2 * a * (onboard ? 1.2 : 0.4));
  }

  /** Fixed trackside camera nearest the car (with hysteresis), zooming to keep it framed. */
  private updateTv(target: THREE.Object3D, dt: number): void {
    const p = target.position;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.tvCams.length; i++) {
      const d = this.tvCams[i].distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const current = this.tvIndex >= 0 ? this.tvCams[this.tvIndex].distanceToSquared(p) : Infinity;
    const cut = this.tvIndex < 0 || bestD < current * 0.6;
    if (cut) this.tvIndex = best;
    const cam = this.tvCams[this.tvIndex];
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(cam);
    _look.set(p.x, p.y + 0.6, p.z);
    if (cut || !this.initialized) this.tvLook.copy(_look);
    else this.tvLook.lerp(_look, damp(9, dt));
    this.camera.lookAt(this.tvLook);
    const dist = cam.distanceTo(this.tvLook);
    const fov = Math.min(55, Math.max(4, THREE.MathUtils.radToDeg(2 * Math.atan(TV_FRAME / dist))));
    if (cut || !this.initialized) this.camera.fov = fov;
    else this.camera.fov += (fov - this.camera.fov) * damp(4, dt);
    this.camera.updateProjectionMatrix();
    this.initialized = true;
  }

  private updateChase(target: THREE.Object3D, speedRatio: number, dt: number): void {
    const o = this.mode === 'far' ? { ...this.options, distance: this.options.distance * 1.6, height: this.options.height * 1.5 } : this.options;
    _forward.set(0, 0, -1).applyQuaternion(target.quaternion);
    const targetYaw = Math.atan2(-_forward.x, -_forward.z);

    if (!this.initialized) {
      this.snap(target);
      return;
    }

    this.camera.up.set(0, 1, 0);
    this.yaw += shortestAngle(this.yaw, targetYaw) * damp(o.rotationDamping, dt);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Behind the car = opposite of its forward (-sin, -cos) -> (+sin, +cos).
    // Slow height follow (a stale height after a long time in another view: catch up at once).
    this.height = Math.abs(target.position.y - this.height) > 15 ? target.position.y : this.height + (target.position.y - this.height) * damp(10, dt);
    this.camera.position.set(target.position.x + sin * o.distance, this.height + o.height, target.position.z + cos * o.distance);
    this.lookTarget.set(target.position.x - sin * o.lookAhead, this.height + o.lookHeight, target.position.z - cos * o.lookAhead);
    this.camera.lookAt(this.lookTarget);

    const fov = o.baseFov + o.speedFov * Math.min(Math.max(speedRatio, 0), 1) ** 1.5;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * damp(3, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  /** Next view; returns its name for the HUD. */
  cycleMode(): CameraMode {
    return this.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length]);
  }

  setMode(mode: CameraMode): CameraMode {
    this.mode = mode;
    const onboard = isOnboard(this.mode);
    // Onboard views sit centimetres from the bodywork.
    this.camera.near = onboard ? 0.05 : 0.3;
    if (mode !== 'tv') this.camera.fov = isOnboard(mode) ? ONBOARD[mode as OnboardMode].fov : this.options.baseFov;
    this.tvIndex = -1;
    this.camera.updateProjectionMatrix();
    this.initialized = false;
    return this.mode;
  }

  /**
   * Mounted on the car, but the view stays level: no roll, and the nose's pitch (the slope of
   * the road) followed smoothly, so suspension dive, squat and roll do not rock the picture.
   */
  private updateOnboard(target: THREE.Object3D, speedRatio: number, dt: number): void {
    const mount = ONBOARD[this.mode as OnboardMode];
    target.updateMatrixWorld();
    _m.copy(target.matrixWorld);
    this.camera.position.copy(_local.copy(mount.pos).applyMatrix4(_m));
    _forward.set(0, 0, -1).applyQuaternion(target.quaternion);
    const flat = Math.hypot(_forward.x, _forward.z) || 1;
    const pitch = Math.atan2(_forward.y, flat);
    this.pitch = this.initialized ? this.pitch + (pitch - this.pitch) * damp(2.5, dt) : pitch;
    const lookPitch = this.pitch + Math.atan2(mount.look.y - mount.pos.y, mount.pos.z - mount.look.z);
    const c = Math.cos(lookPitch);
    this.lookTarget.set(_forward.x / flat, 0, _forward.z / flat).multiplyScalar(c).setY(Math.sin(lookPitch)).add(this.camera.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.lookTarget);
    const fov = mount.fov + 6 * Math.min(Math.max(speedRatio, 0), 1) ** 1.5;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * damp(3, dt);
      this.camera.updateProjectionMatrix();
    }
    this.initialized = true;
  }

  /** Jump straight behind the target (spawn / reset). */
  snap(target: THREE.Object3D): void {
    this.camera.position.sub(this.shakeOffset);
    this.shakeOffset.set(0, 0, 0);
    this.hasPrev = false;
    if (this.mode === 'tv' && this.tvCams.length) {
      this.tvIndex = -1;
      this.initialized = false;
      this.updateTv(target, 1);
      return;
    }
    if (isOnboard(this.mode)) {
      this.updateOnboard(target, 0, 1);
      return;
    }
    this.camera.up.set(0, 1, 0);
    const o = this.mode === 'far' ? { ...this.options, distance: this.options.distance * 1.6, height: this.options.height * 1.5 } : this.options;
    _forward.set(0, 0, -1).applyQuaternion(target.quaternion);
    this.yaw = Math.atan2(-_forward.x, -_forward.z);
    this.height = target.position.y;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.camera.position.set(
      target.position.x + sin * o.distance,
      target.position.y + o.height,
      target.position.z + cos * o.distance,
    );
    this.lookTarget.set(
      target.position.x - sin * o.lookAhead,
      target.position.y + o.lookHeight,
      target.position.z - cos * o.lookAhead,
    );
    this.camera.lookAt(this.lookTarget);
    this.initialized = true;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
