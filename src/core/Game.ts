import * as THREE from 'three';
import { watchRenderer } from '../ui/Diagnostics';
import { CAMERA_LABELS, CAMERA_MODES, FollowCamera, type CameraMode } from '../camera/FollowCamera';
import { CarAudio, EngineVoice } from '../audio/EngineSound';
import { AudioSystem } from '../audio/AudioSystem';
import { TeamRadio } from '../audio/TeamRadio';
import { urlWith, type SimConfig } from '../config';
import { GamepadInput } from '../input/GamepadInput';
import { InputManager } from '../input/InputManager';
import { KeyboardInput } from '../input/KeyboardInput';
import { Benchmark } from '../performance/Benchmark';
import { DynamicResolution } from '../performance/DynamicResolution';
import { QUALITY } from '../performance/Quality';
import { QualityGovernor } from '../performance/QualityGovernor';
import { PostFx } from '../render/PostFx';
import { TyreSmoke } from '../render/TyreSmoke';
import { DrivingFx } from '../render/DrivingFx';
import { PerformanceMonitor } from '../performance/PerformanceMonitor';
import { PhysicsDebugRenderer } from '../physics/PhysicsDebugRenderer';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { HUD } from '../ui/HUD';
import { Minimap } from '../ui/Minimap';
import { Vehicle } from '../vehicle/Vehicle';
import { CARS, opponentsFor, type CarDefinition } from '../vehicle/cars';
import { liveryFor } from '../vehicle/cars/F1Livery';
import { COMPOUND_COLORS } from '../vehicle/cars/GltfF1Visual';
import { COMPOUND_LABELS, COMPOUND_NAMES, COMPOUNDS, TRACK_GRIP, type Compound } from '../vehicle/Tyres';
import { readStartTyre } from '../ui/TyrePicker';
import { PitStops } from '../race/PitStops';
import { updateSlipstream } from '../race/Slipstream';
import { PitCrew } from '../world/PitCrew';
import { applyImpacts } from '../race/Impacts';
import { DebrisField, type DebrisEvent } from '../race/Debris';
import { straightZones, updateRules2026 } from '../race/Rules2026';
import { teamLinePath } from '../world/TeamLines';
import { DebrisMesh } from '../render/DebrisMesh';
import { AIDriver } from '../race/AIDriver';
import { LapTimer } from '../race/LapTimer';
import { RaceManager, type Racer } from '../race/RaceManager';
import { Penalties, WARNINGS } from '../race/Penalties';
import { RaceControl, VSC_SPEED } from '../race/RaceControl';
import { SafetyCar } from '../race/SafetyCar';
import { RaceEngineer } from '../race/RaceEngineer';
import type { VehicleInput } from '../input/VehicleInput';
import { Environment } from '../world/Environment';
import { buildLandmarks, landmarkClear } from '../world/Landmarks';
import { readWeather, weatherPostFx, weatherTheme, WeatherFx } from '../world/Weather';
import { RacingLine } from '../world/RacingLine';
import { racingLineFor } from '../world/RacingLineOptimizer';
import { applyTerrainImagery, buildTerrain } from '../world/Terrain';
import { applySatelliteTint, drapeOnGround, groundField, loadRealTerrain, loadSatellite, REAL_TERRAIN_CREDIT, trackMask, type Ground, type RealTerrain } from '../world/RealTerrain';
import { themeFor, type WorldTheme } from '../world/themes';
import { applyTrackTextures } from '../world/TrackTextures';
import { ProceduralTrack, type Surface, type Track } from '../world/Track';
import type { TrackLayout } from '../world/TrackLayout';
import { GameLoop } from './GameLoop';
import { F1_MODEL_CREDIT, f1ModelReady, GltfF1Visual, loadF1Model } from '../vehicle/cars/GltfF1Visual';
import type { NetRace } from '../net/NetRace';

/** Timing-tower label: team abbreviation + race number (e.g. "FER 16"). */
const TEAM_ABBR: Record<string, string> = {
  'f1-ferrari': 'FER', 'f1-mercedes': 'MER', 'f1-redbull': 'RBR', 'f1-mclaren': 'MCL', 'f1-aston': 'AMR',
  'f1-alpine': 'ALP', 'f1-williams': 'WIL', 'f1-racingbulls': 'RB', 'f1-haas': 'HAA', 'f1-audi': 'AUD',
};
function carLabel(def: CarDefinition, driver: number): string {
  const livery = liveryFor(def.id, def.spec.color, def.spec.accent ?? 0xffffff);
  return `${TEAM_ABBR[def.id] ?? def.spec.brand.slice(0, 3).toUpperCase()} ${livery.numbers[driver % 2]}`;
}

/** Player's dot on the minimap. */
const PLAYER_DOT = 0xffd23f;

/** Input used while cars wait on the grid. */
const HOLD: VehicleInput = { throttle: 0, brake: 1, steer: 0, handbrake: 1 };

/** Seconds a car may stay flipped before it is put back on its wheels. */
const FLIP_RESET_DELAY = 2.5;
/** Seconds a car may be outside the barriers before it is put back on track. */
const OUT_OF_BOUNDS_DELAY = 0.5;

/** Arcade surface model: grip multiplier and extra deceleration (m/s²). */
const SURFACES: Record<Surface, { grip: number; drag: number }> = {
  asphalt: { grip: 1, drag: 0 },
  kerb: { grip: 0.95, drag: 0.3 },
  // Grass: tyres slide (low μ) but little rolling drag — you skate across it.
  grass: { grip: 0.32, drag: 1.2 },
  // Gravel: loose and deep — little grip and it bogs the car down.
  gravel: { grip: 0.4, drag: 6.5 },
};

/** Wheel names for messages, in the cars' wheel order (FL, FR, RL, RR). */
const CORNER_NAMES = ['왼쪽 앞', '오른쪽 앞', '왼쪽 뒤', '오른쪽 뒤'];

