import * as THREE from 'three';
import type { DashState } from './cars/SteeringWheel';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleConfig } from './VehicleConfig';
import type { WheelState } from './VehiclePhysics';
import { tyreGeometry } from './cars/shapes';

/** Pit stop: a wheel slid this far (m) off its hub is off the car (hidden). */
export const WHEEL_OFF = 0.4;

/**
 * Render-side representation of a car, fully separate from the physics body.
 * A GLB car only needs to implement this interface (see GltfCarVisual) —
 * VehiclePhysics never touches meshes.
 */
export interface VehicleVisual {
  /** Root placed at the (interpolated) chassis transform each frame. */
  readonly root: THREE.Object3D;
  /** Update wheel suspension travel / steering / spin. */
  updateWheels(wheels: readonly WheelState[]): void;
  /** Level of detail: false = far away (small parts hidden to save draw calls). */
  setDetail?(near: boolean): void;
  /** Tyre sidewall colour of the fitted compound. */
  setCompound?(color: number): void;
  /**
   * Pit stop: wheel i slid off its hub by `out` m (0 = fitted); past ~0.4 m it is off the car
   * and hidden (the pit crew's tyre takes over).
   */
  setWheelOffset?(i: number, out: number): void;
  /** World position of wheel i's hub (pit crew). */
  wheelHub?(i: number, target: THREE.Vector3): THREE.Vector3;
  /** Wing damage 0..1 (front, rear): drooping wings, detached past the limit; 0 = repaired. */
  setDamage?(front: number, rear: number): void;
  /**
   * The wing that just broke off (its mesh, already in the scene), handed over to
   * the track's debris so it lies where the physical piece is. Null if none.
   */
  takeDetachedWing?(): THREE.Object3D | null;
  /** Brake pedal 0..1 and speed (m/s), for glowing brake discs. */
  setBrake?(brake: number, speed: number): void;
  /** Live steering-wheel display (player car only). */
  setDash?(state: DashState): void;
  dispose(): void;
}

export interface WheelStyle {
  width: number;
  segments: number;
  tyreColor: number;
  rimColor: number;
  /** Rim radius / tyre radius (low-profile tyres = larger). */
  rimRatio?: number;
  spokes?: number;
}

/**
 * Base for cars built from primitives. Subclasses add body parts with
 * `part()`; wheels are generated from VehicleConfig. Wheel hierarchy:
 *   mount (suspension top) -> steer (yaw) -> spin (roll) -> meshes
 */
export abstract class PrimitiveCarVisual implements VehicleVisual {
  readonly root = new THREE.Group();
  private readonly steers: THREE.Object3D[] = [];
  private readonly spins: THREE.Object3D[] = [];
  /** Rims and brake discs: invisible details from a distance (tyres stay). */
  private readonly details: THREE.Object3D[] = [];
  private near = true;
  private readonly disposables: { dispose(): void }[] = [];
  /**
   * Scale applied to the body (not the wheels) when merged in optimize():
   * lets one modelled body serve cars of different size.
   */
  protected bodyScale: [number, number, number] = [1, 1, 1];

  protected constructor(config: VehicleConfig, wheelStyle: WheelStyle) {
    this.buildWheels(config, wheelStyle);
  }

