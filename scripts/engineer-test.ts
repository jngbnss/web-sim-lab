/**
 * Race engineer check: a headless race where the "player" car is AI-driven,
 * printing what the engineer would say on the team radio and when.
 *
 *   npx tsx scripts/engineer-test.ts [track] [laps] [playerSlot] [--sc]
 *
 * --sc: two cars stop on the track 30 s in (until 60 s), so race control calls the
 * safety car (no safety car vehicle here: it goes in when the leader starts a new lap).
 */
import type { TeamRadio } from '../src/audio/TeamRadio';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { AIDriver } from '../src/race/AIDriver';
import { applyImpacts } from '../src/race/Impacts';
import { LapTimer } from '../src/race/LapTimer';
import { RaceControl } from '../src/race/RaceControl';
import { RaceEngineer } from '../src/race/RaceEngineer';
import { RaceManager, type Racer } from '../src/race/RaceManager';
import { radioText } from '../src/audio/TeamRadio';
import { findCar } from '../src/vehicle/cars';
import { Vehicle } from '../src/vehicle/Vehicle';
import { RacingLine } from '../src/world/RacingLine';
import { racingLineFor } from '../src/world/RacingLineOptimizer';
import { ProceduralTrack } from '../src/world/Track';
import { loadLayout } from './tracks-node';

const withSc = process.argv.includes('--sc');
const [trackId = 'monza', lapsArg = '3', slotArg = '9'] = process.argv.slice(2).filter((a) => a !== '--sc');
const dt = 1 / 60;
const physics = await PhysicsWorld.create(dt);
const track = new ProceduralTrack(physics, loadLayout(trackId), { treesPerKm: 0 });
const car = findCar('f1-ferrari');
const linePath = racingLineFor(track);
const line = new RacingLine(linePath, car.physics, { heights: track.heightsFor(linePath) });
const playerSlot = Number(slotArg);
const racers: Racer[] = [];
const vehicles: Vehicle[] = [];
for (let slot = 0; slot < 20; slot++) {
  const v = new Vehicle(physics, car.physics, car.createVisual(), track.gridPose(slot), car.gearbox);
  v.physics.aeroInAir = track.elevated;
  const r = Math.sin(slot * 12.9898) * 43758.5453;
  const rand = r - Math.floor(r);
  const pace = slot === playerSlot ? 0.99 : 0.97 - (slot / 20) * 0.07 + (rand - 0.5) * 0.04;
  vehicles.push(v);
  racers.push({ name: `CAR${slot + 1}`, vehicle: v, ai: new AIDriver(v, line, track, { pace, lane: (rand - 0.5) * 2.4, aggression: rand }), isPlayer: slot === playerSlot, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color: 0 });
}
const race = new RaceManager(track, racers, Number(lapsArg));
const player = racers[playerSlot].vehicle;
let t = 0;
const said: string[] = [];
const radio = {
  say: (id: Parameters<TeamRadio['say']>[0], vars = {}, priority = 0) => said.push(`  t=${t.toFixed(1).padStart(6)}s [${priority}] ${id}: ${radioText(id, vars, 'ko')}`),
} as unknown as TeamRadio;
const engineer = new RaceEngineer(radio, race, player, track, line, null);
const lapTimer = new LapTimer(track.getCenterline().length, track.nearestIndex(player.position), 'engineer-test');
const byCollider = new Map(vehicles.map((v) => [v.physics.collider.handle, v] as [number, Vehicle]));
const HOLD = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };
const rc = withSc ? new RaceControl(track) : null;
if (rc) rc.onMessage = (m) => {
  said.push(`  t=${t.toFixed(1).padStart(6)}s race control: ${m}`);
  engineer.onFlag(m);
};
const stopped = (slot: number) => withSc && slot >= 18 && t > 30 && t < 60;
let leaderLap = 0;
const limit = (track.length * Number(lapsArg)) / 12 + 90;
while (t < limit && race.state !== 'finished') {
  racers.forEach((r, slot) => r.vehicle.fixedUpdate(race.frozen || stopped(slot) ? HOLD : r.ai!.update(dt, vehicles), dt));
  physics.step();
  for (const v of vehicles) v.snapshot();
  applyImpacts(physics, byCollider, dt, (v) => engineer.onDamage(v));
  for (const r of racers)
    if ((r.vehicle.isFlipped() && r.vehicle.physics.speed < 3) || track.isOutOfBounds(r.vehicle.position) || r.ai!.unstuckCount >= 3) {
      r.vehicle.teleport(track.getResetPose(r.vehicle.position));
      r.ai!.resetState();
      r.ai!.unstuckCount = 0;
      race.resync(r);
    }
  race.update(dt);
  if (rc && !race.frozen) {
    rc.update(dt, racers, race.time, null, () => false);
    const lap = Math.floor(race.standings()[0].progress / track.getCenterline().length);
    if (rc.flag === 'sc-in' && lap > leaderLap) rc.restart();
    leaderLap = lap;
    for (const r of racers) r.ai!.rules.noPassing = rc.noOvertaking(r);
  }
  if (!race.frozen) lapTimer.update(track.nearestIndex(player.position), dt);
  engineer.fixedUpdate(dt, race.frozen ? null : lapTimer.event);
  t += dt;
}
engineer.fixedUpdate(dt, null);
console.log(`${trackId}, ${lapsArg} laps, player from P${playerSlot + 1}: ${said.length} radio calls`);
console.log(said.join('\n'));
