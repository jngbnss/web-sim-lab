import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PitStops } from '../race/PitStops';
import type { Vehicle } from '../vehicle/Vehicle';
import { WHEEL_OFF } from '../vehicle/VehicleVisual';
import { BOX_LANE_SHIFT, type PitLaneData } from './PitLane';

/**
 * Pit crews, F1 style: per box, at each wheel a gun man, a man who takes the old
 * wheel off and one who fits the new one; a front and a rear jack man and a release
 * man with a lollipop. They wait in front of the garage and sprint out as their car
 * swings into the box. The stop, in about two seconds:
 *   jacks up -> the car's wheels slide off and are carried away -> new wheels go
 *   on -> wheel guns -> jacks down, front jack man steps aside -> lollipop up
 *   (green), go. Then the crew jogs back.
 * The car's own wheels move (VehicleVisual.setWheelOffset); off the hub a crew
 * wheel takes over.
 *
 * All boxes share instanced meshes (crew standing / kneeling, wheels, lollipops): ~4 draw calls.
 */
const CREW = 15;
const GUN = 0;
const OFF = 4;
const ON = 8;
const FRONT_JACK = 12;
const REAR_JACK = 13;
const RELEASE = 14;
/** Path samples before the box at which the crew steps out (~30 m). */
const STEP_OUT = 12;
/** Car lifted by the jacks (m). */
const LIFT = 0.07;
/** How fast the crew runs out / back (share of the way per second). */
const RUN = 2.4;
/** Stop timeline (s after the car stops; each wheel a few hundredths later or earlier). */
const T = { liftUp: [0.08, 0.3], off: [0.36, 0.7], carry: [0.7, 1.2], on: [0.78, 1.12], gun: [1.12, 1.45] } as const;
/** Before the release (s before the end of service): jacks down, front jack man steps aside, lollipop up. */
const T_DOWN = [0.5, 0.3] as const;
const T_ASIDE = [0.32, 0.06] as const;
const T_GO = [0.15, 0] as const;
const STAGGER = [0, 0.05, 0.09, 0.03];
/** Old wheel slid this far off before it is carried away (m); the new one is held this far out. */
const OFF_DIST = 0.7;
const HOLD_DIST = 1.05;
/** The crew stays out this long after the release (s). */
const LINGER = 1.2;

/** 0..1 progress of t through [a, b], smoothed. */
function phase(t: number, [a, b]: readonly [number, number]): number {
  const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
}

interface BoxState {
  /** 0 = waiting at the garage, 1 = in service positions. */
  out: number;
  /** Anchor pose the service positions are laid out around (eases towards the car). */
  pos: THREE.Vector3;
  yaw: number;
  /** Seconds since the last car was released (crew lingers, then walks back). */
  sinceRelease: number;
  wasStopped: boolean;
  /** The car being serviced (its wheels go back on their hubs when it leaves). */
  car: Vehicle | null;
}

export interface PitCrewSnapshot {
  vehicle: Vehicle;
  phase: 'in' | 'stopped' | 'out';
  box: number;
  k: number;
  timer: number;
  service: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _lean = new THREE.Quaternion();
const _face = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
/** Hidden instances go far below the ground (a zero scale gives NaN normals, which bloom spreads over the screen). */
const HIDDEN = -1000;
const AXLE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);

/**
 * A crew member, low-poly but human: shoes, legs, hips, torso, arms, gloves, neck and a
 * helmet with a dark visor. Vertex shades are multiplied by the team colour per instance:
 * suit 1, trousers 0.04 (linear: a near-black team colour), gloves 0.2, shoes and visor ~0.08. Faces -Z, feet at y = 0.
 */