  updateWheels(wheels: readonly WheelState[]): void {
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      this.steers[i].position.y = -w.suspensionLength;
      this.steers[i].rotation.y = -w.steerAngle;
      // Rolling forward (-Z) = negative rotation about +X.
      this.spins[i].rotation.x = -w.spin;
    }
  }

  setDetail(near: boolean): void {
    if (near === this.near) return;
    this.near = near;
    for (const d of this.details) d.visible = near;
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
    for (const d of this.disposables) d.dispose();
  }

  /**
   * Merges all static parts that share a material into one mesh (body) and
   * the rim parts of every wheel likewise. A car goes from ~60 to ~20 draw
   * calls — what makes a 20-car grid affordable.
   */
  optimize(): this {
    this.mergeChildren(this.root, (o) => o instanceof THREE.Mesh);
    const [sx, sy, sz] = this.bodyScale;
    if (sx !== 1 || sy !== 1 || sz !== 1) {
      for (const child of this.root.children) if (child instanceof THREE.Mesh) child.geometry.scale(sx, sy, sz);
    }
    for (const spin of this.spins) {
      for (const child of spin.children) if (child instanceof THREE.Group) this.mergeChildren(child, (o) => o instanceof THREE.Mesh);
    }
    return this;
  }

  private mergeChildren(parent: THREE.Object3D, filter: (o: THREE.Object3D) => boolean): void {
    const buckets = new Map<string, { material: THREE.Material; castShadow: boolean; geos: THREE.BufferGeometry[] }>();
    for (const child of [...parent.children]) {
      if (!filter(child)) continue;
      const mesh = child as THREE.Mesh;
      const material = mesh.material as THREE.Material;
      mesh.updateMatrix();
      // Normalize: non-indexed, position + normal only (uv/color sets differ between parts).
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      g.applyMatrix4(mesh.matrix);
      const key = `${material.uuid}:${mesh.castShadow}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { material, castShadow: mesh.castShadow, geos: [] }));
      b.geos.push(g);
      parent.remove(mesh);
    }
    for (const b of buckets.values()) {
      const merged = mergeGeometries(b.geos);
      for (const g of b.geos) g.dispose();
      if (!merged) continue;
      this.track(merged);
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.castShadow = b.castShadow;
      parent.add(mesh);
    }
  }

  protected material(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    return this.track(new THREE.MeshStandardMaterial(params));
  }

  /** Metallic car paint with a glossy clearcoat (reflects the HDRI sky). */
  protected paint(color: number, metalness = 0.55, roughness = 0.35): THREE.MeshPhysicalMaterial {
    return this.track(
      new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat: 1, clearcoatRoughness: 0.06 }),
    );
  }

  /** Dark tinted window glass. */
  protected glass(): THREE.MeshPhysicalMaterial {
    return this.track(
      new THREE.MeshPhysicalMaterial({ color: 0x0b1118, metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 }),
    );
  }

  /** Clear-coated carbon fibre / satin black. */
  protected carbon(): THREE.MeshPhysicalMaterial {
    return this.track(
      new THREE.MeshPhysicalMaterial({ color: 0x16181b, metalness: 0.3, roughness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    );
  }

  /** Adds a prepared geometry as a shadow-casting part at the origin. */
  protected mesh(geometry: THREE.BufferGeometry, material: THREE.Material, castShadow = true): THREE.Mesh {
    return this.part(geometry, material, 0, 0, 0, castShadow);
  }

  /** Adds a mesh in car-local space (+X right, +Y up, -Z forward). */
  protected part(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    castShadow = true,
  ): THREE.Mesh {
    this.track(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = castShadow;
    this.root.add(mesh);
    return mesh;
  }

  protected box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    return this.part(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  }

  protected track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private buildWheels(c: VehicleConfig, style: WheelStyle): void {
    const r = c.wheelRadius;
    const w = style.width;
    const rimR = r * (style.rimRatio ?? 0.68);
    const tyreGeo = this.track(tyreGeometry(r, w, r - rimR, style.segments));
    // Rim: dished barrel + face disc + spokes + hub, built facing +X (mirrored per side).
    const barrelGeo = this.track(new THREE.CylinderGeometry(rimR, rimR, w * 0.9, style.segments, 1, true).rotateZ(Math.PI / 2));
    const faceGeo = this.track(new THREE.CylinderGeometry(rimR * 0.98, rimR * 0.98, 0.02, style.segments).rotateZ(Math.PI / 2));
    const spokeGeo = this.track(new THREE.BoxGeometry(0.035, rimR * 0.95, 0.05).translate(0, rimR * 0.48, 0));
    const hubGeo = this.track(new THREE.CylinderGeometry(rimR * 0.2, rimR * 0.24, 0.06, 12).rotateZ(Math.PI / 2));
    const discGeo = this.track(new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.03, 20).rotateZ(Math.PI / 2));
    const tyreMat = this.material({ color: style.tyreColor, roughness: 0.92 });
    const rimMat = this.track(new THREE.MeshPhysicalMaterial({ color: style.rimColor, metalness: 0.9, roughness: 0.25, clearcoat: 0.5 }));
    const darkMat = this.material({ color: 0x15171a, roughness: 0.6, metalness: 0.4 });
    const discMat = this.material({ color: 0x6b6f75, roughness: 0.45, metalness: 0.8 });

    for (const wc of c.wheels) {
      const mount = new THREE.Object3D();
      mount.position.set(wc.position.x, wc.position.y, wc.position.z);
      const steer = new THREE.Object3D();
      const spin = new THREE.Object3D();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.castShadow = true;
      const rim = new THREE.Group();
      rim.add(new THREE.Mesh(barrelGeo, darkMat));
      const face = new THREE.Mesh(faceGeo, darkMat);
      face.position.x = w * 0.3;
      rim.add(face);
      const spokes = style.spokes ?? 5;
      for (let k = 0; k < spokes; k++) {
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.position.x = w * 0.33;
        spoke.rotation.x = (k / spokes) * Math.PI * 2;
        rim.add(spoke);
      }
      const hub = new THREE.Mesh(hubGeo, rimMat);
      hub.position.x = w * 0.34;
      rim.add(hub);
      // Outer face points away from the car.
      rim.scale.x = Math.sign(wc.position.x) || 1;
      spin.add(tyre, rim);
      this.details.push(rim);
      // Brake disc doesn't spin.
      const disc = new THREE.Mesh(discGeo, discMat);
      disc.position.x = -Math.sign(wc.position.x) * w * 0.1;
      steer.add(disc);
      this.details.push(disc);
      steer.add(spin);
      mount.add(steer);
      this.root.add(mount);
      this.steers.push(steer);
      this.spins.push(spin);
    }
  }
}
