/**
 * Team racing lines (scripts/bake-team-lines.ts) check, per circuit:
 * - every team is at least as quick on its own line as on the shared one
 *   (recomputed with the game's speed model, not just the baked numbers);
 * - the lines use no more road than the shared line does (the optimizer clamps its
 *   control points; the curve between them can swing a little past, as on the shared line);
 * - a downforce car and a low-drag car really get different lines.
 *
 *   npx tsx scripts/teamline-test.ts [circuit ...]     (default: monza suzuka spa silverstone monaco)
 */
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { CARS } from '../src/vehicle/cars';
import { RacingLine } from '../src/world/RacingLine';
import { teamLinePath } from '../src/world/TeamLines';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

let failures = 0;
function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['monza', 'suzuka', 'spa', 'silverstone', 'monaco'];
const teams = CARS.filter((c) => c.spec.cls === 'formula');

for (const id of ids) {
  const layout = loadLayout(id);
  console.log(layout.name);
  const physics = await PhysicsWorld.create(1 / 60);
  const track = new ProceduralTrack(physics, layout, { treesPerKm: 0 });
  if (track.street) {
    check(teamLinePath(layout.teamLines, 'f1-mclaren', track, layout.minTimeLine) === null, 'street circuit: everyone on the shared line');
    continue;
  }
  if (!layout.teamLines || !layout.minTimeLine) {
    check(false, 'team lines baked');
    continue;
  }
  const points = track.getCenterline();
  const rights = track.getRights();
  let sharedWidest = 0;
  layout.minTimeLine.forEach(([x, z], i) => (sharedWidest = Math.max(sharedWidest, Math.abs((x - points[i].x) * rights[i].x + (z - points[i].z) * rights[i].z))));
  const limit = sharedWidest + 0.1;
  const lap = (path: [number, number][], car: (typeof teams)[number]) => {
    const line = new RacingLine(path, car.physics, { heights: track.heightsFor(path), profileOnly: true });
    const t = line.idealLapTime;
    line.dispose();
    return t;
  };
  let slower = 0;
  const onShared: string[] = [];
  let worstGain = Infinity;
  let bestGain = 0;
  let widest = 0;
  const offsets = new Map<string, Float64Array>();
  for (const team of teams) {
    const path = teamLinePath(layout.teamLines, team.id, track, layout.minTimeLine);
    // No line for a team: its own line was no quicker once rounded, it drives the shared one.
    if (!path) {
      onShared.push(team.id);
      continue;
    }
    const gain = lap(layout.minTimeLine, team) - lap(path, team);
    // Offsets are stored in whole cm: allow that rounding.
    if (gain < -0.01) slower++;
    worstGain = Math.min(worstGain, gain);
    bestGain = Math.max(bestGain, gain);
    const off = new Float64Array(points.length);
    for (let i = 0; i < points.length; i++) {
      off[i] = (path[i][0] - points[i].x) * rights[i].x + (path[i][1] - points[i].z) * rights[i].z;
      widest = Math.max(widest, Math.abs(off[i]));
    }
    offsets.set(team.id, off);
  }
  check(slower === 0 && onShared.length < teams.length / 2, `every team at least as quick on its own line: gains ${worstGain.toFixed(3)} .. ${bestGain.toFixed(3)} s${onShared.length ? ` (on the shared line: ${onShared.join(', ')})` : ''}`);
  check(widest <= limit, `no wider than the shared line: widest ${widest.toFixed(2)} m, shared ${sharedWidest.toFixed(2)} m (half width ${track.halfWidth} m)`);
  const a = offsets.get('f1-mclaren');
  const b = offsets.get('f1-williams');
  if (a && b) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    check(diff > 0.3, `McLaren (downforce) and Williams (low drag) lines differ by up to ${diff.toFixed(2)} m`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
