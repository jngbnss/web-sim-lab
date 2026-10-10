/**
 * Menu artwork: the outline of every circuit as an SVG path (top view, north up as
 * in the game, fitted to a 100 x 100 box), with the start line and the driving
 * direction, into src/ui/circuitMaps.json.
 *
 *   npx tsx scripts/build-circuit-maps.ts
 */
import { writeFileSync } from 'node:fs';
import { loadLayout } from './tracks-node';

const IDS = ['melbourne', 'shanghai', 'suzuka', 'sakhir', 'jeddah', 'miami', 'montreal', 'monaco', 'catalunya', 'spielberg', 'silverstone', 'spa', 'budapest', 'zandvoort', 'monza', 'madrid', 'baku', 'singapore', 'austin', 'mexicocity', 'saopaulo', 'lasvegas', 'lusail', 'yasmarina'];
/** Box the outline is fitted into (with a margin for the stroke). */
const SIZE = 100;
const MARGIN = 6;
/** Keep a point every this many metres (outline detail vs file size). */
const STEP = 12;

interface CircuitMap {
  /** SVG path (closed). */
  d: string;
  /** Start line position and the direction of travel there (unit vector). */
  start: [number, number];
  dir: [number, number];
  /** Width / height of the fitted outline (for the aspect of the card). */
  w: number;
  h: number;
}

const maps: Record<string, CircuitMap> = {};
for (const id of IDS) {
  const pts = loadLayout(id).points;
  // Even spacing along the loop.
  const kept: [number, number][] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc >= STEP) {
      kept.push(pts[i]);
      acc = 0;
    }
  }
  const xs = kept.map((p) => p[0]);
  const zs = kept.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const scale = (SIZE - 2 * MARGIN) / Math.max(maxX - minX, maxZ - minZ);
  const w = (maxX - minX) * scale;
  const h = (maxZ - minZ) * scale;
  // Centre the outline in the box.
  const ox = (SIZE - w) / 2;
  const oy = (SIZE - h) / 2;
  const map = (p: [number, number]): [number, number] => [ox + (p[0] - minX) * scale, oy + (p[1] - minZ) * scale];
  const f = (v: number) => v.toFixed(1);
  const d = kept.map((p, i) => `${i ? 'L' : 'M'}${f(map(p)[0])} ${f(map(p)[1])}`).join('') + 'Z';
  const s = map(pts[0]);
  const n = map(pts[Math.min(pts.length - 1, 8)]);
  const len = Math.hypot(n[0] - s[0], n[1] - s[1]) || 1;
  maps[id] = { d, start: [Number(f(s[0])), Number(f(s[1]))], dir: [Number(((n[0] - s[0]) / len).toFixed(3)), Number(((n[1] - s[1]) / len).toFixed(3))], w: Number(f(w)), h: Number(f(h)) };
  console.log(`${id}: ${kept.length} points`);
}
writeFileSync('src/ui/circuitMaps.json', JSON.stringify(maps));
console.log(`wrote src/ui/circuitMaps.json (${Math.round(JSON.stringify(maps).length / 1024)} KB)`);
