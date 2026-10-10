import './style.css';
import './ui/responsive.css';
import { installDiagnostics } from './ui/Diagnostics';
import { driveSettings } from './ui/DriveSettings';
import { mountVolumeControl } from './ui/VolumeControl';
import { readConfig, urlWith } from './config';
import { clearBenchResults } from './performance/Benchmark';
import { runLobby, type LobbyResult } from './ui/Lobby';
import { showMenu, type MenuSelection } from './ui/Menu';
import { CAR_LIST, resolveCarId } from './vehicle/catalog';
import { FEATURED_TRACKS, findTrack, TRACKS } from './world/tracks';

/**
 * After a new deploy, a page loaded earlier still asks for the old hashed
 * chunks, which no longer exist ("Failed to fetch dynamically imported
 * module"). Reload once to pick up the new build instead of failing.
 */
const RELOAD_KEY = 'f1:chunk-reload';
function reloadForNewBuild(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return false;
    sessionStorage.setItem(RELOAD_KEY, '1');
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForNewBuild()) e.preventDefault();
});
window.addEventListener('load', () => setTimeout(() => {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* ignore */
  }
}, 15000));

async function main(): Promise<void> {
  installDiagnostics();
  const container = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!container) throw new Error('#app container missing');

  try {
    // Menu artwork: a studio shot of one car (scripts/render-cars.ts).
    const carShot = new URLSearchParams(window.location.search).get('carshot');
    if (carShot) {
      loading?.remove();
      const { runCarShot } = await import('./ui/CarShot');
      await runCarShot(carShot, container);
      return;
    }
    const config = readConfig();
    // The 3D engine, physics WASM and car models download while the menu is open.
    const engine = Promise.all([import('./core/Game'), import('./vehicle/cars')]);
    let carId = resolveCarId(config.car);
    let trackId = findTrack(config.track ?? FEATURED_TRACKS[0].id).id;

    if (config.bench > 0) {
      if (config.benchFirst) clearBenchResults();
      // ?bench without a track: run every circuit in turn.
      if (!config.track) [trackId, ...config.benchQueue] = TRACKS.map((t) => t.id);
    }

    // Multiplayer: a ?room=CODE link (join) or the menu's "race friends" button (host).
    const roomCode = new URLSearchParams(window.location.search).get('room');
    let lobby: LobbyResult | null = null;
    let sel: MenuSelection | null = null;
    if (roomCode && config.bench === 0) {
      loading?.classList.add('hidden');
      lobby = await runLobby(roomCode.toUpperCase());
    } else if (config.showMenu) {
      loading?.classList.add('hidden');
      if (!FEATURED_TRACKS.some((t) => t.id === trackId)) trackId = FEATURED_TRACKS[0].id;
      sel = await showMenu(CAR_LIST, FEATURED_TRACKS, { carId, trackId, ai: config.ai, laps: config.laps });
      if (sel.multiplayer) lobby = await runLobby(null);
    }
    if (lobby) {
      // The grid comes from the room: my slot's car, the room's circuit and distance.
      const mine = lobby.plan.slots.find((s) => s.id === lobby!.room.myId) ?? lobby.plan.slots[0];
      carId = mine.carId;
      trackId = lobby.plan.trackId;
      config.laps = lobby.plan.laps;
      loading?.classList.remove('hidden');
    } else if (sel) {
      ({ carId, trackId } = sel);
      config.ai = sel.ai;
      config.laps = sel.laps;
      // Shareable / reload-safe URL for this selection.
      history.replaceState(
        null,
        '',
        urlWith({ car: carId, track: trackId, ai: String(sel.ai), laps: String(sel.laps), menu: null }),
      );
      loading?.classList.remove('hidden');
    }

    const trackEntry = findTrack(trackId);
    if (loading) loading.textContent = `Loading ${trackEntry.name}…`;
    const [layout, [{ Game }, { findCar }]] = await Promise.all([trackEntry.load(), engine]);
    const net = lobby ? new (await import('./net/NetRace')).NetRace(lobby.room, lobby.plan) : null;
    const game = await Game.create(container, config, findCar(carId), layout, net);
    game.start();
    loading?.remove();
    setupDriving(game, config.touch, config.bench > 0);

    if (import.meta.env.DEV || config.bench > 0 || lobby) {
      // Console handle for experiments: sim.perf.snapshot, sim.player, sim.resetPlayer() ...
      (window as unknown as { sim: typeof game }).sim = game;
    }
  } catch (err) {
    console.error(err);
    if (err instanceof Error && /dynamically imported module|Importing a module script failed/i.test(err.message) && reloadForNewBuild()) return;
    if (loading) {
      loading.classList.remove('hidden');
      loading.classList.add('error');
      loading.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Driver aids and touch controls around the running game: brake assist from
 * the saved settings (B toggles it), on-screen controls on touch screens.
 */
async function setupDriving(game: import('./core/Game').Game, touch: boolean, autopilot: boolean): Promise<void> {
  driveSettings.watch((s) => {
    // The benchmark autopilot always drives with the assist (like every AI car).
    game.player.physics.brakeAssist = s.brakeAssist || autopilot;
  });
  const toast = document.createElement('div');
  toast.className = 'toast';
  document.body.append(toast);
  let hide = 0;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB' || e.repeat) return;
    const on = !driveSettings.get().brakeAssist;
    driveSettings.set({ brakeAssist: on });
    toast.textContent = on ? '브레이크 보조 켬 (잠김 없음)' : '브레이크 보조 끔 (세게 밟으면 바퀴 잠김)';
    toast.classList.add('show');
    clearTimeout(hide);
    hide = window.setTimeout(() => toast.classList.remove('show'), 1600);
  });
  if (!touch) {
    mountVolumeControl();
    return;
  }
  const { TouchControls } = await import('./ui/TouchControls');
  const controls = new TouchControls({
    setPaused: (p) => game.setPaused(p),
    playerLocked: () => game.player.physics.wheels.slice(0, 2).some((w) => w.locked),
  });
  game.input.add(controls.input);
}

void main();
