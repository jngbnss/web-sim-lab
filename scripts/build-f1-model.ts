/**
 * Builds public/models/f1-2026.glb from the Sketchfab source model
 * ("F1 2026 concept (polygon model)" by Qvist_designs, CC-BY-4.0).
 *
 *   npm run model:f1   (source: download the glTF from Sketchfab into assets-src/)
 *
 * The source is one CAD export (~1 M triangles, one material, no parts).
 * This script:
 *  1. welds it and converts to car space (m, +X right, +Y up, -Z forward,
 *     ground at y = 0, origin midway between the axles);
 *  2. splits connected components: the 4 tyres become separate wheel meshes
 *     (centered on their axle so they can spin and steer), the rest is body;
 *  3. simplifies with meshoptimizer (near LOD + far LOD);
 *  4. paints by region into three material slots the game recolors per team:
 *     "paint" (team color), "accent" (wings, stripe), "carbon" (floor,
 *     suspension, halo); tyres into "tyre" and "rim";
 *  5. writes a quantized, meshopt-compressed GLB (KHR_mesh_quantization +
 *     EXT_meshopt_compression: 3.3 MB -> 1.1 MB; the game decodes it with MeshoptDecoder).
 */
import { Document, NodeIO, type Material, type Mesh } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { components, loadSoup, type Component, type Soup } from './f1-model-lib';

const SRC = process.argv[2] ?? 'assets-src/f1_2026_concept_polygon_model/scene.gltf';
const OUT = 'public/models/f1-2026.glb';
const BODY_TRIS = [60000, 7000];
const WHEEL_TRIS = [2500, 400];
const CREASE = (35 * Math.PI) / 180;

// Source (after the Sketchfab root matrix): millimeters, Y up, nose towards -X, axles at x ≈ -0.055 / 3.345.
const AXLE_MID = 1.645;
const soup = await loadSoup(SRC, ([x, y, z]) => [-z / 1000, y / 1000, x / 1000 - AXLE_MID]);
const comps = components(soup);
console.log(`source: ${soup.indices.length / 3} triangles, ${comps.length} components`);

const size = (c: Component) => c.max.map((v, i) => v - c.min[i]);
const isTyre = (c: Component) => {
  const [sx, sy, sz] = size(c);
  return Math.abs(sy - 0.72) < 0.03 && Math.abs(sz - 0.72) < 0.03 && sx > 0.25 && sx < 0.5;
};
const tyres = comps.filter(isTyre);
if (tyres.length !== 4) throw new Error(`expected 4 tyres, found ${tyres.length}`);
const body = comps.filter((c) => !isTyre(c));

