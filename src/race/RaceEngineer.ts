import type { TeamRadio } from '../audio/TeamRadio';
import type { Vehicle } from '../vehicle/Vehicle';
import type { RacingLine } from '../world/RacingLine';
import type { Track } from '../world/Track';
import type { PitStops } from './PitStops';
import type { ControlMessage } from './RaceControl';
import type { RaceManager, Racer } from './RaceManager';

/**
 * The player's race engineer: watches the race and decides what goes on the
 * team radio (CrewChief-style situations, our own lines): lap reports and
 * gaps, attack / defend, tyre wear and "box, box", damage and punctures,
 * yellow flags for crashes just ahead, places won and lost, pit stops,
 * braking advice at slow corners (once per corner), the VSC and the safety car
 * (out, in this lap, green), last lap and the flag. Priorities: 2 =
 * now (damage, crash ahead, box), 1 = soon, 0 = chatter (at least 25 s apart,
 * dropped when stale; see TeamRadio).
 */

/** Racing line samples are ~2.5 m apart (same as the centerline). */
const SAMPLE_M = 2.5;
/** Slow corners for braking advice: racing-line minimum below this (m/s, ~200 km/h). */
const SLOW_CORNER = 56;
/** Braking-advice zone around a corner's slowest point (samples before / after). */
const ZONE_BEFORE = 50;
const ZONE_AFTER = 30;
/** Seconds a flag change must hold before the radio call (the VSC often becomes the safety car). */
const FLAG_WAIT = 1.5;
const FLAG_LINES = { vsc: 'vsc', 'vsc-ending': 'vsc_ending', sc: 'safety_car', 'sc-in': 'sc_in', green: 'green' } as const;

interface Corner {
  apex: number;
  target: number;
}

export class RaceEngineer {
  private lastState: string;
  private lastPos = 0;
  private posSince = 0;
  private reportedPos = 0;
  private lastPit: string | null = null;
  private tyreStage = 0;
  private wingCalled = false;
  private punctureCalled = false;
  private floorCalled = false;
  private lastLapCalled = false;
  private yellowAt = -Infinity;
  private closeAt = -Infinity;
  /** Since when the car ahead / behind has been within 0.8 s (s of race time). */
  private closeSince = { ahead: Infinity, behind: Infinity };
  private racingSince = Infinity;
  private lapsDone = 0;
  private adviceAt = -Infinity;
  private time = 0;
  private lineIndex = -1;
  /** Race control's flag: under the VSC / safety car there is no fight and no lap to push. */
  private neutral = false;
  /** Race control's latest flag, called out once it has held for FLAG_WAIT. */
  private flagCall: { m: Exclude<ControlMessage, 'yellow'>; at: number } | null = null;
  private readonly corners: Corner[];
  /** Corners already given a braking tip (once per corner per race). */
  private readonly advised = new Set<number>();
  /** The corner the player is in (index into corners) and how it went. */
  private zone: { corner: number; minSpeed: number; off: boolean; traffic: boolean } | null = null;

  constructor(
    private readonly radio: TeamRadio,
    private readonly race: RaceManager,
    private readonly player: Vehicle,
    private readonly track: Track,
    private readonly line: RacingLine,
    private readonly pits: PitStops | null,
  ) {
    this.lastState = race.state;
    this.corners = slowCorners(line);
  }

  private get me(): Racer | undefined {
    return this.race.player;
  }