function crewGeometry(pose: 'stand' | 'kneel'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, shade: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    const n = ng.getAttribute('position').count;
    ng.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(shade), 3));
    ng.deleteAttribute('uv');
    parts.push(ng);
  };
  const _from = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  /** A rounded limb (cylinder with ball ends) between two points. */
  const limb = (from: [number, number, number], to: [number, number, number], r: number, shade: number) => {
    _from.set(...from);
    _dir.set(...to).sub(_from);
    const len = _dir.length();
    const g = new THREE.CylinderGeometry(r, r * 0.9, len, 7);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _dir.clone().normalize()));
    g.translate(_from.x + _dir.x / 2, _from.y + _dir.y / 2, _from.z + _dir.z / 2);
    add(g, shade);
    add(new THREE.SphereGeometry(r, 7, 5).translate(...to), shade);
  };
  const box = (w: number, h: number, d: number, at: [number, number, number], shade: number, tiltX = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (tiltX) g.rotateX(tiltX);
    add(g.translate(...at), shade);
  };
  const SUIT = 1;
  const TROUSERS = 0.04;
  const GLOVES = 0.2;
  const DARK = 0.08;
  if (pose === 'stand') {
    for (const x of [-0.11, 0.11]) {
      box(0.12, 0.08, 0.27, [x, 0.04, -0.04], DARK);
      limb([x, 0.1, 0], [x, 0.9, 0], 0.075, TROUSERS);
      // Arms reach forward (carrying, holding the car): shoulder -> elbow -> hand.
      limb([x * 2.4, 1.44, 0], [x * 2.6, 1.15, -0.12], 0.058, SUIT);
      limb([x * 2.6, 1.15, -0.12], [x * 1.9, 1.05, -0.38], 0.052, SUIT);
      add(new THREE.SphereGeometry(0.06, 6, 5).translate(x * 1.9, 1.05, -0.42), GLOVES);
    }
    box(0.36, 0.18, 0.22, [0, 0.95, 0], TROUSERS);
    box(0.44, 0.52, 0.27, [0, 1.27, 0], SUIT);
    limb([0, 1.52, 0], [0, 1.58, 0], 0.06, TROUSERS);
    add(new THREE.SphereGeometry(0.155, 10, 8).translate(0, 1.7, 0), SUIT * 0.95);
    box(0.22, 0.07, 0.06, [0, 1.71, -0.13], DARK);
  } else {
    // One knee down at the wheel, leaning in, wheel gun held in both hands.
    box(0.12, 0.08, 0.27, [0.11, 0.04, -0.42], DARK);
    limb([0.11, 0.52, 0], [0.11, 0.48, -0.42], 0.08, TROUSERS); // right thigh, forward
    limb([0.11, 0.48, -0.42], [0.11, 0.08, -0.42], 0.07, TROUSERS); // right shin, down
    limb([-0.11, 0.52, 0], [-0.11, 0.08, 0.06], 0.08, TROUSERS); // left thigh, knee on the ground
    limb([-0.11, 0.08, 0.06], [-0.11, 0.06, 0.44], 0.07, TROUSERS); // left shin, back along the ground
    box(0.36, 0.18, 0.22, [0, 0.55, 0], TROUSERS);
    box(0.44, 0.5, 0.27, [0, 0.86, -0.1], SUIT, -0.35);
    for (const x of [-0.11, 0.11]) {
      limb([x * 2.4, 1.02, -0.17], [x * 2.2, 0.8, -0.38], 0.058, SUIT);
      limb([x * 2.2, 0.8, -0.38], [x * 0.9, 0.72, -0.6], 0.052, SUIT);
      add(new THREE.SphereGeometry(0.06, 6, 5).translate(x * 0.9, 0.72, -0.63), GLOVES);
    }
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 8).rotateX(Math.PI / 2).translate(0, 0.72, -0.75), DARK); // wheel gun
    limb([0, 1.08, -0.2], [0, 1.13, -0.24], 0.06, TROUSERS);
    add(new THREE.SphereGeometry(0.155, 10, 8).translate(0, 1.25, -0.3), SUIT * 0.95);
    box(0.22, 0.07, 0.06, [0, 1.25, -0.43], DARK, -0.35);
  }
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return g;
}

export class PitCrew {
  readonly group = new THREE.Group();
  /** Standing and kneeling crew (each instance lives in one of the two; the other copy is hidden). */
  private readonly crew: THREE.InstancedMesh;
  private readonly kneeling: THREE.InstancedMesh;
  /** Per box: four old wheels (off the car) and four new ones. */
  private readonly wheels: THREE.InstancedMesh;
  private readonly lollipops: THREE.InstancedMesh;
  private readonly boxes: BoxState[];
  private readonly disposables: { dispose(): void }[] = [];
  private time = 0;
  /** Called once per stop when the car is released, with the stationary time (s). */
  onRelease: ((v: Vehicle, seconds: number) => void) | null = null;

