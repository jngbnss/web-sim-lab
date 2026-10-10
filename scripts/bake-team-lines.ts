/**
 * Bakes a racing line per team for a circuit: the minimum-lap-time line
 * (src/world/MinTimeLine.ts) refined for each team's car, starting from the
 * shared line in <Name>_mintime.json. A downforce car carries more speed through
 * fast bends and can take them tighter; a low-drag, powerful car gains more from
 * a straighter exit onto a long straight. Same objective as bake-raceline.ts:
 * the game's own speed model (RacingLine), for that car.
 *
 * Writes src/world/tracks/data/<Name>_teamlines.json: per team the control
 * offsets (cm to 0.1 across the track, one every 8 samples: whole cm moved Spa's lap
 * time by a few hundredths through the vertical curvature) and the lap times.
 *
 *   npx tsx scripts/bake-team-lines.ts [circuit ...]     (default: all)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { CARS } from '../src/vehicle/cars';
import { controlsOf, optimizeMinTime } from '../src/world/MinTimeLine';
import { RacingLine } from '../src/world/RacingLine';
import { STREET_MARGIN } from '../src/world/RacingLineOptimizer';
import { teamLineLimit } from '../src/world/TeamLines';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout, REAL_CIRCUITS } from './tracks-node';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : REAL_CIRCUITS.map(([id]) => id);
// Street circuits keep the shared line for everyone (see src/world/TeamLines.ts).
const STREET = ['monaco', 'jeddah', 'baku', 'singapore', 'lasvegas'];
const teams = CARS.filter((c) => c.spec.cls === 'formula');
const dataUrl = (f: string) => new URL(`../src/world/tracks/data/${f}`, import.meta.url);

for (const id of ids.filter((x) => !STREET.includes(x))) {
  const file = REAL_CIRCUITS.find(([cid]) => cid === id)![2];
  const physics = await PhysicsWorld.create(1 / 60);
  const track = new ProceduralTrack(physics, loadLayout(id), { treesPerKm: 0 });
  const points = track.getCenterline();
  const rights = track.getRights();
  const shared = (JSON.parse(readFileSync(dataUrl(`${file}_mintime.json`), 'utf8')) as { path: [number, number][] }).path;
  if (shared.length !== points.length) throw new Error(`${id}: shared line has ${shared.length} samples, track ${points.length}`);
  // Per-sample offsets of the shared line (the optimizer reads them at its control points).
  const start = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) start[i] = (shared[i][0] - points[i].x) * rights[i].x + (shared[i][1] - points[i].z) * rights[i].z;
  const input = { points, rights, halfWidth: track.halfWidth, margin: track.street ? STREET_MARGIN : undefined, start, limit: teamLineLimit(track, shared) };
  const out: Record<string, { shared: number; own: number; cm: number[] }> = {};
  const t0 = performance.now();
  for (const team of teams) {
    const car = team.physics;
    const lapTime = (path: [number, number][]) => {
      const line = new RacingLine(path, car, { heights: track.heightsFor(path), profileOnly: true });
      const t = line.idealLapTime;
      line.dispose();
      return t;
    };
    const res = optimizeMinTime(input, car, undefined, lapTime, [0.6, 0.3, 0.15]);
    const ctrl = controlsOf(points, rights, res.path);
    out[team.id] = { shared: +res.before.toFixed(3), own: +res.after.toFixed(3), cm: Array.from(ctrl, (o) => Math.round(o * 1000) / 10) };
    console.log(`${id} ${team.id}: shared line ${res.before.toFixed(2)} s -> own ${res.after.toFixed(2)} s`);
  }
  writeFileSync(dataUrl(`${file}_teamlines.json`), JSON.stringify({ samples: points.length, ctrl: 8, teams: out }));
  console.log(`${id}: ${teams.length} team lines in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
