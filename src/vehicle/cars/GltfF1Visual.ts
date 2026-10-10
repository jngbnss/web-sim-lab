import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { VehicleConfig } from '../VehicleConfig';
import type { WheelState } from '../VehiclePhysics';
import { WHEEL_OFF, type VehicleVisual } from '../VehicleVisual';
import { helmetTexture, liveryMaterial, numberTexture, rimMaterial, tyreMaterial, type Livery } from './F1Livery';
import { SteeringWheel, type DashState } from './SteeringWheel';

/**
 * 2026 F1 car from public/models/f1-2026.glb (built by scripts/build-f1-model.ts
 * from "F1 2026 concept (polygon model)" by Qvist_designs, CC-BY-4.0).
 *
 * The GLB holds two body LODs and four wheels (each with two LODs), already in
 * car space with the ground at y = 0. Material slots are named "paint",
 * "accent", "carbon", "tyre" and "rim"; every car gets its own team-colored
 * materials while all cars share the geometry.
 */

export const F1_MODEL_CREDIT = 'F1 car: "F1 2026 concept" by Qvist_designs (CC-BY-4.0)';

/** Wing mounting points in model space (pivots for drooping when damaged). */
const FRONT_WING_PIVOT = new THREE.Vector3(0, 0.3, -2.05);
const REAR_WING_PIVOT = new THREE.Vector3(0, 0.5, 1.85);
/** Damage at which a wing comes off (matches Damage.DETACH). */
const DETACH = 0.6;

/** A wing that came off: tumbles to the ground next to where it broke off, then stays. */
interface Debris {
  object: THREE.Object3D;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
}

/** Driver's helmet in model space (open cockpit between z -0.45 and -0.05). */
const HELMET = new THREE.Vector3(0, 0.8, -0.22);
/** Steering wheel hub (model space) and wheel turn per radian of front-wheel steer. */
const STEERING_WHEEL = new THREE.Vector3(0, 0.68, -0.6);
const STEERING_RATIO = 5;
/** Carbon brake disc radius (2026: 278 mm discs front). */
const DISC_RADIUS = 0.14;
/** Small parts (model space). */
const TCAM = new THREE.Vector3(0, 1.1, 0.24);
const RAIN_LIGHT = new THREE.Vector3(0, 0.3, 2.42);
const ENDPLATE_LIGHT = new THREE.Vector3(0.575, 0.66, 2.38);

/** Geometry shared by every car. */
let partsCache: { helmet: THREE.BufferGeometry; visor: THREE.BufferGeometry; tcam: THREE.BufferGeometry; rainLight: THREE.BufferGeometry; endplateLight: THREE.BufferGeometry } | null = null;
function sharedParts() {
  partsCache ??= {
    helmet: new THREE.SphereGeometry(0.135, 28, 18),
    // Visor opening facing forward (-z).
    visor: new THREE.SphereGeometry(0.1375, 24, 6, Math.PI * 1.15, Math.PI * 0.7, Math.PI * 0.4, Math.PI * 0.17),
    tcam: new THREE.BoxGeometry(0.075, 0.045, 0.13),
    rainLight: new THREE.BoxGeometry(0.11, 0.05, 0.025),
    endplateLight: new THREE.BoxGeometry(0.012, 0.16, 0.02),
  };
  return partsCache;
}
/** Tyre compound sidewall colours (Pirelli: soft red, medium yellow, hard white). */
export const COMPOUND_COLORS = { hyper: 0xc04bff, soft: 0xe10600, medium: 0xffd200, hard: 0xf0f0f0, inter: 0x43b02a, wet: 0x1f6fff } as const;

/** Tyre centre height in the model (the CAD tyres sink 3 cm into the ground). */
const MODEL_WHEEL_Y = 0.33;
const G = 9.81;
/**
 * The CAD tyres are 2022-25 size (front 330 / rear 430 mm wide incl. bulge).
 * 2026 tyres are 25 / 30 mm narrower than those: 280 / 375 mm.
 */
const TYRE_WIDTH_SCALE = { front: 0.28 / 0.33, rear: 0.375 / 0.43 };

let template: THREE.Group | null = null;
let loading: Promise<void> | null = null;