  /** Every fixed step, after the race update. `lap` = the lap timer's event of this step. */
  fixedUpdate(dt: number, lap: 'lap' | 'best' | null): void {
    this.time += dt;
    const race = this.race;
    const me = this.me;
    if (!me) return;

    if (race.state !== this.lastState) {
      if (race.state === 'racing') {
        this.radio.say('radio_check', {}, 1);
        this.racingSince = this.time;
      }
      if (race.state === 'finished') {
        const pos = race.positionOf(me);
        this.radio.say(pos === 1 ? 'win' : 'finish', { pos }, 2);
      }
      this.lastState = race.state;
    }
    if (race.state !== 'racing' || me.finished) return;

    // --- VSC / safety car ---------------------------------------------------------------
    if (this.flagCall && this.time - this.flagCall.at >= FLAG_WAIT) {
      this.radio.say(FLAG_LINES[this.flagCall.m], {}, 2);
      if (this.flagCall.m === 'green') this.neutral = false;
      this.flagCall = null;
    }

    const standings = race.standings();
    const pos = standings.indexOf(me) + 1;

    // --- laps ----------------------------------------------------------------------
    if (lap) {
      this.lapsDone++;
      const lapNo = race.lapOf(me);
      if (lapNo === race.laps && race.laps > 1 && !this.lastLapCalled) {
        this.lastLapCalled = true;
        this.radio.say('last_lap', {}, 1);
      } else if (lap === 'best' && this.lapsDone > 1) {
        this.radio.say('best_lap', {}, 0);
      } else if (pos === 1 && standings[1]) {
        const gap = race.gap(me, standings[1]);
        if (gap !== null) this.radio.say('lap_leading', { gap }, 0);
      } else if (pos > 1) {
        const gap = race.gap(standings[pos - 2], me);
        if (gap !== null) this.radio.say('lap_report', { pos, gap }, 0);
      }
    }

    // --- places won / lost (once they hold for 2 s) -----------------------------------
    if (pos !== this.lastPos) {
      this.lastPos = pos;
      this.posSince = this.time;
    } else if (this.reportedPos === 0) {
      this.reportedPos = pos;
    } else if (pos !== this.reportedPos && this.time - this.posSince > 2 && this.time - this.racingSince > 30) {
      this.radio.say(pos < this.reportedPos ? 'gained' : 'lost', { pos }, 0);
      this.reportedPos = pos;
    }

    // --- close fights: within 0.8 s for 3 s, at most every 150 s --------------------------
    const behind = standings[pos];
    const ahead = standings[pos - 2];
    const gb = behind ? race.gap(me, behind) : null;
    const ga = ahead ? race.gap(ahead, me) : null;
    this.closeSince.behind = gb !== null && gb < 0.8 ? Math.min(this.closeSince.behind, this.time) : Infinity;
    this.closeSince.ahead = ga !== null && ga < 0.8 ? Math.min(this.closeSince.ahead, this.time) : Infinity;
    if (!this.neutral && this.time - this.closeAt > 150 && this.time - this.racingSince > 30) {
      if (this.time - this.closeSince.behind > 3) {
        this.radio.say('defend', {}, 0);
        this.closeAt = this.time;
      } else if (this.time - this.closeSince.ahead > 3) {
        this.radio.say('attack', {}, 0);
        this.closeAt = this.time;
      }
    }

    // --- tyres and damage ---------------------------------------------------------------
    const tyres = this.player.tyres;
    if (tyres.maxWear < 0.2) this.tyreStage = 0;
    if (this.tyreStage === 0 && tyres.maxWear >= 0.45) {
      this.tyreStage = 1;
      this.radio.say('tyres_wearing', {}, 1);
    } else if (this.tyreStage === 1 && tyres.maxWear >= 0.62) {
      this.tyreStage = 2;
      this.radio.say('box_tyres', {}, 2);
    }
    const dmg = this.player.damage;
    if (!dmg.any) {
      this.wingCalled = this.floorCalled = false;
    }
    if (!tyres.anyPuncture) this.punctureCalled = false;
    if (tyres.anyPuncture && !this.punctureCalled) {
      this.punctureCalled = true;
      this.radio.say('puncture', {}, 2);
    } else if (dmg.front >= 0.6 && !this.wingCalled) {
      this.wingCalled = true;
      this.radio.say('wing_damage', {}, 2);
    } else if (dmg.floor >= 0.3 && !this.floorCalled) {
      this.floorCalled = true;
      this.radio.say('floor_damage', {}, 1);
    }

    // --- pit stops ---------------------------------------------------------------------
    const phase = this.pits?.phase(this.player) ?? null;
    if (phase !== this.lastPit) {
      if (phase === 'requested' && this.lastPit === null) this.radio.say('pit_confirm', {}, 1);
      if (phase === null && this.lastPit === 'out') this.radio.say('pit_out', { pos }, 1);
      this.lastPit = phase;
    }

    if (this.neutral) this.zone = null;
    else this.brakingAdvice(dt);
  }

