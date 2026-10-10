/**
 * The 2026 F1 grid: ten teams with real headline figures (approximate, public
 * data): power, mass, top speed and dimensions. Physics and ratings are
 * derived from these numbers (see ./build.ts); the body is the shared F1 GLB
 * painted in team colors. The other classes and body types stay in the types
 * so the procedural visuals and build tables keep working if cars are added.
 */
export type CarClass = 'street' | 'sports' | 'gt' | 'hyper' | 'formula';
export type Drive = 'FWD' | 'RWD' | 'AWD';
/** Body archetype used by the procedural model. */
export type BodyType = 'hatch' | 'sedan' | 'wagon' | 'coupe' | 'roadster' | 'mid' | 'gt3' | 'supercar' | 'lmp' | 'f1' | 'openwheel' | 'indy' | 'fe';
/** Engine sound family. */
export type EngineType = 'i4' | 'i6' | 'flat6' | 'v6' | 'v8' | 'v10' | 'v12' | 'w16' | 'f1' | 'electric';

export interface CarSpec {
  id: string;
  brand: string;
  model: string;
  cls: CarClass;
  body: BodyType;
  /** Peak power (kW). */
  kw: number;
  /** Mass incl. driver (kg). */
  kg: number;
  /** Real top speed (km/h). */
  top: number;
  drive: Drive;
  /** Length, width, height, wheelbase (m). */
  dims: [number, number, number, number];
  engine: EngineType;
  /** Body color, accent (wings, stripes). */
  color: number;
  accent?: number;
  /** Electronically limited top speed (power could go faster). */
  limited?: boolean;
  /** Team character (F1): multipliers around the shared 2026 baseline (top speed then follows from power and drag). */
  traits?: CarTraits;
}

export interface CarTraits {
  /** Aero load: speed through fast bends (more wing also means a little more drag). */
  downforce: number;
  /** Aero efficiency: drag at the same downforce (lower = slippier, higher top speed). */
  drag: number;
  /** Braking grip: brake stability, how late it can brake. */
  braking: number;
  /** Mechanical grip: slow corners. */
  grip: number;
  /** Rear traction out of slow corners (less wheelspin / snap oversteer). */
  traction: number;
  /** Tyre wear rate (lower = kinder on tyres). */
  tyreWear: number;
  /** Short description for the menu. */
  label: string;
}

type Row = [id: string, brand: string, model: string, body: BodyType, kw: number, kg: number, top: number, drive: Drive, dims: [number, number, number, number], engine: EngineType, color: number, accent?: number, limited?: boolean];

const rows = (cls: CarClass, list: Row[]): CarSpec[] =>
  list.map(([id, brand, model, body, kw, kg, top, drive, dims, engine, color, accent, limited]) => ({ id, brand, model, cls, body, kw, kg, top, drive, dims, engine, color, accent, limited }));

// --- F1 2026: ten teams, two cars each in a race ----------------------------
const F1_DIMS: [number, number, number, number] = [5.4, 1.9, 0.95, 3.4];
const FORMULA = rows('formula', [
  ['f1-ferrari', 'Ferrari', 'F1 2026', 'f1', 790, 800, 348, 'RWD', F1_DIMS, 'f1', 0xd40000, 0x1c1c1c],
  ['f1-mercedes', 'Mercedes', 'F1 2026', 'f1', 785, 800, 347, 'RWD', F1_DIMS, 'f1', 0xc7ccd1, 0x00a19b],
  ['f1-redbull', 'Red Bull', 'F1 2026', 'f1', 765, 800, 343, 'RWD', F1_DIMS, 'f1', 0x1e2a5a, 0xd0021b],
  ['f1-mclaren', 'McLaren', 'F1 2026', 'f1', 750, 800, 342, 'RWD', F1_DIMS, 'f1', 0xff8000, 0x1c1c1c],
  ['f1-aston', 'Aston Martin', 'F1 2026', 'f1', 735, 800, 340, 'RWD', F1_DIMS, 'f1', 0x00665e, 0xc4d600],
  ['f1-alpine', 'Alpine', 'F1 2026', 'f1', 720, 800, 343, 'RWD', F1_DIMS, 'f1', 0x1f5fbf, 0xff4fa0],
  ['f1-williams', 'Williams', 'F1 2026', 'f1', 770, 800, 350, 'RWD', F1_DIMS, 'f1', 0x00205b, 0x00a0de],
  ['f1-racingbulls', 'Racing Bulls', 'F1 2026', 'f1', 760, 800, 343, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0x2f5fd0],
  ['f1-haas', 'Haas', 'F1 2026', 'f1', 760, 800, 345, 'RWD', F1_DIMS, 'f1', 0xf2f2f2, 0xd0021b],
  ['f1-audi', 'Audi', 'F1 2026', 'f1', 755, 808, 341, 'RWD', F1_DIMS, 'f1', 0x8a8f94, 0xbb0a30],
]);