/** Loads the shared model once. Cars created before it is ready fall back to primitives. */
export function loadF1Model(baseUrl: string): Promise<void> {
  loading ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`${baseUrl}models/f1-2026.glb`).then((gltf) => {
    // Undo KHR_mesh_quantization once: float positions in model meters (relative
    // to each LOD's parent: the scene for the body, the wheel centre for wheels)
    // with identity transforms below, so shaders can paint by model-space position.
    // Multi-material nodes are Groups: the dequantization transform sits on them.
    gltf.scene.updateMatrixWorld(true);
    const lods: THREE.Object3D[] = [];
    gltf.scene.traverse((o) => {
      if (/_LOD[0-9]$/.test(o.name) && !/_LOD[0-9]$/.test(o.parent?.name ?? '')) lods.push(o);
    });
    const inv = new THREE.Matrix4();
    for (const lod of lods) {
      inv.copy(lod.parent!.matrixWorld).invert();
      lod.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const src = o.geometry.attributes.position as THREE.BufferAttribute;
        const pos = new THREE.Float32BufferAttribute(src.count * 3, 3);
        for (let i = 0; i < src.count; i++) pos.setXYZ(i, src.getX(i), src.getY(i), src.getZ(i));
        o.geometry.setAttribute('position', pos);
        o.geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        repairNormals(o.geometry);
      });
      lod.traverse((o) => {
        o.position.set(0, 0, 0);
        o.quaternion.identity();
        o.scale.set(1, 1, 1);
      });
    }
    template = gltf.scene;
  });
  return loading;
}

/**
 * The source model has ~1000 vertices with zero-length normals (degenerate
 * triangles after simplification). Lit with clearcoat they turn NaN or glint
 * at full sun and post-processing smears them into white blotches. Give each
 * one the area-weighted normal of the triangles around it.
 */
function repairNormals(geo: THREE.BufferGeometry): void {
  const src = geo.attributes.normal as THREE.BufferAttribute | undefined;
  if (!src) return;
  const count = src.count;
  const bad: number[] = [];
  for (let i = 0; i < count; i++) if (!(Math.hypot(src.getX(i), src.getY(i), src.getZ(i)) > 0.5)) bad.push(i);
  if (!bad.length) return;
  const nor = new THREE.Float32BufferAttribute(count * 3, 3);
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(src.getX(i), src.getY(i), src.getZ(i));
    if (v.lengthSq() > 0) v.normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  const acc = new Float32Array(count * 3);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const index = geo.index;
  const tri = index ? index.count : count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < tri; t += 3) {
    const i0 = index ? index.getX(t) : t;
    const i1 = index ? index.getX(t + 1) : t + 1;
    const i2 = index ? index.getX(t + 2) : t + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const n = b.sub(a).cross(c.sub(a)); // length = 2 x area
    for (const i of [i0, i1, i2]) {
      acc[i * 3] += n.x;
      acc[i * 3 + 1] += n.y;
      acc[i * 3 + 2] += n.z;
    }
  }
  for (const i of bad) {
    const v = new THREE.Vector3(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]);
    if (v.lengthSq() < 1e-20) v.set(0, 1, 0);
    v.normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  geo.setAttribute('normal', nor);
}

export function f1ModelReady(): boolean {
  return template !== null;
}

interface Lods {
  near: THREE.Object3D;
  far: THREE.Object3D;
}

export class GltfF1Visual implements VehicleVisual {
  readonly root = new THREE.Group();
  private readonly steers: THREE.Object3D[] = [];
  private readonly spins: THREE.Object3D[] = [];
  private readonly lods: Lods[] = [];
  private readonly materials: THREE.Material[] = [];
  private frontWing!: THREE.Group;
  private rearWing!: THREE.Group;
  private readonly debris: Debris[] = [];
  private lastDebrisUpdate = 0;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private near = true;
  private readonly textures: THREE.Texture[] = [];
  /** Sidewall band colour (tyre compound). */
  private readonly band = { value: new THREE.Color(COMPOUND_COLORS.medium) };
  private light!: THREE.MeshStandardMaterial;
  /** Steering wheel (turns with the front wheels; seen from the driver's-eye camera). */
  private steeringWheel!: SteeringWheel;
  /** Brake discs: one shared glowing material, heated by braking, cooled by airflow. */
  private discMaterial!: THREE.MeshStandardMaterial;
  /** Brake glow seen through the wheel covers (rim shader uniform). */
  private rimGlow: THREE.Color | null = null;
  private readonly discs: THREE.Mesh[] = [];
  private brakeTemp = 0;
  private lastBrakeTime = 0;
  private lastSpin = 0;
  private lastSpinTime = 0;
  private spinRate = 0;
  private decel = 0;