  /**
   * Race control changed the flag (VSC, safety car, green). Local yellows have their own call
   * (onDamage). Called after a short wait so a VSC that turns into the safety car a moment
   * later is one call, not two.
   */
  onFlag(m: ControlMessage): void {
    if (m === 'yellow') return;
    // Back to racing (fights, braking tips) once the green has been called.
    if (m !== 'green') this.neutral = true;
    this.flagCall = { m, at: this.time };
  }

  /** A car was damaged (impact callback): a crash just ahead of the player is a yellow flag. */
  onDamage(v: Vehicle): void {
    const me = this.me;
    if (!me || v === this.player || this.race.state !== 'racing' || this.neutral || this.time - this.yellowAt < 30) return;
    const other = this.race.racers.find((r) => r.vehicle === v);
    if (!other) return;
    const n = this.track.getCenterline().length;
    let ahead = (other.progress - me.progress) % n;
    if (ahead < 0) ahead += n;
    if (ahead * SAMPLE_M > 60 && ahead * SAMPLE_M < 700) {
      this.yellowAt = this.time;
      this.radio.say('yellow', {}, 2);
    }
  }

  /**
   * Slow corners: how fast did the player get through, against the racing line's
   * target? Far slower with nobody in the way: "brake later". Off the road in the
   * corner: "brake earlier". At most one tip a minute.
   */
  private brakingAdvice(_dt: number): void {
    if (!this.corners.length) return;
    const v = this.player;
    this.lineIndex = this.line.nearestFrom(v.position, this.lineIndex);
    const n = this.line.speeds.length;
    const i = this.lineIndex;
    const rel = (apex: number) => {
      let d = i - apex;
      if (d > n / 2) d -= n;
      if (d < -n / 2) d += n;
      return d;
    };
    if (this.zone) {
      const z = this.zone;
      const d = rel(this.corners[z.corner].apex);
      z.minSpeed = Math.min(z.minSpeed, v.physics.forwardSpeed);
      // All four wheels off (car centre past the edge by more than half a car), not a kerb clip.
      if (Math.abs(this.track.lateral(v.position)) > this.track.halfWidth + 1.2) z.off = true;
      if (this.carAhead(25)) z.traffic = true;
      if (d > ZONE_AFTER || d < -ZONE_BEFORE) {
        this.zone = null;
        if (this.time - this.adviceAt < 60 || z.traffic || this.advised.has(z.corner)) return;
        const target = this.corners[z.corner].target;
        const tip = z.off ? 'brake_earlier' : z.minSpeed < target * 0.78 ? 'brake_later' : null;
        if (tip) {
          this.radio.say(tip, {}, 0);
          this.adviceAt = this.time;
          this.advised.add(z.corner);
        }
      }
      return;
    }
    const k = this.corners.findIndex((c) => {
      const d = rel(c.apex);
      return d >= -ZONE_BEFORE && d <= ZONE_AFTER;
    });
    if (k >= 0) this.zone = { corner: k, minSpeed: Infinity, off: false, traffic: false };
  }

  private carAhead(metres: number): boolean {
    const me = this.me;
    if (!me) return false;
    return this.race.racers.some((r) => r !== me && r.progress > me.progress && (r.progress - me.progress) * SAMPLE_M < metres);
  }
}

/** Local minima of the racing line's target speed below SLOW_CORNER, at least 150 m apart. */
function slowCorners(line: RacingLine): Corner[] {
  const s = line.speeds;
  const n = s.length;
  const out: Corner[] = [];
  for (let i = 0; i < n; i++) {
    if (s[i] >= SLOW_CORNER) continue;
    let isMin = true;
    for (let k = -20; k <= 20 && isMin; k++) if (k && s[(i + k + n) % n] < s[i]) isMin = false;
    if (!isMin) continue;
    if (out.length && i - out[out.length - 1].apex < 60) continue;
    out.push({ apex: i, target: s[i] });
  }
  return out;
}