/** Sub-soup of some components (re-indexed, unused vertices dropped). */
function extract(parts: Component[], offset = new THREE.Vector3()): Soup {
  const map = new Map<number, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (const c of parts)
    for (const t of c.tris)
      for (let k = 0; k < 3; k++) {
        const v = soup.indices[t * 3 + k];
        let n = map.get(v);
        if (n === undefined) {
          n = pos.length / 3;
          map.set(v, n);
          pos.push(soup.positions[v * 3] - offset.x, soup.positions[v * 3 + 1] - offset.y, soup.positions[v * 3 + 2] - offset.z);
        }
        idx.push(n);
      }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

await MeshoptSimplifier.ready;
function simplify(s: Soup, tris: number): Soup {
  const [indices, error] = MeshoptSimplifier.simplify(s.indices, s.positions, 3, tris * 3, 0.05, []);
  console.log(`  simplified ${s.indices.length / 3} -> ${indices.length / 3} triangles (error ${(error * 100).toFixed(2)} %)`);
  return { positions: s.positions, indices };
}

/** Splits triangles into material slots by a per-triangle classifier, with creased normals. */
function slots(s: Soup, classify: (centroid: THREE.Vector3, normal: THREE.Vector3) => string): Map<string, THREE.BufferGeometry> {
  const tri = new THREE.Triangle();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const lists = new Map<string, number[]>();
  const P = s.positions;
  for (let t = 0; t < s.indices.length; t += 3) {
    const [i, j, k] = [s.indices[t] * 3, s.indices[t + 1] * 3, s.indices[t + 2] * 3];
    a.set(P[i], P[i + 1], P[i + 2]);
    b.set(P[j], P[j + 1], P[j + 2]);
    c.set(P[k], P[k + 1], P[k + 2]);
    tri.set(a, b, c);
    tri.getMidpoint(centroid);
    tri.getNormal(normal);
    const slot = classify(centroid, normal);
    let list = lists.get(slot);
    if (!list) lists.set(slot, (list = []));
    list.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  const out = new Map<string, THREE.BufferGeometry>();
  for (const [slot, list] of lists) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    const creased = toCreasedNormals(g, CREASE);
    out.set(slot, mergeVertices(creased, 1e-4));
  }
  return out;
}

/**
 * Cuts triangles along axis-aligned planes so paint borders are straight lines
 * instead of the sawtooth of whole (often long, thin) triangles.
 */
function splitAlong(s: Soup, planes: [axis: 0 | 1 | 2, value: number][]): Soup {
  let tris: number[][] = [];
  const P = s.positions;
  for (let t = 0; t < s.indices.length; t += 3)
    tris.push([0, 1, 2].flatMap((k) => [P[s.indices[t + k] * 3], P[s.indices[t + k] * 3 + 1], P[s.indices[t + k] * 3 + 2]]));
  const lerp = (a: number[], b: number[], f: number) => a.map((v, i) => v + (b[i] - v) * f);
  for (const [axis, c] of planes) {
    const next: number[][] = [];
    for (const tri of tris) {
      const v = [tri.slice(0, 3), tri.slice(3, 6), tri.slice(6, 9)];
      const side = v.map((p) => p[axis] - c);
      const above = side.map((d) => d > 0);
      if (above[0] === above[1] && above[1] === above[2]) {
        next.push(tri);
        continue;
      }
      // Rotate so v0 is the lone vertex on its side, keeping the winding.
      const lone = above[0] !== above[1] && above[0] !== above[2] ? 0 : above[1] !== above[0] && above[1] !== above[2] ? 1 : 2;
      const [a, b, d] = [v[lone], v[(lone + 1) % 3], v[(lone + 2) % 3]];
      const [sa, sb, sd] = [side[lone], side[(lone + 1) % 3], side[(lone + 2) % 3]];
      const ab = lerp(a, b, sa / (sa - sb));
      const ad = lerp(a, d, sa / (sa - sd));
      next.push([...a, ...ab, ...ad], [...ab, ...b, ...d], [...ab, ...d, ...ad]);
    }
    tris = next;
  }
  const positions = new Float32Array(tris.flat());
  return { positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) };
}

// ---- Region painting (car space). Front axle z = -1.70, rear z = +1.70. ----
const FRONT_AXLE = -1.7;
const FRONT_WING_Z = -2.05;
const FRONT_WING_TOP = 0.33;
const REAR_WING_Z = 1.85;
const REAR_WING_BOTTOM = 0.45;
const REAR_AXLE = 1.7;
/** Every plane bodySlot() tests against. */
const BORDERS: [0 | 1 | 2, number][] = [
  [1, 0.2], [1, 0.3], [1, 0.45], [1, 0.7], [1, 0.76],
  [2, -2.0], [2, FRONT_WING_Z], [2, REAR_WING_Z], [1, FRONT_WING_TOP], [1, REAR_WING_BOTTOM], [2, FRONT_AXLE - 0.45], [2, FRONT_AXLE + 0.45], [2, REAR_AXLE - 0.45], [2, REAR_AXLE + 0.45], [2, -0.95], [2, -0.1],
  [0, -0.4], [0, -0.2], [0, -0.12], [0, 0.12], [0, 0.2], [0, 0.4],
];
function bodySlot(p: THREE.Vector3): string {
  const ax = Math.abs(p.x);
  // Front wing (below and beside the nose) and rear wing; beam wing and diffuser below it.
  if (p.z < -2.0 && p.y < 0.3 && ax > 0.12) return 'accent';
  if (p.z > 1.85) return p.y > 0.45 ? 'accent' : 'carbon';
  // Floor, plank, floor edges and the sidepod undercut.
  if (p.y < 0.2) return 'carbon';
  // Suspension arms, brake ducts and wheel-side bodywork around the axles.
  const nearAxle = Math.min(Math.abs(p.z - FRONT_AXLE), Math.abs(p.z - REAR_AXLE)) < 0.45;
  if (nearAxle && ax > 0.2 && p.y < 0.7) return 'carbon';
  // Halo and cockpit surround.
  if (p.y > 0.76 && p.z > -0.95 && p.z < -0.1 && ax < 0.4) return 'carbon';
  return 'paint';
}

