/**
 * Bakes the minimum-lap-time racing line of a circuit for the F1 car into
 * src/world/tracks/data/<Name>_mintime.json (see src/world/MinTimeLine.ts),
 * and renders a top-down comparison with the minimum-curvature line.
 *
 *   npx tsx scripts/bake-raceline.ts [monza]
 */
import { writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { CHASSIS_GROUPS, PhysicsWorld } from '../src/physics/PhysicsWorld';
import { findCar } from '../src/vehicle/cars';
import { optimizeMinTime } from '../src/world/MinTimeLine';
import { RacingLine } from '../src/world/RacingLine';
import { minCurvatureOffsets, STREET_MARGIN } from '../src/world/RacingLineOptimizer';
import { teamLineLimit } from '../src/world/TeamLines';
import { ProceduralTrack } from '../src/world/Track';
import { CIRCUITS } from './fetch-osm';
import { loadLayout } from './tracks-node';

const id = process.argv[2] ?? 'monza';
/**
 * Line centre to wall face at least this far (m): half a car (0.95) plus room for how far
 * the AI strays from the line through a tight hairpin (~1.2 m inside at Monaco).
 */
const WALL_CLEARANCE = 2.75;
const file = CIRCUITS.find((c) => c.id === id)!.file;
const physics = await PhysicsWorld.create(1 / 60);
const track = new ProceduralTrack(physics, loadLayout(id), { treesPerKm: 0 });
const car = findCar('f1-ferrari').physics;
const input = { points: track.getCenterline(), rights: track.getRights(), halfWidth: track.halfWidth, margin: track.street ? STREET_MARGIN : undefined };
const start = minCurvatureOffsets(input);
const t0 = performance.now();
// Objective = the game's own speed model (RacingLine), so what is optimized is what the AI drives.
const gameLapTime = (path: [number, number][]) => {
  const line = new RacingLine(path, car, { heights: track.heightsFor(path), profileOnly: true });
  const t = line.idealLapTime;
  line.dispose();
  return t;
};
// The curve between control points must not swing past the margin either (it did by up to
// ~0.9 m: Monza's line came within 0.68 m of the edge).
// And never closer than WALL_CLEARANCE to a wall: at Monaco's hairpin the inside wall stands
// ~4.8 m from the centreline, well inside the road's nominal half width (the line came
// within 1 m of it and the cars hit it).
const res = optimizeMinTime({ ...input, start, limit: wallAwareLimit(teamLineLimit(track)) }, car, console.log, gameLapTime);
console.log(`${id}: min-curvature ${res.before.toFixed(2)} s -> min-time ${res.after.toFixed(2)} s (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
writeFileSync(new URL(`../src/world/tracks/data/${file}_mintime.json`, import.meta.url), JSON.stringify({ car: 'f1-2026', lapTime: +res.after.toFixed(3), path: res.path }));

/** Per sample: the limit, reduced where a wall stands closer (rays across the track to the barriers). */
function wallAwareLimit(limit: number[]): number[] {
  physics.step(); // the scene queries see the barrier colliders after one step
  const { rapier, world } = physics;
  const pts = track.getCenterline();
  const rights = track.getRights();
  return limit.map((l, i) => {
    let wall = Infinity;
    for (const s of [-1, 1]) {
      const ray = new rapier.Ray({ x: pts[i].x, y: pts[i].y + 0.4, z: pts[i].z }, { x: rights[i].x * s, y: 0, z: rights[i].z * s });
      const hit = world.castRay(ray, 30, true, undefined, CHASSIS_GROUPS);
      if (hit) wall = Math.min(wall, hit.timeOfImpact);
    }
    return Math.max(0.5, Math.min(l, wall - WALL_CLEARANCE));
  });
}

// Top-down image: road (grey), min-curvature (blue), min-time (red).
const pts = track.getCenterline();
const xs = pts.map((p) => p.x);
const zs = pts.map((p) => p.z);
const [x0, x1, z0, z1] = [Math.min(...xs) - 30, Math.max(...xs) + 30, Math.min(...zs) - 30, Math.max(...zs) + 30];
const W = 1400;
const H = Math.round((W * (z1 - z0)) / (x1 - x0));
const img = new Uint8Array(W * H * 4).fill(255);
const dot = (x: number, z: number, r: number, c: [number, number, number]) => {
  const px = Math.round(((x - x0) / (x1 - x0)) * W);
  const pz = Math.round(((z - z0) / (z1 - z0)) * H);
  for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    const i = ((pz + b) * W + px + a) * 4;
    if (px + a < 0 || px + a >= W || pz + b < 0 || pz + b >= H) continue;
    img.set(c, i);
  }
};
const scale = W / (x1 - x0);
pts.forEach((p) => dot(p.x, p.z, Math.round(track.halfWidth * scale), [205, 205, 205]));
pts.forEach((p, i) => dot(p.x + start[i] * input.rights[i].x, p.z + start[i] * input.rights[i].z, 1, [40, 90, 230]));
res.path.forEach(([x, z]) => dot(x, z, 1, [230, 30, 30]));
writeFileSync(process.argv[3] ?? `${id}-raceline.jpg`, jpeg.encode({ data: img, width: W, height: H }, 90).data);
