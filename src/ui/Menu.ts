import type { CarInfo as CarDefinition } from '../vehicle/catalog';
import { COMPOUND_NAMES } from '../vehicle/Tyres';
import type { TrackEntry } from '../world/tracks';
import { mountWeatherPicker, readWeather } from '../world/Weather';
import { CIRCUIT_INFO } from './circuitInfo';
import circuitMaps from './circuitMaps.json';
import { mountTyrePicker, readStartTyre } from './TyrePicker';

export interface MenuSelection {
  carId: string;
  trackId: string;
  /** AI opponents (0 = free practice). */
  ai: number;
  laps: number;
  /** Race friends online instead (opens the multiplayer lobby). */
  multiplayer?: boolean;
}

const AI_OPTIONS: [number, string, string][] = [
  [0, '자유 주행', '혼자 연습'],
  [5, '6대', '상대 5대'],
  [11, '12대', '상대 11대'],
  [19, '20대', '풀 그리드'],
];
const LAP_OPTIONS = [1, 3, 5, 10];
/** Any race distance up to Monaco's real one. */
const MAX_LAPS = 78;
const WEATHER_NAMES: Record<string, string> = { clear: '맑음', cloudy: '흐림', drizzle: '약한 비', rain: '비' };
const TIME_NAMES: Record<string, string> = { day: '낮', dusk: '해 질 녘', night: '밤' };

type MapData = { d: string; start: [number, number]; dir: [number, number] };
const MAPS = circuitMaps as unknown as Record<string, MapData>;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The seven team stats as 0..100 bars relative to the F1 field (50 = the baseline car), with the figure behind each. */
function teamStats(car: CarDefinition): { label: string; value: number; raw: string }[] {
  const tr = car.spec.traits;
  const s = car.stats;
  if (!tr) {
    return [
      { label: '최고속도', value: s.topSpeed, raw: `${car.spec.top} km/h` },
      { label: '가속', value: s.acceleration, raw: `0-100 ${s.t100.toFixed(1)} s` },
      { label: '핸들링', value: s.handling, raw: `${s.lateralG.toFixed(2)} g` },
      { label: '제동', value: s.braking, raw: `200-0 ${s.brake200} m` },
    ];
  }
  const rel = (dev: number) => Math.round(Math.min(100, Math.max(4, 50 + dev * 4.5)));
  const pct = (x: number) => `${x >= 1 ? '+' : ''}${Math.round((x - 1) * 100)}%`;
  return [
    { label: '최고속도', value: rel((car.spec.top - 345) / 3), raw: `${car.spec.top} km/h` },
    { label: '파워', value: rel(((car.spec.kw - 760) / 760) * 100), raw: `${car.spec.kw} kW` },
    { label: '고속 코너', value: rel((tr.downforce - 1) * 100), raw: `다운포스 ${pct(tr.downforce)}` },
    { label: '저속 코너', value: rel((tr.grip - 1) * 250), raw: `그립 ${pct(tr.grip)}` },
    { label: '트랙션', value: rel((tr.traction - 1) * 100), raw: pct(tr.traction) },
    { label: '제동', value: rel((tr.braking - 1) * 100), raw: pct(tr.braking) },
    { label: '타이어', value: rel((1 - tr.tyreWear) * 70), raw: `마모 ${pct(tr.tyreWear)}` },
  ];
}