/**
 * Composition root: wires renderer, physics, world, player car, input,
 * camera and instrumentation together and drives them from the GameLoop.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly perf = new PerformanceMonitor();
  readonly input = new InputManager();
  readonly followCamera: FollowCamera;
  readonly environment: Environment;
  readonly track: Track;
  readonly player: Vehicle;
  /** Every car on track (player first). */
  readonly vehicles: Vehicle[] = [];
  readonly race: RaceManager | null = null;
  private readonly aiFlipTime = new Map<Vehicle, number>();
  readonly loop: GameLoop;

  private readonly hud: HUD;
  private readonly debugRenderer: PhysicsDebugRenderer | null = null;
  private flippedTime = 0;
  /** Seconds the player has been crawling off the road or against a wall (shows the reset hint). */
  private stuckTime = 0;
  private outTime = 0;
  /** Real ground around the track (null = procedural backdrop). */
  private ground: Ground | null = null;
  private disposeForest: (() => void) | null = null;
  /** Automatic pit stops (circuits with a pit lane). */
  private pitStops: PitStops | null = null;
  private pitCrew: PitCrew | null = null;
  /** Track limits (warnings, time penalties). */
  private penalties: Penalties | null = null;
  /** Yellow flags and the virtual safety car. */
  private raceControl: RaceControl | null = null;
  /** Player's place on the racing line (VSC speed). */
  private vscIndex = -1;
  /** The safety car, and its bookkeeping (leader lap at the restart, gone for this incident). */
  private safetyCar: SafetyCar | null = null;
  private scLeaderLap = 0;
  private scDone = false;
  private readonly teamBox: Map<string, number>;
  /** Compound the player will get at the next stop. */
  private nextCompound: Compound = 'hard';
  /** Chassis collider handle -> car, for impact damage. */
  private readonly byCollider = new Map<number, Vehicle>();
  private readonly aiOutTime = new Map<Vehicle, number>();
  private readonly dynamicResolution: DynamicResolution | null;
  /** Gives up shadows / post-processing / draw distance when even the lowest resolution is too slow. */
  private qualityGovernor: QualityGovernor | null = null;
  private postFx: PostFx | null = null;
  /** Smoke from locked / sliding tyres. */
  private readonly tyreSmoke = new TyreSmoke();
  /** Carbon shards and broken wings lying on the track. */
  private readonly debris = new DebrisField((Math.random() * 2 ** 32) >>> 0);
  private readonly debrisMesh = new DebrisMesh(this.debris);
  /** 2026 active aero zones (per centreline sample). */
  private aeroZones: Uint8Array = new Uint8Array(0);
  /** Tyre marks, live steering-wheel display, camera shake input. */
  private drivingFx!: DrivingFx;
  /** Latched lap event from fixed steps, consumed by the next rendered frame. */
  private lapEvent: 'lap' | 'best' | null = null;
  /** Engineer on the team radio (race only; subtitles even with the sound off). */
  private readonly radio: TeamRadio;
  private engineer: RaceEngineer | null = null;
  readonly racingLine: RacingLine;
  readonly lapTimer: LapTimer;
  private readonly audio: AudioSystem | null = null;
  private carAudio: CarAudio | null = null;
  /** 3D engine sounds of the opponents. */
  private readonly voices = new Map<Vehicle, EngineVoice>();
  private readonly _camDir = new THREE.Vector3();
  /** Car model of each opponent (engine sound, name). */
  private readonly carOf = new Map<Vehicle, CarDefinition>();
  /** Speed profiles per car model (the player's one is also the visible line). */
  private readonly rivalLines = new Map<string, RacingLine>();
  /** The circuit's shared racing line and the per-team refinements of it. */
  private sharedLinePath: [number, number][] = [];
  private teamLines: TrackLayout['teamLines'];
  /** Benchmark mode: the player's car is driven by an AI and frames are recorded. */
  private readonly autopilot: AIDriver | null = null;
  private readonly bench: Benchmark | null = null;
  readonly theme: WorldTheme;
  private readonly terrain: THREE.Mesh;
  private readonly minimap: Minimap;
  /** Weather / time of day (menu or ?weather=&time=) and its effects. */
  private readonly weather = readWeather();
  private readonly weatherPost = weatherPostFx(this.weather);
  private weatherFx: WeatherFx | null = null;
  private landmarks: { dispose(): void } | null = null;

  private constructor(
    private readonly container: HTMLElement,
    readonly config: SimConfig,
    readonly physics: PhysicsWorld,
    readonly car: CarDefinition,
    layout: TrackLayout,
    private readonly realTerrain: RealTerrain | null = null,
    /** Multiplayer race (grid from the room, remote cars, host clock); null = single player. */
    private readonly net: NetRace | null = null,
  ) {
    // --- renderer -----------------------------------------------------
    // With post-processing, SMAA in the chain replaces the canvas MSAA.
    this.renderer = new THREE.WebGLRenderer({ antialias: config.antialias && !config.postfx, powerPreference: 'high-performance' });
    watchRenderer(this.renderer);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, config.pixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = config.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const theme = weatherTheme(themeFor(layout.id, config.theme), this.weather);
    // Real hills on the horizon are worth seeing: clearer air than the procedural backdrop needs.
    this.theme = realTerrain ? { ...theme, fogDensity: theme.fogDensity * 0.55 } : theme;
    this.renderer.toneMappingExposure = this.theme.exposure;
    container.appendChild(this.renderer.domElement);
    this.dynamicResolution = config.dynamicResolution
      ? new DynamicResolution(this.renderer, Math.min(window.devicePixelRatio, config.pixelRatio))
      : null;

    // --- world --------------------------------------------------------
    this.environment = new Environment(this.scene, { shadows: config.shadows, shadowMapSize: config.shadowMapSize, theme: this.theme });
    // Pit boxes in team order, marked in each team's colour.
    const teams = CARS.filter((c) => c.cls === car.cls);
    const teamColors = teams.map((c) => liveryFor(c.id, c.spec.color, c.spec.accent ?? 0xffffff).primary);
    this.track = new ProceduralTrack(physics, layout, {
      treesPerKm: config.treesPerKm,
      scenery: layout.scenery,
      pitBoxColors: teamColors,
      realTerrain,
    });
    this.teamBox = new Map(teams.map((c, i) => [c.id, i]));
    this.scene.add(this.track.root);
    // Real relief: the landscape, the grass plane and the OSM scenery follow the
    // DEM relative to the nearby track height (the track itself stays flat).
    // Circuits with real road heights (Spa, Suzuka) build and drape their own ground.
    const ground = this.track.ground ?? (realTerrain ? groundField(realTerrain, this.track.getCenterline()) : null);
    this.ground = ground;
    if (ground && !this.track.ground) {
      for (const name of ['Grass', 'OsmScenery']) {
        const o = this.track.root.getObjectByName(name);
        if (o) drapeOnGround(o, ground.height);
      }
    }
    this.terrain = buildTerrain(this.track.bounds, this.theme.terrain, 7, realTerrain, ground ? ground.height : null, this.track.ground ? 90 : undefined);
    this.scene.add(this.terrain);
    const landmarks = buildLandmarks(layout.id, this.track, (x, z) => ground?.height(x, z) ?? 0);
    this.scene.add(landmarks.group);
    this.landmarks = landmarks;
    // Racing line computed on the game's own (widened) road, not the real-width dataset line.
    // Baked minimum-lap-time line when the circuit has one, else minimum curvature.
    // Shared line for the circuit; every team drives its own refinement of it where baked.
    this.sharedLinePath = layout.minTimeLine ?? racingLineFor(this.track);
    this.teamLines = layout.teamLines;
    this.racingLine = this.lineFor(car);
    this.scene.add(this.racingLine.mesh);
    this.lapTimer = new LapTimer(this.track.getCenterline().length, this.track.spawnIndex, `best:${car.id}:${layout.id}`);

    // --- player + opponents ----------------------------------------------
    const plan = net?.plan ?? null;
    const opponents = plan ? plan.slots.length - 1 : Math.max(0, Math.min(19, Math.round(config.ai)));
    const total = opponents + 1;
    // Player starts mid-field; with no opponents it's a free practice session.
    const playerSlot = plan ? Math.max(0, plan.slots.findIndex((s) => s.id === net!.localId)) : Math.floor(total / 2);
    const playerPose = opponents > 0 || plan ? this.track.gridPose(playerSlot) : this.track.getSpawnPose();
    this.player = new Vehicle(physics, car.physics, car.createVisual(undefined, plan?.slots[playerSlot]?.driver ?? 0), playerPose, car.gearbox);
    this.scene.add(this.player.object3D);
    this.scene.add(this.tyreSmoke.mesh);
    this.scene.add(this.debrisMesh.group);
    this.aeroZones = straightZones(this.track);
    this.vehicles.push(this.player);

    if (plan) {
      this.race = new RaceManager(this.track, this.netGrid(plan, playerSlot), Math.max(1, plan.laps));
    } else if (opponents > 0) {
      const racers: Racer[] = [];
      // Same-class rivals closest in performance; quicker cars start further up.
      const rivals = opponentsFor(car, opponents).sort((a, b) => b.stats.pi - a.stats.pi);
      // Each distinct rival car gets its own speed profile on the shared racing line.
      const lines = this.rivalLines;
      lines.set(car.id, this.racingLine);
      let rivalIndex = 0;
      for (let slot = 0; slot < total; slot++) {
        if (slot === playerSlot) {
          racers.push(this.racer(carLabel(car, 0), this.player, null, true, liveryFor(car.id, car.spec.color, car.spec.accent ?? 0xffffff).primary));
          continue;
        }
        const def = rivals[rivalIndex++];
        // Teammates share their team's livery.
        // Second car of a team (or the player's teammate) carries the team's other number.
        const driver = def.id === car.id || rivals.indexOf(def) !== rivalIndex - 1 ? 1 : 0;
        const vehicle = new Vehicle(physics, def.physics, def.createVisual(undefined, driver), this.track.gridPose(slot), def.gearbox);
        this.scene.add(vehicle.object3D);
        this.vehicles.push(vehicle);
        this.carOf.set(vehicle, def);
        let line = lines.get(def.id);
        if (!line) lines.set(def.id, (line = this.lineFor(def)));
        // Front of the grid = faster drivers, with some randomness.
        const r = Math.sin(slot * 12.9898) * 43758.5453;
        const rand = r - Math.floor(r);
        const ai = new AIDriver(vehicle, line, this.track, {
          pace: 0.97 - (slot / total) * 0.07 + (rand - 0.5) * 0.04,
          lane: (rand - 0.5) * 2.4,
          aggression: rand,
        });
        racers.push(this.racer(carLabel(def, driver), vehicle, ai, false, liveryFor(def.id, def.spec.color, def.spec.accent ?? 0xffffff).primary));
      }
      this.race = new RaceManager(this.track, racers, Math.max(1, Math.round(config.laps)));
    }
    if (this.race) {
      this.penalties = new Penalties(this.track);
      // Every counted excursion deletes that lap's time; the player hears about it.
      this.penalties.onEvent = (r, e) => {
        if (!r.isPlayer) return;
        if (e.kind === 'overtake') {
          this.hud.toast(`추월 금지 구간에서 추월 · +5초 (합계 ${e.seconds}초)`);
          return;
        }
        this.lapTimer.invalidate();
        this.hud.toast(e.kind === 'warning' ? `트랙 리밋 경고 ${e.strike}/${WARNINGS} · 랩 기록 삭제` : `트랙 리밋 페널티 +5초 (합계 ${e.seconds}초)`);
      };
      this.raceControl = new RaceControl(this.track);
      this.safetyCar = new SafetyCar(this.physics, this.track, this.scene);
      this.raceControl.onMessage = (m) => {
        const text = {
          yellow: '노란 깃발 · 감속, 추월 금지',
          vsc: 'VSC · 가상 세이프티카 · 추월 금지',
          'vsc-ending': 'VSC 종료 예정',
          sc: '세이프티카 · 추월 금지, 줄 서서 따라가기',
          'sc-in': '세이프티카 이번 랩 복귀 · 결승선에서 재출발',
          green: '그린 플래그 · 레이스 재개',
        }[m];
        this.hud.flag(m === 'green' ? 'green' : m === 'yellow' ? 'yellow' : 'vsc', text);
        this.engineer?.onFlag(m);
      };
    }
    if (this.track.pit) {
      this.pitStops = new PitStops(this.track.pit, this.track, this.servicePit);
      this.pitCrew = new PitCrew(this.track.pit, teamColors);
      this.pitCrew.onRelease = (v, seconds) => {
        if (v === this.player) this.hud.toast(`피트스톱 ${seconds.toFixed(1)}초`);
      };
      this.scene.add(this.pitCrew.group);
      // Starting tyres: the front of the grid on softs, the rest split soft / medium.
      const wet = this.weather.weather === 'rain';
      const damp = this.weather.weather === 'drizzle';
      this.race?.racers.forEach((r, slot) => {
        if (r.isPlayer) return;
        const compound: Compound = wet ? 'wet' : damp ? 'inter' : slot < 6 || slot % 3 === 0 ? 'soft' : 'medium';
        r.vehicle.tyres.fit(compound);
        r.vehicle.visual.setCompound?.(COMPOUND_COLORS[compound]);
      });
    }
    // AI drivers steer round wings lying on the track.
    for (const r of this.race?.racers ?? []) if (r.ai) r.ai.debris = this.debris;
    // The player's starting tyre comes from the menu (or ?tyre=).
    const startTyre = readStartTyre();
    this.player.tyres.fit(startTyre);
    this.player.visual.setCompound?.(COMPOUND_COLORS[startTyre]);

    // Surface is sampled under each wheel (two wheels on the grass pull the car around).
    const probe = new THREE.Vector3();
    const surfaceAt = (x: number, z: number, y = 0) => SURFACES[this.track.surfaceAt(probe.set(x, y, z))];
    for (const v of this.vehicles) {
      v.physics.surfaceAt = surfaceAt;
      v.physics.aeroInAir = this.track.elevated;
    }

    if (config.bench > 0) {
      this.autopilot = new AIDriver(this.player, this.racingLine, this.track, { pace: 0.95, lane: 0, aggression: 0.5 });
      this.autopilot.debris = this.debris;
      this.bench = new Benchmark(config.bench, {
        track: layout.id,
        car: car.id,
        cars: this.vehicles.length,
        renderer: this.renderer,
        queue: config.benchQueue,
        nextUrl: (track, queue) => urlWith({ track, benchq: queue.length ? queue.join(',') : null, benchi: '1' }),
      });
    }

    // --- input / camera / ui -----------------------------------------
    this.input.add(new KeyboardInput()).add(new GamepadInput());
    this.followCamera = new FollowCamera(container.clientWidth / container.clientHeight, {
      distance: car.physics.halfExtents.z * 2 + 2.6,
    });
    this.player.render(1);
    try {
      const saved = (config.camera ?? localStorage.getItem('camera')) as CameraMode | null;
      if (saved && CAMERA_MODES.includes(saved)) this.followCamera.setMode(saved);
    } catch {
      /* storage blocked: default view */
    }
    this.drivingFx = new DrivingFx(this.scene, this.track, this.followCamera);
    this.followCamera.snap(this.player.object3D);
    if (config.postfx) this.postFx = new PostFx(this.renderer, this.scene, this.followCamera.camera, this.weatherPost);
    if (this.dynamicResolution) {
      this.qualityGovernor = new QualityGovernor(
        this.dynamicResolution,
        [
          () => {
            if (!this.environment.sun.castShadow) return null;
            this.environment.sun.castShadow = false;
            this.renderer.shadowMap.enabled = false;
            return '그림자 끔';
          },
          () => {
            if (!this.postFx) return null;
            this.postFx.dispose();
            this.postFx = null;
            return '후처리 효과 끔';
          },
          () => {
            if (QUALITY.viewDistance <= 0.36) return null;
            QUALITY.viewDistance = Math.max(0.35, QUALITY.viewDistance * 0.7);
            QUALITY.carDetail = Math.max(25, QUALITY.carDetail * 0.7);
            return '시야 거리 줄임';
          },
        ],
        (label) => this.hud.toast(`그래픽 자동 조절: ${label}`),
      );
    }
    this.weatherFx = new WeatherFx(this.renderer, this.scene, this.weather, this.track, this.vehicles, config.postfx ? this.weatherPost.lens : null);
    if (config.damage) {
      [this.player.damage.front, this.player.damage.rear] = config.damage;
      this.player.visual.setDamage?.(...config.damage);
    }
    const credits = [
      layout.attribution,
      realTerrain ? REAL_TERRAIN_CREDIT : '',
      f1ModelReady() && this.vehicles.some((v) => v.visual instanceof GltfF1Visual) ? F1_MODEL_CREDIT : '',
    ];
    this.hud = new HUD(layout.name, credits.filter(Boolean).join(' · '));
    this.minimap = new Minimap(this.track.getCenterline());

    this.radio = new TeamRadio(
      (on) => this.audio?.setDuck(on),
      () => this.audio?.muted ?? true,
    );
    if (this.race) this.engineer = new RaceEngineer(this.radio, this.race, this.player, this.track, this.racingLine, this.pitStops);
    if (config.sound) {
      this.audio = new AudioSystem();
      this.audio.onReady((ctx) => this.radio.attach(ctx));
      this.audio.onReady((ctx, master) => this.weatherFx?.attachAudio(ctx, master));
      this.audio.onReady((ctx, master, assets) => {
        this.carAudio = new CarAudio(ctx, master, car.engine, assets);
        if (assets.engineLoop) {
          for (const v of this.vehicles) {
            if (v !== this.player) this.voices.set(v, new EngineVoice(ctx, master, (this.carOf.get(v) ?? car).engine, assets.engineLoop));
          }
        }
      });
    }

    if (config.physicsDebug) {
      this.debugRenderer = new PhysicsDebugRenderer(physics);
      this.scene.add(this.debugRenderer.lines);
    }

    this.loop = new GameLoop(
      {
        fixedUpdate: (dt) => this.fixedUpdate(dt),
        update: (dt, alpha) => this.update(dt, alpha),
        render: () => this.render(),
      },
      1 / config.physicsHz,
    );

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    if (net && this.race) net.attach({ race: this.race, physics, inPitLane: (v) => this.pitStops?.driving(v) ?? false });
  }

  static async create(container: HTMLElement, config: SimConfig, car: CarDefinition, layout: TrackLayout, net: NetRace | null = null): Promise<Game> {
    const base = import.meta.env.BASE_URL;
    const [physics, realTerrain] = await Promise.all([
      PhysicsWorld.create(1 / config.physicsHz),
      // Real heights for the landscape (imagery streams in after the start).
      loadRealTerrain(base, layout.id),
      // Real F1 bodies; primitives if the model fails.
      car.cls === 'formula' ? loadF1Model(base).catch((e) => console.warn('F1 model failed', e)) : null,
    ]);
    return new Game(container, config, physics, car, layout, realTerrain, net);
  }

  /** Forest positions, minus the ground landmarks stand on (Monza's old bankings). */
  private forestSpots(): readonly [number, number][] {
    const clear = landmarkClear(this.track.name.toLowerCase());
    return clear ? this.track.forestSpots.filter(([x, z]) => clear(x, z)) : this.track.forestSpots;
  }

  /** Freeze the simulation and its sound (pause menu, app in background). */
  setPaused(paused: boolean): void {
    if (paused) {
      this.loop.stop();
      void this.audio?.ctx?.suspend();
    } else {
      this.loop.start();
      void this.audio?.ctx?.resume();
    }
  }

  start(): void {
    this.loop.start();
    // Stream heavy assets after the first frame: drive first, prettier a moment later.
    const base = import.meta.env.BASE_URL;
    const textures = applyTrackTextures(this.track.materials, this.renderer, this.theme.grassTint, undefined, this.track.street);
    textures.catch((e) => console.warn('Track textures failed', e));
    const real = this.realTerrain;
    if (real) {
      // Satellite colors: landscape texture + tint of the grass around the track.
      loadSatellite(base, real, 'far', this.renderer)
        .then((tex) => applyTerrainImagery(this.terrain, tex))
        .catch((e) => console.warn('Terrain imagery failed', e));
      Promise.all([loadSatellite(base, real, 'near', this.renderer), textures])
        .then(([tex]) => applySatelliteTint(this.track.materials.grass, tex, trackMask(real, this.ground!), real))
        .catch((e) => console.warn('Ground imagery failed', e));
    }
    if (this.config.forest && this.track.forestSpots.length) {
      import('../world/TreeImpostors')
        .then(({ buildImpostorForest }) => buildImpostorForest(this.renderer, this.forestSpots(), (x, z) => this.ground?.height(x, z) ?? 0))
        .then((forest) => {
          this.scene.add(forest.mesh);
          this.disposeForest = forest.dispose;
        })
        .catch((e) => console.warn('Forest failed', e));
    }
    this.environment.loadSky(base, this.renderer).catch((e) => console.warn('HDRI sky failed', e));
  }

  /** Put the player back on the track centerline nearest to where it is. */
  resetPlayer(toSpawn = false): void {
    const pose = toSpawn ? this.track.getSpawnPose() : this.track.getResetPose(this.player.position);
    this.player.teleport(pose);
    if (toSpawn) this.lapTimer.invalidate();
    this.player.render(1);
    this.followCamera.snap(this.player.object3D);
    this.flippedTime = 0;
    this.outTime = 0;
    const me = this.race?.player;
    if (me) this.race!.resync(me);
  }

  private _minimapCars: { position: THREE.Vector3; color: number; isPlayer: boolean }[] | null = null;

  /** Minimap entries (built once; positions are live references). */
  private get minimapCars() {
    if (!this._minimapCars) {
      this._minimapCars = this.race
        ? this.race.racers.map((r) => ({ position: r.vehicle.position, color: r.isPlayer ? PLAYER_DOT : r.color, isPlayer: r.isPlayer }))
        : [{ position: this.player.position, color: PLAYER_DOT, isPlayer: true }];
    }
    return this._minimapCars;
  }

  /**
   * Multiplayer grid, in slot order: the local player, AI cars (driven here
   * only on the host) and the other players' cars (moved by the network).
   */
  private netGrid(plan: NonNullable<NetRace['plan']>, playerSlot: number): Racer[] {
    const net = this.net!;
    this.rivalLines.set(this.car.id, this.racingLine);
    return plan.slots.map((slot, i) => {
      const def = CARS.find((c) => c.id === slot.carId) ?? this.car;
      const color = liveryFor(def.id, def.spec.color, def.spec.accent ?? 0xffffff).primary;
      const name = slot.ai ? carLabel(def, slot.driver) : slot.name;
      if (i === playerSlot) return this.racer(name, this.player, null, true, color);
      const vehicle = new Vehicle(this.physics, def.physics, def.createVisual(undefined, slot.driver), this.track.gridPose(i), def.gearbox);
      this.scene.add(vehicle.object3D);
      this.vehicles.push(vehicle);
      this.carOf.set(vehicle, def);
      let ai: AIDriver | null = null;
      if (slot.ai && net.ownsSlot(i)) {
        let line = this.rivalLines.get(def.id);
        if (!line) this.rivalLines.set(def.id, (line = this.lineFor(def)));
        const r = Math.sin(i * 12.9898) * 43758.5453;
        const rand = r - Math.floor(r);
        ai = new AIDriver(vehicle, line, this.track, { pace: 0.96 + (rand - 0.5) * 0.04, lane: (rand - 0.5) * 2.4, aggression: rand });
      }
      return this.racer(name, vehicle, ai, false, color);
    });
  }

  /** Racing line and speed profile for a car: its team's own line if baked, else the shared one. */
  private lineFor(def: CarDefinition): RacingLine {
    const path = teamLinePath(this.teamLines, def.id, this.track, this.sharedLinePath) ?? this.sharedLinePath;
    return new RacingLine(path, def.physics, { heights: this.track.heightsFor(path) });
  }

  private racer(name: string, vehicle: Vehicle, ai: AIDriver | null, isPlayer: boolean, color: number): Racer {
    return { name, vehicle, ai, isPlayer, progress: 0, lastIndex: 0, finished: false, finishTime: 0, color };
  }

  /** Tyres, pit status and intervals for the player's panel. */
  private updateCarPanel(): void {
    const race = this.race!;
    const me = race.player;
    if (!me) return;
    const t = this.player.tyres;
    const [lo, hi] = COMPOUNDS[t.compound].window;
    const band = (c: number) => (c < lo - 5 ? -1 : c > hi + 5 ? 1 : 0);
    const standings = race.standings();
    const i = standings.indexOf(me);
    const interval = (a?: Racer, b?: Racer) => (a && b ? race.gap(a, b) : null);
    const phase = this.pitStops?.phase(this.player) ?? null;
    const pitText: Record<string, string> = {
      requested: `피트 요청됨 · ${COMPOUND_NAMES[this.nextCompound]} (P 취소)`,
      in: '피트 레인 · 리미터 80 km/h',
      stopped: '타이어 교체 중…',
      out: '피트 아웃 · 리미터 80 km/h',
    };
    this.hud.updateCar({
      compound: COMPOUND_LABELS[t.compound],
      compoundColor: `#${COMPOUND_COLORS[t.compound].toString(16).padStart(6, '0')}`,
      wear: [...t.wear],
      temp: t.temp.map(band),
      tempC: [...t.temp],
      pit: phase ? pitText[phase] : null,
      damage: [this.player.damage.front, this.player.damage.rear, this.player.damage.floor],
      punctured: [...t.punctured],
      ahead: i > 0 ? interval(standings[i - 1], me) : null,
      behind: i < standings.length - 1 ? interval(me, standings[i + 1]) : null,
    });
  }

  /** Fits tyres at a stop and returns the stationary time (s). */
  private servicePit = (v: Vehicle, compound: Compound): number => {
    v.tyres.fit(compound);
    v.visual.setCompound?.(COMPOUND_COLORS[compound]);
    // New nose / rear wing / floor repair: about six seconds more, like a real wing change.
    const repair = v.damage.any ? 6 + Math.random() * 1.5 : 0;
    if (repair) {
      v.damage.repair();
      v.visual.setDamage?.(0, 0);
    }
    if (v === this.player) this.hud.toast(`타이어 교체: ${COMPOUND_NAMES[compound]}${repair ? ' + 파손 수리' : ''}`);
    return 2.1 + Math.random() * 0.8 + repair;
  };

  /** The player hears about a cut tyre or a damaged floor. */
  private onDebris = (e: DebrisEvent): void => {
    if (e.car !== this.player) return;
    if (e.kind === 'puncture') this.hud.toast(`펑크! (${CORNER_NAMES[e.wheel]}) P로 피트인`);
    else if (e.kind === 'floor') this.hud.toast(`바닥 파손 ${Math.round(e.car.damage.floor * 100)}%: 다운포스 감소`);
  };

  /** AI pit strategy: stop near the tyre cliff unless the race is about to end. */
  private aiStrategy(r: Racer): void {
    if (!this.pitStops || r.finished || this.pitStops.phase(r.vehicle)) return;
    const t = r.vehicle.tyres;
    const lapsLeft = this.race!.laps - this.race!.lapOf(r);
    // A puncture or broken bodywork means stopping now (a flat tyre is seconds a corner).
    const broken = r.vehicle.damage.front > 0.35 || r.vehicle.damage.rear > 0.35 || r.vehicle.damage.floor > 0.4 || t.anyPuncture;
    // Under the VSC a stop costs less (the field is slow too): pit earlier, as the teams do.
    const pitWear = this.raceControl && this.raceControl.flag !== 'green' ? 0.4 : 0.68;
    if ((t.maxWear < pitWear && !broken) || lapsLeft < 1) return;
    const compound: Compound = TRACK_GRIP.value < 0.83 ? 'wet' : TRACK_GRIP.value < 0.95 ? 'inter' : lapsLeft > 4 ? 'hard' : lapsLeft > 2 ? 'medium' : 'soft';
    this.pitStops.request(r.vehicle, compound, this.teamBox.get(this.carOf.get(r.vehicle)?.id ?? '') ?? 0);
  }

  /** P: request / cancel a stop; 1-6: compound for it. */
  private pitKey(code: string): void {
    if (!this.pitStops) return;
    const pick: Record<string, Compound> = { Digit1: 'hyper', Digit2: 'soft', Digit3: 'medium', Digit4: 'hard', Digit5: 'inter', Digit6: 'wet' };
    if (pick[code]) {
      this.nextCompound = pick[code];
      this.pitStops.setCompound(this.player, this.nextCompound);
      this.hud.toast(`다음 타이어: ${COMPOUND_NAMES[this.nextCompound]}`);
      return;
    }
    const was = this.pitStops.phase(this.player);
    this.pitStops.request(this.player, this.nextCompound, this.teamBox.get(this.car.id) ?? 0);
    const now = this.pitStops.phase(this.player);
    if (now === 'requested') this.hud.toast(`피트 요청: ${COMPOUND_NAMES[this.nextCompound]} (1~6으로 변경)`);
    else if (was === 'requested') this.hud.toast('피트 요청 취소');
  }

  /** Every car the AI must keep clear of (the safety car too, while it is out). */
  private trafficFor(): readonly Vehicle[] {
    const sc = this.safetyCar?.vehicle;
    return sc ? [...this.vehicles, sc] : this.vehicles;
  }

  /** Yellow flags, the VSC and the safety car: AI pace and passing, the player's speed limit, overtakes. */
  private applyRaceControl(dt: number): void {
    const rc = this.raceControl;
    const race = this.race;
    if (!rc || !race) return;
    const inPit = (r: Racer) => this.pitStops?.driving(r.vehicle) ?? false;
    rc.update(dt, race.racers, race.time, this.debris, inPit);
    const standings = race.standings();
    const leader = standings.find((r) => !r.finished) ?? standings[0];
    // Safety car: out ahead of the leader, in at the pit entry when called in; green when
    // the leader crosses the line after it has gone.
    const sc = this.safetyCar;
    if (sc) {
      if (rc.flag === 'sc' && !sc.out && !this.scDone) sc.deploy(leader.vehicle.position);
      if (rc.flag === 'sc-in') sc.callIn();
      const lap = Math.floor(leader.progress / this.track.getCenterline().length);
      if (rc.flag === 'sc-in' && !sc.out && lap > this.scLeaderLap) rc.restart();
      this.scLeaderLap = lap;
      if (rc.flag === 'green') this.scDone = false;
    }
    const vsc = rc.flag === 'vsc' || rc.flag === 'vsc-ending';
    for (const r of race.racers) {
      if (!r.ai) continue;
      // Behind the safety car the field closes up at racing pace and queues (car following);
      // once it has gone in, the leader sets a slow pace until the line.
      const scPace = rc.flag === 'sc-in' && !sc?.out && r === leader ? VSC_SPEED : 1;
      r.ai.rules.speedFactor = vsc ? VSC_SPEED : rc.inYellow(r) ? 0.8 : scPace;
      r.ai.rules.noPassing = rc.noOvertaking(r);
    }
    // The player gets a limiter at the VSC speed for that point of the lap (the F1 games
    // show a delta instead; a limiter is kinder on a keyboard).
    const me = race.player;
    if (me && vsc) {
      this.vscIndex = this.racingLine.nearestFrom(this.player.position, this.vscIndex);
      this.player.physics.speedCap = Math.max(15, this.racingLine.speeds[this.vscIndex] * VSC_SPEED);
    } else this.player.physics.speedCap = Infinity;
    if (me) this.hud.setFlagLocal(rc.flag === 'green' && rc.inYellow(me));
    for (const r of rc.overtakes(race.racers, inPit)) this.penalties?.overtake(r);
  }

  /** AI cars that are flipped, off the world or hopelessly stuck go back on track. */
  private recoverAI(dt: number): void {
    for (const r of this.race!.racers) {
      if (!r.ai) continue;
      const v = r.vehicle;
      let flip = this.aiFlipTime.get(v) ?? 0;
      flip = v.isFlipped() && v.physics.speed < 3 ? flip + dt : 0;
      this.aiFlipTime.set(v, flip);
      const out = this.track.isOutOfBounds(v.position) ? (this.aiOutTime.get(v) ?? 0) + dt : 0;
      this.aiOutTime.set(v, out);
      if (flip > FLIP_RESET_DELAY || out > OUT_OF_BOUNDS_DELAY || v.position.y < this.track.bounds.min.y - 10 || r.ai.unstuckCount >= 3) {
        v.teleport(this.track.getResetPose(v.position));
        r.ai.resetState();
        r.ai.unstuckCount = 0;
        this.aiFlipTime.set(v, 0);
        this.aiOutTime.set(v, 0);
        this.race!.resync(r);
      }
    }
  }

  dispose(): void {
    this.loop.stop();
    this.net?.dispose();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.carAudio?.dispose();
    for (const voice of this.voices.values()) voice.dispose();
    this.audio?.dispose();
    this.radio.dispose();
    this.tyreSmoke.dispose();
    this.debrisMesh.dispose();
    this.pitCrew?.dispose();
    this.safetyCar?.dispose();
    this.drivingFx?.dispose();
    this.weatherFx?.dispose();
    this.landmarks?.dispose();
    this.input.dispose();
    for (const v of this.vehicles) v.dispose();
    this.track.dispose();
    for (const line of this.rivalLines.values()) if (line !== this.racingLine) line.dispose();
    this.racingLine.dispose();
    this.environment.dispose();
    this.terrain.removeFromParent();
    this.terrain.geometry.dispose();
    (this.terrain.material as THREE.Material).dispose();
    this.minimap.dispose();
    this.disposeForest?.();
    this.postFx?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // --------------------------------------------------------------------

  private fixedUpdate(dt: number): void {
    this.perf.beginSection();

    const { input, actions } = this.input.poll();
    if (actions.includes('reset')) {
      this.resetPlayer();
      this.lapTimer.invalidate();
    }

    this.net?.beforeStep(dt);
    updateSlipstream(this.vehicles);
    updateRules2026(this.track, this.aeroZones, this.vehicles, this.race ?? null);
    if (actions.includes('overtake')) {
      const ers = this.player.ers;
      if (ers.activateOvertake()) this.hud.toast('오버테이크 모드: 337 km/h까지 전기 출력, +0.5 MJ');
      else this.hud.toast(ers.overtakeLeft ? '오버테이크 모드: 앞차와 1초 이내일 때' : '오버테이크 모드는 한 바퀴에 한 번');
    }
    const frozen = this.race?.frozen ?? false;
    // The pit controller drives cars in the pit lane (player included).
    const pitPlayer = frozen ? null : (this.pitStops?.update(this.player, dt) ?? null);
    // The safety car drives itself (before the step), and the AI follow it like a car.
    if (!frozen && this.safetyCar?.fixedUpdate(dt)) this.scDone = true;
    const playerInput = pitPlayer ?? (this.autopilot ? this.autopilot.update(dt, this.vehicles) : input);
    this.player.fixedUpdate(frozen ? HOLD : playerInput, dt);
    if (this.race) {
      for (const r of this.race.racers) {
        if (!r.ai) continue;
        const pitAi = frozen ? null : (this.pitStops?.update(r.vehicle, dt) ?? null);
        r.vehicle.fixedUpdate(frozen ? HOLD : (pitAi ?? r.ai.update(dt, this.trafficFor())), dt);
        if (!frozen) this.aiStrategy(r);
      }
    }
    this.physics.step();
    for (const v of this.vehicles) v.snapshot();
    this.safetyCar?.afterStep();
    this.net?.afterStep(dt);
    if (!this.byCollider.size) for (const v of this.vehicles) this.byCollider.set(v.physics.collider.handle, v);
    applyImpacts(this.physics, this.byCollider, dt, (v, _hit, before) => {
      v.visual.setDamage?.(v.damage.front, v.damage.rear);
      this.engineer?.onDamage(v);
      // Shards for what broke; a wing that came off lies on the track (its own mesh).
      const color = this.race?.racers.find((r) => r.vehicle === v)?.color ?? 0x222222;
      for (const piece of this.debris.onDamage(v, before, color)) {
        if (piece.kind === 'wing') piece.object = v.visual.takeDetachedWing?.() ?? undefined;
      }
      if (v === this.player && (v.damage.front >= 0.6 || v.damage.rear >= 0.6)) this.hud.toast(v.damage.front >= 0.6 ? '앞날개 파손! P로 피트인' : '뒷날개 파손! P로 피트인');
    });
    if (!frozen) this.debris.step(this.vehicles, dt, this.onDebris);
    if (this.race) {
      this.recoverAI(dt);
      this.race.update(dt);
      if (!frozen) this.penalties?.update(this.race.racers, dt, (r) => this.pitStops?.driving(r.vehicle) ?? false);
      if (!frozen) this.applyRaceControl(dt);
    }

    // Fell off the world?
    if (this.player.position.y < this.track.bounds.min.y - 10) this.resetPlayer(true);

    // Escaped over or through the barriers? Back on track, lap invalid.
    this.outTime = this.track.isOutOfBounds(this.player.position) ? this.outTime + dt : 0;
    if (this.outTime > OUT_OF_BOUNDS_DELAY) {
      this.resetPlayer();
      this.lapTimer.invalidate();
    }

    if (this.autopilot && this.autopilot.unstuckCount >= 3) {
      this.resetPlayer();
      this.autopilot.resetState();
      this.autopilot.unstuckCount = 0;
    }

    // Beached in the grass / gravel or pinned on a wall: tell the driver how to get back.
    const ph = this.player.physics;
    const trying = Math.abs(input.throttle) > 0.3 || Math.abs(input.steer) > 0.3;
    const offRoad = ph.surfaceGrip < 0.9;
    const crawling = Math.abs(ph.forwardSpeed) < (offRoad ? 5 : 2);
    const stuck = !frozen && !this.autopilot && !(this.pitStops?.driving(this.player) ?? false) && crawling && (offRoad || trying);
    this.stuckTime = stuck ? this.stuckTime + dt : Math.max(0, this.stuckTime - dt * 3);
    if (actions.includes('reset')) this.stuckTime = 0;
    this.hud.setHint(
      this.stuckTime > 2.5 && this.race?.state !== 'finished'
        ? this.config.touch
          ? '<kbd>↺</kbd> 버튼을 눌러 트랙으로 복귀<small>위치를 트랙 위로 되돌립니다</small>'
          : '<kbd>R</kbd> 키를 눌러 트랙으로 복귀<small>위치를 트랙 위로 되돌립니다</small>'
        : null,
    );

    // Stuck on its roof / side?
    if (this.player.isFlipped() && this.player.physics.speed < 3) {
      this.flippedTime += dt;
      if (this.flippedTime > FLIP_RESET_DELAY) this.resetPlayer();
    } else {
      this.flippedTime = 0;
    }

    if (!frozen) this.lapTimer.update(this.track.nearestIndex(this.player.position), dt);
    if (this.lapTimer.event) this.lapEvent = this.lapTimer.event;
    this.engineer?.fixedUpdate(dt, frozen ? null : this.lapTimer.event);

    this.perf.endPhysics();
  }

  private update(frameDt: number, alpha: number): void {
    this.perf.beginFrame();
    this.dynamicResolution?.update(this.perf.snapshot);
    this.qualityGovernor?.update(this.perf.snapshot);
    this.perf.snapshot.pixelRatio = this.renderer.getPixelRatio();
    for (const v of this.vehicles) v.render(alpha);
    this.safetyCar?.render(alpha, frameDt);
    if (this.pitStops) this.pitCrew?.update(frameDt, this.pitStops);
    // Car LOD: beyond ~70 m (less on weaker devices) wheel rims and brake discs are a few pixels; hide them.
    const cam = this.followCamera.camera.position;
    const detail = QUALITY.carDetail * QUALITY.carDetail;
    for (const v of this.vehicles) v.visual.setDetail?.(v.object3D.position.distanceToSquared(cam) < detail);
    const speedRatio = this.player.physics.forwardSpeed / this.player.config.maxSpeed;
    this.followCamera.update(this.player.object3D, speedRatio, frameDt);
    this.tyreSmoke.update(frameDt, this.vehicles, this.followCamera.camera);
    this.debrisMesh.update();
    this.drivingFx.update(frameDt, this.vehicles, this.player, this.followCamera, this.lapTimer, this.race);
    this.weatherFx?.update(frameDt, this.followCamera.camera, ['tcam', 'cockpit', 'driver', 'nose'].includes(this.followCamera.mode));
    this.environment.update(this.player.object3D.position);
    this.track.update(performance.now() / 1000, this.followCamera.camera.position);
    this.minimap.update(this.minimapCars);
    this.racingLine.update(this.player.object3D.position, this.player.physics.forwardSpeed);
    this.debugRenderer?.update();
    this.hud.updateLaps(this.lapTimer, this.lapEvent);
    this.radio.update();
    if (this.race) {
      const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
      this.hud.updateRace(this.race, (r) => ({
        tyre: COMPOUND_LABELS[r.vehicle.tyres.compound],
        tyreColor: hex(COMPOUND_COLORS[r.vehicle.tyres.compound]),
        inPit: (this.pitStops?.driving(r.vehicle) ?? false) || (this.net?.inPit(r.vehicle) ?? false),
      }));
      this.updateCarPanel();
    }
    this.lapEvent = null;
    const gearbox = this.player.gearbox;
    this.hud.update(this.perf.snapshot, {
      speedKmh: this.player.speedKmh,
      gear: gearbox ? gearbox.label : '',
      rpmRatio: gearbox ? gearbox.rpmRatio : 0,
      input: this.input.activeSource,
      ers: this.player.config.mgukPower > 0
        ? {
            charge: this.player.ers.charge,
            power: this.player.ers.power,
            straight: this.player.aeroMode > 0.5,
            overtake: this.player.ers.overtakeActive ? 'active' : this.player.ers.overtakeAvailable ? 'ready' : null,
          }
        : undefined,
      tow: 1 - this.player.physics.wake.drag,
      dirty: 1 - (this.player.physics.wake.front + this.player.physics.wake.rear) / 2,
    });
    if (this.carAudio && gearbox && this.audio?.running) {
      this.carAudio.update(
        {
          rpmRatio: gearbox.rpmRatio,
          throttle: this.player.throttle,
          speed: this.player.physics.speed,
          slip: this.player.physics.maxSlip,
          shifting: gearbox.shiftTimer > 0,
        },
        frameDt,
      );
      this.updateVoices();
    }
  }

  /** Listener = camera; opponents' engines are positioned in 3D. */
  private updateVoices(): void {
    const ctx = this.audio?.ctx;
    if (!ctx || this.voices.size === 0) return;
    const cam = this.followCamera.camera;
    const l = ctx.listener;
    cam.getWorldDirection(this._camDir);
    if (l.positionX) {
      l.positionX.value = cam.position.x;
      l.positionY.value = cam.position.y;
      l.positionZ.value = cam.position.z;
      l.forwardX.value = this._camDir.x;
      l.forwardY.value = this._camDir.y;
      l.forwardZ.value = this._camDir.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
    for (const [v, voice] of this.voices) {
      const p = v.object3D.position;
      voice.update(p.x, p.y, p.z, v.gearbox?.rpmRatio ?? 0.3, v.throttle);
    }
  }

  private render(): void {
    this.perf.beginSection();
    if (this.postFx) this.postFx.render(0);
    else this.renderer.render(this.scene, this.followCamera.camera);
    this.perf.endRender(this.renderer.info);
    if (this.bench) {
      this.bench.frame(!(this.race?.frozen ?? false), this.perf.frame, this.renderer.info);
      this.perf.frame.physicsMs = 0;
      this.perf.frame.renderMs = 0;
    }
  }

  /** Esc: back to the start menu (keeps the current car/track preselected). */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') window.location.href = urlWith({ menu: '' });
    if (e.code === 'KeyL' && !e.repeat) this.racingLine.mesh.visible = !this.racingLine.mesh.visible;
    if ((e.code === 'KeyP' || /^Digit[1-6]$/.test(e.code)) && !e.repeat) this.pitKey(e.code);
    if (e.code === 'KeyK' && !e.repeat) this.hud.toast(`카메라 흔들림: ${this.followCamera.cycleShake()}`);
    if (e.code === 'KeyC' && !e.repeat) {
      const mode = this.followCamera.cycleMode();
      this.hud.toast(`시점: ${CAMERA_LABELS[mode]}`);
      try {
        localStorage.setItem('camera', mode);
      } catch {
        /* storage blocked: the view just isn't remembered */
      }
    }
  };

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.postFx?.setSize(w, h);
    this.followCamera.setAspect(w / h);
  };
}