  constructor(
    private readonly pit: PitLaneData,
    teamColors: number[],
  ) {
    this.group.name = 'PitCrew';
    const n = pit.boxes.length;
    const crewGeo = crewGeometry('stand');
    const kneelGeo = crewGeometry('kneel');
    const crewMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    this.crew = new THREE.InstancedMesh(crewGeo, crewMat, n * CREW);
    this.kneeling = new THREE.InstancedMesh(kneelGeo, crewMat, n * CREW);
    const color = new THREE.Color();
    for (let b = 0; b < n; b++)
      for (let c = 0; c < CREW; c++) {
        color.setHex(teamColors[b % teamColors.length]);
        this.crew.setColorAt(b * CREW + c, color);
        this.kneeling.setColorAt(b * CREW + c, color);
      }
    // A wheel the size of the car's (0.36 m radius): black tyre, grey rim faces on both sides.
    const shade = (g: THREE.BufferGeometry, v: number) => {
      const ng = g.toNonIndexed();
      g.dispose();
      ng.setAttribute('color', new THREE.Float32BufferAttribute(new Array(ng.getAttribute('position').count * 3).fill(v), 3));
      ng.deleteAttribute('uv');
      return ng;
    };
    const tyre = shade(new THREE.CylinderGeometry(0.36, 0.36, 0.38, 18), 0.05);
    const rim = shade(new THREE.CylinderGeometry(0.24, 0.24, 0.39, 14), 0.16);
    const wheelGeo = mergeGeometries([tyre, rim])!;
    tyre.dispose();
    rim.dispose();
    const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.2 });
    this.wheels = new THREE.InstancedMesh(wheelGeo, wheelMat, n * 8);
    const pole = new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6).translate(0, 0.65, 0);
    const disc = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 16).rotateX(Math.PI / 2).translate(0, 1.38, 0);
    const lollipopGeo = mergeGeometries([pole.toNonIndexed(), disc.toNonIndexed()])!;
    pole.dispose();
    disc.dispose();
    const lollipopMat = new THREE.MeshStandardMaterial({ roughness: 0.5 });
    this.lollipops = new THREE.InstancedMesh(lollipopGeo, lollipopMat, n);
    for (const mesh of [this.crew, this.kneeling, this.wheels, this.lollipops]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.disposables.push(crewGeo, kneelGeo, crewMat, wheelGeo, wheelMat, lollipopGeo, lollipopMat);
    this.boxes = pit.boxes.map((k) => {
      const yaw = this.pathYaw(k);
      return { out: 0, pos: this.boxCentre(k, new THREE.Vector3()), yaw, sinceRelease: 99, wasStopped: false, car: null };
    });
  }

  private pathYaw(k: number): number {
    const p = this.pit.path;
    const a = p[Math.max(0, k - 1)];
    const b = p[Math.min(p.length - 1, k + 1)];
    // Car forward is -Z (as Track.poseAt).
    return Math.atan2(-(b.x - a.x), -(b.z - a.z));
  }

  private boxCentre(k: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pit.path[k]).addScaledVector(this.pit.outward[k], BOX_LANE_SHIFT);
  }

  /** Per frame, after the cars have been rendered (lifts the car on the jacks, moves its wheels). */
  update(dt: number, pitStops: PitStops): void {
    this.time += dt;
    const pit = this.pit;
    // The car each box is working on: the one stopped there, else the nearest one arriving.
    const active: (PitCrewSnapshot | null)[] = pit.boxes.map(() => null);
    for (const s of pitStops.snapshots()) {
      const k = pit.boxes[s.box];
      const cur = active[s.box];
      if (s.phase === 'stopped') active[s.box] = s;
      else if (s.phase === 'in' && s.k >= k - STEP_OUT && cur?.phase !== 'stopped' && (!cur || s.k > cur.k)) active[s.box] = s;
    }
    const color = new THREE.Color();
    pit.boxes.forEach((k, b) => {
      const st = this.boxes[b];
      const s = active[b];
      const stopped = s?.phase === 'stopped';
      if (st.wasStopped && !stopped) {
        st.sinceRelease = 0;
        const done = pitStops.lastService(b);
        if (done) this.onRelease?.(done.vehicle, done.seconds);
      }
      if (st.car && st.car !== (stopped ? s.vehicle : null)) {
        for (let w = 0; w < 4; w++) st.car.visual.setWheelOffset?.(w, 0);
        st.car = null;
      }
      if (stopped) st.car = s.vehicle;
      st.wasStopped = stopped;
      st.sinceRelease += dt;
      // Out while a car arrives / is serviced and for a moment after it leaves.
      const wantOut = s || st.sinceRelease < LINGER ? 1 : 0;
      st.out = THREE.MathUtils.clamp(st.out + Math.sign(wantOut - st.out) * dt * RUN, 0, 1);
      // Anchor: the stopped car itself, else the box.
      if (stopped) {
        const ease = 1 - Math.exp(-dt * 8);
        st.pos.lerp(_a.copy(s.vehicle.position), ease);
        const yaw = this.pathYaw(k);
        st.yaw += (yaw - st.yaw) * ease;
      } else if (!s && st.sinceRelease > LINGER) {
        this.boxCentre(k, st.pos);
        st.yaw = this.pathYaw(k);
      }
      const tau = stopped ? s.timer : 0;
      const service = stopped ? s.service : 1;
      if (stopped) {
        // Up on the jacks, down again just before the release.
        const up = phase(tau, T.liftUp) * (1 - phase(tau, [service - T_DOWN[0], service - T_DOWN[1]]));
        s.vehicle.object3D.position.y += LIFT * up;
        s.vehicle.object3D.updateMatrixWorld(true);
      }
      this.layoutBox(b, st, k, tau, service, stopped ? s.vehicle : null);
      // Lollipop: red while the car is serviced, green as it is released.
      this.lollipops.setColorAt(b, color.setHex(stopped && tau < service - T_GO[0] ? 0xe02020 : 0x22c55e));
    });
    for (const mesh of [this.crew, this.kneeling, this.wheels, this.lollipops]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Places one box's crew, wheels and lollipop. `car`: the car stopped in the box. */
  private layoutBox(b: number, st: BoxState, k: number, tau: number, service: number, car: Vehicle | null): void {
    const out = st.out * st.out * (3 - 2 * st.out);
    const running = st.out > 0.02 && st.out < 0.98;
    _q.setFromAxisAngle(UP, st.yaw);
    const idle = this.boxCentre(k, _b);
    const outward = this.pit.outward[k];
    const waitY = idle.y;
    const garageYaw = Math.atan2(-outward.x, -outward.z) + Math.PI;
    /** Car-local point (x right, z back) to world. */
    const local = (x: number, z: number, target: THREE.Vector3) => target.set(x, 0, z).applyQuaternion(_q).add(st.pos);
    /** Crew member i at car-local (x, z), or (part way) at his waiting spot in front of the garage. */
    const place = (i: number, x: number, z: number, crouch: boolean, faceYaw: number) => {
      const along = (i - (CREW - 1) / 2) * 0.8;
      _a.copy(this.pit.path[k]).addScaledVector(outward, BOX_LANE_SHIFT + 2.7);
      _a.add(_p.set(0, 0, along).applyQuaternion(_q));
      local(x, z, _p);
      _p.lerp(_a, 1 - out);
      // Running: a bouncing stride, leaning into it.
      const bob = running ? Math.abs(Math.sin(this.time * 14 + i * 1.7)) * 0.09 : 0;
      _p.y = THREE.MathUtils.lerp(waitY, st.pos.y, out) - 0.02 + bob;
      _face.setFromAxisAngle(UP, THREE.MathUtils.lerp(garageYaw, faceYaw, out));
      if (running) _face.multiply(_lean.setFromAxisAngle(X_AXIS, -0.22));
      // Kneeling once in place at the wheel; the unused pose is parked below the ground.
      const kneel = crouch && out > 0.9;
      const shown = _m.compose(_p, _face, _s.setScalar(0.95)).clone();
      _p.y = HIDDEN;
      const hidden = _m.compose(_p, _q, _s.setScalar(1));
      this.crew.setMatrixAt(b * CREW + i, kneel ? hidden : shown);
      this.kneeling.setMatrixAt(b * CREW + i, kneel ? shown : hidden);
    };
    const yaw = st.yaw;
    const carQ = car ? car.object3D.quaternion : _q;
    const wheels = car?.config.wheels;
    for (let w = 0; w < 4; w++) {
      const wp = wheels?.[w]?.position ?? { x: w % 2 ? 0.8 : -0.8, z: w < 2 ? -1.7 : 1.7 };
      const side = Math.sign(wp.x) || 1;
      const end = wp.z < 0 ? -1 : 1; // towards the nose / the gearbox
      const t = tau - STAGGER[w];
      const off = car ? phase(t, T.off) : 0;
      const carry = car ? phase(t, T.carry) : 0;
      const on = car ? phase(t, T.on) : 0;
      // The car's wheel: slides off, then the new one slides on.
      const slide = !car ? 0 : on > 0 ? HOLD_DIST * (1 - on) : OFF_DIST * off;
      car?.visual.setWheelOffset?.(w, slide);
      // Gun man kneels by the wheel, towards the middle of the car; leans in while the gun runs.
      const gun = car && t > T.gun[0] && t < T.gun[1] ? 0.12 + Math.sin(this.time * 70) * 0.015 : 0;
      place(GUN + w, wp.x + side * (0.62 - gun), wp.z - end * 0.62, true, yaw - side * (Math.PI / 2) + end * side * 0.6);
      // Off man takes the old wheel and carries it back towards the garage; on man pushes the new one on.
      place(OFF + w, wp.x + side * (OFF_DIST + 0.75 + 1.6 * carry), wp.z + end * 0.4, false, yaw - side * (Math.PI / 2));
      place(ON + w, wp.x + side * (HOLD_DIST * (1 - on) + 0.75), wp.z - end * 0.15, false, yaw - side * (Math.PI / 2));

      // Crew wheels at hub height, axle across the car.
      const hub = car?.visual.wheelHub ? car.visual.wheelHub(w, _b) : local(wp.x, wp.z, _b).setY(st.pos.y + 0.05);
      _c.set(side, 0, 0).applyQuaternion(carQ).setY(0).normalize();
      _q2.copy(carQ).multiply(AXLE);
      // Old wheel: once off the hub, in the off man's hands, then set down by the garage.
      _p.copy(hub).addScaledVector(_c, OFF_DIST + 1.6 * carry);
      _p.y += 0.25 * Math.sin(Math.PI * Math.min(carry * 1.2, 1));
      if (!car || off * OFF_DIST < WHEEL_OFF) _p.y = HIDDEN;
      this.wheels.setMatrixAt(b * 8 + w, _m.compose(_p, _q2, _s.setScalar(1)));
      // New wheel: held out (in the on man's hands while he runs out) until it is on the hub.
      _p.copy(hub).addScaledVector(_c, car ? HOLD_DIST * (1 - on) : HOLD_DIST);
      if (!car) _p.y = st.pos.y + 0.05 + 0.35 * (1 - out);
      if (st.out < 0.3 || (car && HOLD_DIST * (1 - on) < WHEEL_OFF)) _p.y = HIDDEN;
      this.wheels.setMatrixAt(b * 8 + 4 + w, _m.compose(_p, _q2, _s.setScalar(1)));
    }
    // Front jack man in front of the nose; steps aside just before the release.
    const aside = car ? phase(tau, [service - T_ASIDE[0], service - T_ASIDE[1]]) : st.sinceRelease < LINGER ? 1 : 0;
    place(FRONT_JACK, 1.9 * aside, -3.5 + 0.3 * aside, !!car && aside < 0.5, yaw + 0.8 * aside);
    place(REAR_JACK, 0, 3.2, !!car, yaw + Math.PI);
    // Release man ahead of the car on the garage side; lollipop lifted on the release.
    place(RELEASE, 1.4, -4.6, false, yaw + Math.PI);
    local(1.4 - 0.45, -4.6 + 0.3, _p);
    _p.lerp(_a.copy(this.pit.path[k]).addScaledVector(outward, BOX_LANE_SHIFT + 2.7), 1 - out);
    _p.y = st.out <= 0.5 ? HIDDEN : THREE.MathUtils.lerp(waitY, st.pos.y, out);
    const go = car ? phase(tau, [service - T_GO[0], service - T_GO[1]]) : st.sinceRelease < LINGER ? 1 : 0;
    _q2.setFromAxisAngle(UP, yaw).multiply(_lean.setFromAxisAngle(X_AXIS, 0.9 * go));
    this.lollipops.setMatrixAt(b, _m.compose(_p, _q2, _s.setScalar(1)));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