  constructor(config: VehicleConfig, livery: Livery, driver = 0) {
    if (!template) throw new Error('F1 model not loaded');
    const raceNumber = livery.numbers[driver % 2];
    const number = numberTexture(raceNumber, livery.primary);
    this.textures.push(number);
    // Bodywork and wings share one livery material (regions, carbon and decals are placed in the shader).
    const paint = this.own(liveryMaterial(livery, { slot: 0, number }));
    const slots: Record<string, THREE.Material> = {
      paint,
      accent: paint,
      carbon: this.own(liveryMaterial(livery, { slot: 1, number: null })),
      tyre: this.own(tyreMaterial(this.band)),
      rim: this.own(rimMaterial(livery.rim)),
    };
    this.rimGlow = (slots.rim.userData.rimGlow as { value: THREE.Color } | undefined)?.value ?? null;
    const instance = (src: THREE.Object3D): THREE.Object3D => {
      const copy = src.clone();
      copy.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.material = slots[(o.material as THREE.Material).name] ?? slots.paint;
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return copy;
    };

    // Body sits so the model's wheel centres meet the physics wheels at static load.
    const wheelY = config.wheels[0]?.position.y ?? 0;
    const staticSag = (config.mass * G) / config.wheels.length / config.suspensionStiffness;
    const bodyY = wheelY - (config.suspensionRestLength - staticSag) - MODEL_WHEEL_Y;
    const body = new THREE.Group();
    body.position.y = bodyY;
    const near = instance(template.getObjectByName('Body_LOD0')!);
    const far = instance(template.getObjectByName('Body_LOD1')!);
    far.visible = false;
    body.add(near, far);
    this.lods.push({ near, far });
    // Detachable wings, each in a group pivoting at its mounting point.
    for (const [name, pivot] of [['FrontWing', FRONT_WING_PIVOT], ['RearWing', REAR_WING_PIVOT]] as const) {
      const group = new THREE.Group();
      group.name = name;
      group.position.copy(pivot);
      const wNear = instance(template.getObjectByName(`${name}_LOD0`)!);
      const wFar = instance(template.getObjectByName(`${name}_LOD1`)!);
      wNear.position.copy(pivot).negate();
      wFar.position.copy(pivot).negate();
      wFar.visible = false;
      group.add(wNear, wFar);
      this.lods.push({ near: wNear, far: wFar });
      body.add(group);
      if (name === 'FrontWing') this.frontWing = group;
      else this.rearWing = group;
    }
    // Driver: painted helmet (stripes, crown, number) with a tinted, glossy visor.
    const helmetTex = helmetTexture(livery, raceNumber);
    this.textures.push(helmetTex);
    const parts = sharedParts();
    const helmetMat = this.own(new THREE.MeshPhysicalMaterial({ map: helmetTex, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.04 }));
    const visorMat = this.own(new THREE.MeshPhysicalMaterial({ color: 0x07080b, roughness: 0.04, metalness: 0.5, clearcoat: 1 }));
    const helmet = new THREE.Mesh(parts.helmet, helmetMat);
    const visor = new THREE.Mesh(parts.visor, visorMat);
    for (const m of [helmet, visor]) {
      m.position.copy(HELMET);
      m.scale.set(1, 0.96, 1.1);
    }
    helmet.castShadow = true;
    body.add(helmet, visor);
    // T-cam pod on the airbox: black on the first car, fluorescent yellow on the second (like the real grid).
    const tcam = new THREE.Mesh(parts.tcam, this.own(new THREE.MeshPhysicalMaterial({ color: driver % 2 ? 0xd4f000 : 0x111111, roughness: 0.35, clearcoat: 1 })));
    tcam.position.copy(TCAM);
    body.add(tcam);
    // Steering wheel in front of the driver, tilted towards the helmet.
    this.steeringWheel = new SteeringWheel(this.textures, (m) => this.own(m), this.geometries);
    const column = new THREE.Group();
    column.position.copy(STEERING_WHEEL);
    column.rotation.x = -0.32;
    column.add(this.steeringWheel.group);
    body.add(column);
    // Rain light (crash structure) and the endplate strips: flash while the car harvests energy (lifting / braking).
    this.light = this.own(new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a10, emissiveIntensity: 0.3, roughness: 0.3 }));
    const rain = new THREE.Mesh(parts.rainLight, this.light);
    rain.position.copy(RAIN_LIGHT);
    body.add(rain);
    for (const s of [-1, 1]) {
      const strip = new THREE.Mesh(parts.endplateLight, this.light);
      strip.position.set(s * ENDPLATE_LIGHT.x, ENDPLATE_LIGHT.y, ENDPLATE_LIGHT.z);
      this.rearWing.add(strip);
      strip.position.sub(REAR_WING_PIVOT);
    }
    this.root.add(body);

    // Brake discs on the inboard side of each wheel (they steer, they don't spin). Near
    // cars only: from further away the glow through the rims (rim shader) is what shows.
    this.discMaterial = this.own(new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.6, roughness: 0.45, emissive: 0x000000 }));
    const discGeo = new THREE.CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.034, 20).rotateZ(Math.PI / 2);
    this.geometries.push(discGeo);

    // Wheels: mount (model x/z, physics height) -> steer -> spin -> mesh.
    const names = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
    for (const wc of config.wheels) {
      const name = names[(wc.position.z > 0 ? 2 : 0) + (wc.position.x > 0 ? 1 : 0)];
      const src = template.getObjectByName(name)!;
      const mount = new THREE.Object3D();
      mount.position.set(src.position.x, wc.position.y, src.position.z);
      const steer = new THREE.Object3D();
      const spin = new THREE.Object3D();
      spin.scale.x = wc.position.z > 0 ? TYRE_WIDTH_SCALE.rear : TYRE_WIDTH_SCALE.front;
      const wheelNear = instance(src.getObjectByName(`${name}_LOD0`)!);
      const wheelFar = instance(src.getObjectByName(`${name}_LOD1`)!);
      wheelFar.visible = false;
      spin.add(wheelNear, wheelFar);
      this.lods.push({ near: wheelNear, far: wheelFar });
      steer.add(spin);
      const inboard = -Math.sign(src.position.x) * (wc.position.z > 0 ? 0.13 : 0.11);
      const disc = new THREE.Mesh(discGeo, this.discMaterial);
      disc.position.x = inboard;
      disc.visible = this.near;
      steer.add(disc);
      this.discs.push(disc);
      mount.add(steer);
      this.root.add(mount);
      this.steers.push(steer);
      this.spins.push(spin);
    }
  }

  setDamage(front: number, rear: number): void {
    this.wingDamage(this.frontWing, front, 1);
    this.wingDamage(this.rearWing, rear, -1);
    if (front === 0 && rear === 0) {
      for (const d of this.debris) d.object.removeFromParent();
      this.debris.length = 0;
    }
  }

  takeDetachedWing(): THREE.Object3D | null {
    const d = this.debris.pop();
    return d ? d.object : null;
  }

  /** Droops a damaged wing; past DETACH it breaks off as debris (once). */
  private wingDamage(wing: THREE.Group, amount: number, side: 1 | -1): void {
    if (amount >= DETACH) {
      if (!wing.visible) return;
      wing.visible = false;
      const scene = this.root.parent;
      if (!scene) return;
      const piece = wing.clone();
      piece.visible = true;
      wing.updateWorldMatrix(true, false);
      wing.matrixWorld.decompose(piece.position, piece.quaternion, piece.scale);
      scene.add(piece);
      const fwd = new THREE.Vector3(0, 0, -side).applyQuaternion(this.root.quaternion);
      this.debris.push({
        object: piece,
        velocity: fwd.multiplyScalar(4).add(new THREE.Vector3((Math.random() - 0.5) * 6, 3, (Math.random() - 0.5) * 6)),
        spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        age: 0,
      });
      return;
    }
    wing.visible = true;
    // Bent mounting: the wing tips down (front) / back (rear) and sags.
    wing.rotation.x = side * amount * 0.35;
    wing.position.y = (side > 0 ? FRONT_WING_PIVOT.y : REAR_WING_PIVOT.y) - amount * 0.06;
  }

  private updateDebris(): void {
    const now = performance.now() / 1000;
    const dt = Math.min(now - (this.lastDebrisUpdate || now), 0.05);
    this.lastDebrisUpdate = now;
    for (const d of this.debris) {
      if (d.age > 3) continue;
      d.age += dt;
      d.velocity.y -= 9.81 * dt;
      d.object.position.addScaledVector(d.velocity, dt);
      if (d.object.position.y < 0.05) {
        d.object.position.y = 0.05;
        d.velocity.multiplyScalar(0.3);
        d.velocity.y = Math.abs(d.velocity.y) * 0.3;
        d.spin.multiplyScalar(0.4);
      }
      d.object.rotation.x += d.spin.x * dt;
      d.object.rotation.y += d.spin.y * dt;
      d.object.rotation.z += d.spin.z * dt;
    }
  }

  updateWheels(wheels: readonly WheelState[]): void {
    if (this.debris.length) this.updateDebris();
    // Harvesting: front wheels slowing down -> flash the rain lights (4 Hz).
    const now = performance.now() / 1000;
    const dt = now - this.lastSpinTime;
    if (wheels.length && dt > 0.02) {
      const rate = (wheels[0].spin - this.lastSpin) / dt;
      if (this.lastSpinTime > 0) this.decel = this.decel * 0.7 + 0.3 * ((this.spinRate - rate) / dt);
      this.spinRate = rate;
      this.lastSpin = wheels[0].spin;
      this.lastSpinTime = now;
      const harvesting = this.decel > 25 && Math.abs(rate) > 8;
      this.light.emissiveIntensity = harvesting ? (Math.floor(now * 8) % 2 ? 6 : 0.3) : 0.3;
    }
    // F1 steering is quick: ~±90° at the wheel for ~±18° at the tyres.
    let steer = 0;
    for (const w of wheels) if (Math.abs(w.steerAngle) > Math.abs(steer)) steer = w.steerAngle;
    // steerAngle > 0 turns right (see the wheel mounts above); +Z rotation would turn the wheel left.
    this.steeringWheel.group.rotation.z = -steer * STEERING_RATIO;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      this.steers[i].position.y = -w.suspensionLength;
      this.steers[i].rotation.y = -w.steerAngle;
      this.spins[i].rotation.x = -w.spin;
    }
  }

  /** Live steering-wheel display (player car). */
  setDash(state: DashState): void {
    this.steeringWheel.setDash(state);
  }

  /**
   * Brake temperature (0 = cold, 1 = ~1000 °C): heats with brake pressure x
   * speed, cools faster at speed (airflow). Drives the disc glow.
   */
  setBrake(brake: number, speed: number): void {
    const now = performance.now() / 1000;
    const dt = Math.min(now - (this.lastBrakeTime || now), 0.1);
    this.lastBrakeTime = now;
    if (dt <= 0) return;
    // Assisted braking modulates around the grip limit (pedal ~0.25-0.5), so heat follows pressure softly.
    const heat = Math.sqrt(brake) * Math.min(speed / 70, 1) * 1.4;
    const cool = (0.08 + speed / 900) * this.brakeTemp;
    this.brakeTemp = Math.max(0, Math.min(1, this.brakeTemp + (heat - cool) * dt));
    const t = Math.max(0, (this.brakeTemp - 0.25) / 0.75);
    if (t <= 0) {
      if (this.discMaterial.emissiveIntensity !== 0) {
        this.discMaterial.emissiveIntensity = 0;
        this.rimGlow?.setRGB(0, 0, 0);
      }
      return;
    }
    // Dull red -> orange -> yellow-white as it gets hotter.
    this.discMaterial.emissive.setRGB(1, 0.18 + 0.55 * t * t, 0.04 + 0.2 * t * t * t);
    this.discMaterial.emissiveIntensity = 0.6 + 3.4 * t;
    this.rimGlow?.copy(this.discMaterial.emissive).multiplyScalar(this.discMaterial.emissiveIntensity * 0.9);
  }

  setDetail(near: boolean): void {
    if (near === this.near) return;
    this.near = near;
    for (const l of this.lods) {
      l.near.visible = near;
      l.far.visible = !near;
    }
    for (const d of this.discs) d.visible = near;
  }

  /** Sidewall colour of the fitted compound. */
  setCompound(color: number): void {
    this.band.value.set(color);
  }

  setWheelOffset(i: number, out: number): void {
    const spin = this.spins[i];
    if (!spin) return;
    spin.position.x = Math.sign(spin.parent!.parent!.position.x || 1) * out;
    spin.visible = out < WHEEL_OFF;
  }

  wheelHub(i: number, target: THREE.Vector3): THREE.Vector3 {
    return this.steers[i].getWorldPosition(target);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const d of this.debris) d.object.removeFromParent();
    // Body geometry belongs to the shared template; only per-car resources go.
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    for (const g of this.geometries) g.dispose();
  }

  private own<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}