/** Two best and two worst stats: the team's character at a glance. */
function strengthsOf(car: CarDefinition): { good: string[]; bad: string[] } {
  const stats = teamStats(car);
  const sorted = [...stats].sort((a, b) => b.value - a.value);
  return {
    good: sorted.slice(0, 2).filter((x) => x.value > 54).map((x) => x.label),
    bad: sorted.slice(-2).reverse().filter((x) => x.value < 46).map((x) => x.label),
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

/**
 * Start screen, F1-game style: pick a team (car render, strengths and weaknesses), a
 * circuit (map, flag, length, corners) and the race; a bar at the bottom sums it up and
 * starts. The click on "Start" is also the user gesture browsers require before audio.
 */
export function showMenu(cars: CarDefinition[], tracks: TrackEntry[], initial: MenuSelection): Promise<MenuSelection> {
  return new Promise((resolve) => {
    let carId = initial.carId;
    let trackId = initial.trackId;
    let ai = initial.ai;
    let laps = initial.laps;
    const base = import.meta.env.BASE_URL;

    const root = el('div', 'menu');
    root.innerHTML = `
      <div class="menu-panel">
        <header class="menu-head">
          <h1>web-sim-lab <span>Racing</span></h1>
          <p>F1 2026 · ${cars.length}개 팀 · ${tracks.length}개 서킷</p>
        </header>
        <section class="menu-step">
          <h2><b>1</b>팀 선택</h2>
          <div class="team-grid" data-group="car"></div>
          <div class="team-detail" data-group="spec"></div>
        </section>
        <section class="menu-step">
          <h2><b>2</b>서킷</h2>
          <div class="circuit-grid" data-group="track"></div>
        </section>
        <section class="menu-step menu-race">
          <h2><b>3</b>레이스</h2>
          <h3>방식</h3>
          <div class="chip-row" data-group="ai"></div>
          <div data-group="laps-wrap"><h3>랩 수</h3><div class="chip-row" data-group="laps"></div></div>
          <div class="menu-pickers" data-group="weather"></div>
          <div class="menu-pickers" data-group="tyre"></div>
        </section>
        <p class="menu-note">실제 서킷 레이아웃: TUMFTM racetrack-database (LGPL-3.0) · © OpenStreetMap contributors · 높낮이 Copernicus DEM.</p>
      </div>
      <div class="menu-dock">
        <div class="menu-summary" data-group="summary"></div>
        <button class="menu-start" type="button">출발 ▶ <small>Enter</small></button>
        <button class="menu-mp" type="button">👥 친구와 레이스</button>
      </div>`;
    const q = <T extends HTMLElement>(g: string) => root.querySelector<T>(`[data-group="${g}"]`)!;
    const teamGrid = q<HTMLDivElement>('car');
    const detail = q<HTMLDivElement>('spec');
    const trackGrid = q<HTMLDivElement>('track');
    const aiRow = q<HTMLDivElement>('ai');
    const lapWrap = q<HTMLDivElement>('laps-wrap');
    const lapRow = q<HTMLDivElement>('laps');
    const summary = q<HTMLDivElement>('summary');

    const chip = (title: string, sub: string, selected: boolean, onPick: () => void) => {
      const b = el('button', 'chip' + (selected ? ' selected' : ''));
      b.type = 'button';
      b.append(el('strong', '', title));
      if (sub) b.append(el('span', '', sub));
      b.addEventListener('click', onPick);
      return b;
    };

    const teamCard = (c: CarDefinition) => {
      const b = el('button', 'team-card' + (c.id === carId ? ' selected' : ''));
      b.type = 'button';
      b.style.setProperty('--team', hex(c.spec.color));
      b.style.setProperty('--accent', hex(c.spec.accent ?? c.spec.color));
      const img = el('img');
      img.src = `${base}menu/cars/${c.id}.webp`;
      img.alt = c.spec.brand;
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      const { good, bad } = strengthsOf(c);
      const tags = el('div', 'tags');
      for (const g of good) tags.append(el('span', 'good', `▲ ${g}`));
      for (const w of bad) tags.append(el('span', 'bad', `▼ ${w}`));
      if (!good.length && !bad.length) tags.append(el('span', 'even', '◆ 균형형'));
      b.append(img, el('strong', '', c.spec.brand), tags);
      b.addEventListener('click', () => {
        carId = c.id;
        render();
      });
      b.addEventListener('dblclick', start);
      return b;
    };

    const renderDetail = () => {
      const c = cars.find((x) => x.id === carId)!;
      detail.style.setProperty('--team', hex(c.spec.color));
      const img = el('img');
      img.src = `${base}menu/cars/${c.id}.webp`;
      img.alt = c.name;
      img.onerror = () => img.remove();
      const info = el('div', 'td-info');
      const head = el('div', 'td-head');
      head.append(el('strong', '', c.name), el('span', '', `${Math.round(c.spec.kw * 1.341)} hp · ${c.spec.top} km/h · ${c.spec.kg} kg`));
      const { good, bad } = strengthsOf(c);
      const sw = el('div', 'td-sw');
      if (good.length) sw.append(el('p', 'good', `강점 · ${good.join(', ')}`));
      if (bad.length) sw.append(el('p', 'bad', `약점 · ${bad.join(', ')}`));
      const bars = el('div', 'td-bars');
      for (const s of teamStats(c)) {
        const row = el('div', 'menu-bar');
        const track = el('div');
        const fill = el('i');
        fill.style.width = `${Math.max(s.value, 3)}%`;
        track.append(fill);
        row.append(el('span', '', s.label), track, el('b', '', s.raw));
        bars.append(row);
      }
      info.append(head, sw, bars);
      detail.replaceChildren(img, info);
    };

    const circuitCard = (t: TrackEntry) => {
      const b = el('button', 'circuit-card' + (t.id === trackId ? ' selected' : ''));
      b.type = 'button';
      const map = MAPS[t.id];
      if (map) {
        const [sx, sy] = map.start;
        const [dx, dy] = map.dir;
        // Start line: a short bar across the direction of travel.
        const lx = -dy * 3.5;
        const ly = dx * 3.5;
        b.insertAdjacentHTML(
          'beforeend',
          `<svg viewBox="0 0 100 100" aria-hidden="true"><path class="trk-base" d="${map.d}"/><path class="trk" d="${map.d}"/>` +
            `<line class="trk-start" x1="${sx - lx}" y1="${sy - ly}" x2="${sx + lx}" y2="${sy + ly}"/></svg>`,
        );
      }
      const info = CIRCUIT_INFO[t.id];
      const name = el('strong');
      if (info) name.append(el('i', 'cc', info.code));
      name.append(t.name);
      b.append(name, el('span', '', `${t.location}`), el('em', '', `${t.lengthKm} km${info ? ` · 코너 ${info.corners}` : ''}`));
      b.addEventListener('click', () => {
        trackId = t.id;
        render();
      });
      b.addEventListener('dblclick', start);
      return b;
    };

    const renderSummary = () => {
      const c = cars.find((x) => x.id === carId)!;
      const t = tracks.find((x) => x.id === trackId);
      const w = readWeather();
      const parts = [c.spec.brand, t?.name ?? '', ai === 0 ? '자유 주행' : `${ai + 1}대 · ${laps}랩`, `${WEATHER_NAMES[w.weather] ?? w.weather} ${TIME_NAMES[w.time] ?? ''}`, COMPOUND_NAMES[readStartTyre()]];
      summary.replaceChildren(...parts.filter(Boolean).map((p, i) => el(i === 0 ? 'strong' : 'span', '', p)));
      summary.style.setProperty('--team', hex(c.spec.color));
    };

    const render = () => {
      teamGrid.replaceChildren(...cars.map(teamCard));
      renderDetail();
      trackGrid.replaceChildren(...tracks.map(circuitCard));
      aiRow.replaceChildren(
        ...AI_OPTIONS.map(([n, title, sub]) =>
          chip(title, sub, n === ai, () => {
            ai = n;
            render();
          }),
        ),
      );
      lapWrap.style.display = ai > 0 ? '' : 'none';
      // A number field for any race length next to the usual distances.
      const custom = el('label', 'chip chip-input' + (LAP_OPTIONS.includes(laps) ? '' : ' selected'));
      const input = el('input');
      input.type = 'number';
      input.min = '1';
      input.max = String(MAX_LAPS);
      input.value = String(laps);
      input.setAttribute('aria-label', '랩 수 직접 입력');
      input.addEventListener('change', () => {
        laps = Math.min(MAX_LAPS, Math.max(1, Math.round(Number(input.value) || 1)));
        render();
      });
      // Typing in the field must not start the race.
      input.addEventListener('keydown', (e) => e.stopPropagation());
      custom.append(el('strong', '', '직접'), input, el('span', '', `최대 ${MAX_LAPS}`));
      lapRow.replaceChildren(
        ...LAP_OPTIONS.map((n) =>
          chip(`${n}랩`, n === 1 ? '스프린트' : n === 3 ? '기본' : n === 5 ? '중거리' : '내구', n === laps, () => {
            laps = n;
            render();
          }),
        ),
        custom,
      );
      renderSummary();
    };

    function start(): void {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId, ai, laps });
    }
    function onKey(e: KeyboardEvent): void {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') start();
    }

    root.querySelector('.menu-start')!.addEventListener('click', start);
    root.querySelector('.menu-mp')!.addEventListener('click', () => {
      window.removeEventListener('keydown', onKey);
      root.remove();
      resolve({ carId, trackId, ai, laps, multiplayer: true });
    });
    window.addEventListener('keydown', onKey);
    mountWeatherPicker(q('weather'));
    mountTyrePicker(q('tyre'));
    // The pickers keep their own state (URL / storage): refresh the summary after a pick.
    for (const g of ['weather', 'tyre']) q(g).addEventListener('click', () => setTimeout(renderSummary));
    render();
    document.body.append(root);
  });
}