const io = new NodeIO().registerExtensions([KHRMeshQuantization, EXTMeshoptCompression]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('F1');
const materials = new Map<string, Material>();
const material = (name: string) => {
  let m = materials.get(name);
  if (!m) materials.set(name, (m = doc.createMaterial(name)));
  return m;
};

function toMesh(name: string, parts: Map<string, THREE.BufferGeometry>): Mesh {
  const mesh = doc.createMesh(name);
  for (const slot of [...parts.keys()].sort()) {
    const g = parts.get(slot)!;
    const prim = doc
      .createPrimitive()
      .setMaterial(material(slot))
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(g.attributes.position.array as Float32Array).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(g.attributes.normal.array as Float32Array).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.index!.array)).setBuffer(buffer));
    mesh.addPrimitive(prim);
  }
  return mesh;
}

/**
 * Detachable parts for damage: the front wing with the nose tip (one assembly,
 * like the real car) and the rear wing. Split after simplification along the
 * same planes, so the parts fit the body exactly.
 */
const PARTS: [name: string, test: (c: THREE.Vector3) => boolean][] = [
  ['FrontWing', (c) => c.z < FRONT_WING_Z && c.y < FRONT_WING_TOP],
  ['RearWing', (c) => c.z > REAR_WING_Z && c.y > REAR_WING_BOTTOM],
  ['Body', () => true],
];
function partition(s: Soup): Map<string, Soup> {
  const out = new Map<string, number[]>();
  const c = new THREE.Vector3();
  const P = s.positions;
  for (let t = 0; t < s.indices.length; t += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(P[s.indices[t + k] * 3], P[s.indices[t + k] * 3 + 1], P[s.indices[t + k] * 3 + 2]));
    c.divideScalar(3);
    const [name] = PARTS.find(([, test]) => test(c))!;
    let list = out.get(name);
    if (!list) out.set(name, (list = []));
    list.push(s.indices[t], s.indices[t + 1], s.indices[t + 2]);
  }
  return new Map([...out].map(([k, v]) => [k, { positions: s.positions, indices: new Uint32Array(v) }]));
}

const bodySoup = extract(body);
BODY_TRIS.forEach((tris, lod) => {
  console.log(`body LOD${lod}`);
  for (const [name, part] of partition(splitAlong(simplify(bodySoup, tris), BORDERS))) {
    scene.addChild(doc.createNode(`${name}_LOD${lod}`).setMesh(toMesh(`${name}_LOD${lod}`, slots(part, bodySlot))));
  }
});

const RIM_RADIUS = 0.27;
for (const t of tyres) {
  const center = new THREE.Vector3((t.min[0] + t.max[0]) / 2, (t.min[1] + t.max[1]) / 2, (t.min[2] + t.max[2]) / 2);
  const name = `Wheel_${center.z < 0 ? 'F' : 'R'}${center.x < 0 ? 'L' : 'R'}`;
  const wheel = extract([t], center);
  const node = doc.createNode(name).setTranslation([center.x, center.y, center.z]);
  WHEEL_TRIS.forEach((tris, lod) => {
    console.log(`${name} LOD${lod}`);
    const parts = slots(simplify(wheel, tris), (p) => (Math.hypot(p.y, p.z) > RIM_RADIUS ? 'tyre' : 'rim'));
    node.addChild(doc.createNode(`${name}_LOD${lod}`).setMesh(toMesh(`${name}_LOD${lod}`, parts)));
  });
  scene.addChild(node);
}

await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 10 }));
await MeshoptEncoder.ready;
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(OUT, doc);
const bytes = (await import('node:fs')).statSync(OUT).size;
console.log(`wrote ${OUT} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