// Team characters (before evening out, below): strengths and weaknesses, after The Race's "every 2025 car's key
// strength and weakness" and the 2025 speed traps (Ferrari / Williams fastest, McLaren
// slow on the straights but best in corners). Each team trades: the sum is balanced by
// lap-time simulation over five circuits (scripts/team-balance.ts), so a different team
// wins at Monza, Monaco and Suzuka. Power (kW) is in the rows above.
const TRAITS: Record<string, CarTraits> = {
  'f1-ferrari': { downforce: 0.96, drag: 0.94, grip: 0.985, traction: 0.97, braking: 1.02, tyreWear: 0.95, label: '최고속도 · 파워 / 저속 트랙션 약함' },
  'f1-mercedes': { downforce: 1.01, drag: 0.95, grip: 1, traction: 1.07, braking: 0.95, tyreWear: 1.12, label: '엔진 · 효율 · 트랙션 / 제동 · 타이어 마모' },
  'f1-redbull': { downforce: 1.07, drag: 1, grip: 0.99, traction: 0.97, braking: 1.03, tyreWear: 1.1, label: '고속 코너 · 제동 / 저속 · 뒷타이어' },
  'f1-mclaren': { downforce: 1.09, drag: 1.06, grip: 1.02, traction: 1.02, braking: 0.91, tyreWear: 0.85, label: '코너 최강 · 타이어 관리 / 직선 · 제동' },
  'f1-aston': { downforce: 1.08, drag: 1.04, grip: 0.98, traction: 0.96, braking: 1.1, tyreWear: 0.98, label: '다운포스 · 제동 / 파워 · 저속 코너' },
  'f1-alpine': { downforce: 1.06, drag: 0.98, grip: 0.99, traction: 1.07, braking: 0.99, tyreWear: 1, label: '고속 코너 · 트랙션 / 파워 부족' },
  'f1-williams': { downforce: 0.99, drag: 0.9, grip: 0.985, traction: 0.98, braking: 1, tyreWear: 1.02, label: '직선 최강 / 저속 코너' },
  'f1-racingbulls': { downforce: 0.92, drag: 0.98, grip: 1.035, traction: 1.04, braking: 0.92, tyreWear: 1, label: '저속 코너 · 트랙션 / 고속 코너 · 제동' },
  'f1-haas': { downforce: 1, drag: 1, grip: 1, traction: 1, braking: 1, tyreWear: 1, label: '균형형' },
  'f1-audi': { downforce: 0.93, drag: 0.97, grip: 0.99, traction: 1, braking: 1.05, tyreWear: 0.9, label: '제동 · 타이어 관리 / 다운포스 부족' },
};
// Players found the gaps too big (some cars turned in badly): every team keeps its character
// but only SPREAD of each difference, and no car falls below a floor in what makes it turn
// and stop (downforce, mechanical grip, traction, braking) or above a ceiling in drag and
// tyre wear. Power is evened out the same way.
const SPREAD = 0.4;
const FLOOR = 0.985;
const CEILING = 1.03;
const REF_KW = 760;
const MIN_KW = 750;
const close = (v: number) => 1 + (v - 1) * SPREAD;
for (const spec of FORMULA) {
  const t = TRAITS[spec.id];
  spec.traits = {
    downforce: Math.max(close(t.downforce), FLOOR),
    grip: Math.max(close(t.grip), FLOOR),
    traction: Math.max(close(t.traction), FLOOR),
    braking: Math.max(close(t.braking), FLOOR),
    drag: Math.min(close(t.drag), CEILING),
    tyreWear: Math.min(close(t.tyreWear), CEILING),
    label: t.label,
  };
  spec.kw = Math.max(Math.round(REF_KW + (spec.kw - REF_KW) * SPREAD), MIN_KW);
}

export const CAR_SPECS: CarSpec[] = FORMULA;

/** The safety car (Mercedes-AMG GT Black Series class): not selectable, race control only. */
export const SAFETY_CAR: CarSpec = rows('sports', [
  ['safety-car', 'Safety Car', 'GT', 'supercar', 537, 1520, 325, 'RWD', [4.6, 2.0, 1.25, 2.63], 'v8', 0xb9bec4, 0x00a19b],
])[0];

export const CLASS_INFO: Record<CarClass, { label: string; description: string }> = {
  street: { label: '스트리트', description: '핫해치 · 고성능 세단' },
  sports: { label: '스포츠', description: '로드 스포츠카 · 쿠페' },
  gt: { label: 'GT 레이스', description: 'GT3 · GT2 레이스카' },
  hyper: { label: '하이퍼', description: '하이퍼카 · 르망 프로토타입' },
  formula: { label: 'F1 2026', description: '10개 팀 · 팀당 2대' },
};
