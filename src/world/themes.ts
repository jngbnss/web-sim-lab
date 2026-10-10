/**
 * Look of the world around a circuit: sky, light, haze, ground and the
 * distant landscape. Each real circuit maps to a theme for its region;
 * `?theme=<id>` overrides it (handy for comparing looks).
 *
 * Colors are sRGB hex. HDRIs are Poly Haven "pure sky" images (CC0).
 */
export interface TerrainStyle {
  /** Peak height (m) of the distant landscape (0 = flat horizon). */
  height: number;
  /** Feature size (m) of the hills: small = busy, large = broad ranges. */
  scale: number;
  /** Distance (m) beyond the circuit's surroundings over which hills rise to full height. */
  ramp: number;
  /** Sharp ridges (mountains) instead of rounded hills. */
  ridged: boolean;
  /** 0..1 share of the land covered by woods (dark patches seen from afar). */
  forest: number;
  meadow: number;
  woods: number;
  rock: number;
  /** Height fraction above which slopes turn to rock (1 = never). */
  rockLine: number;
}

export interface WorldTheme {
  id: string;
  /** File in public/hdri/. */
  hdri: string;
  /** Renderer tone-mapping exposure. */
  exposure: number;
  sunIntensity: number;
  sunColor: number;
  /** Sky/ground hemisphere fill once the HDRI is in (adds to image lighting). */
  hemiIntensity: number;
  envIntensity: number;
  /** Exponential haze density (1/m): higher = mistier. */
  fogDensity: number;
  /** Sky/fog colors used until the HDRI has streamed in. */
  skyTop: number;
  skyHorizon: number;
  /** Multiplies the grass texture (lush vs dry vs dull). */
  grassTint: number;
  terrain: TerrainStyle;
  /** Night: no HDRI; a dark procedural sky and floodlight-only lighting (see world/Weather.ts). */
  night?: boolean;
  /** Lowest sun elevation (rad) taken from the HDRI (default 0.35; dusk goes lower for long shadows). */
  minSunElevation?: number;
}

const BASE: WorldTheme = {
  id: 'default',
  hdri: 'sky_2k.exr',
  exposure: 1,
  sunIntensity: 2.6,
  sunColor: 0xfff1dc,
  hemiIntensity: 0.25,
  envIntensity: 0.9,
  fogDensity: 0.00016,
  skyTop: 0x3d7cc9,
  skyHorizon: 0xc9e3f5,
  grassTint: 0x8fc46a,
  terrain: {
    height: 90,
    scale: 2600,
    ramp: 2500,
    ridged: false,
    forest: 0.35,
    meadow: 0x45652f,
    woods: 0x22361c,
    rock: 0x7a7468,
    rockLine: 1,
  },
};

export const THEMES: Record<string, WorldTheme> = {
  default: BASE,
  // Styrian Alps around the Red Bull Ring: forested mountains, clear air.
  alpine: {
    ...BASE,
    id: 'alpine',
    fogDensity: 0.00011,
    grassTint: 0x86c064,
    terrain: {
      height: 1300,
      scale: 4200,
      ramp: 3500,
      ridged: true,
      forest: 0.6,
      meadow: 0x3f5a2a,
      woods: 0x1b2c17,
      rock: 0x6f6a60,
      rockLine: 0.72,
    },
  },
  // Lombardy plain, Monza park: warm hazy afternoon, flat with a wooded horizon.
  lombardy: {
    ...BASE,
    id: 'lombardy',
    hdri: 'kloofendal_38d_partly_cloudy_puresky_2k.exr',
    exposure: 1.0,
    sunColor: 0xffe6c4,
    sunIntensity: 3.6,
    hemiIntensity: 0.15,
    envIntensity: 1.0,
    fogDensity: 0.00024,
    skyTop: 0x5a86b8,
    skyHorizon: 0xe6d4b8,
    grassTint: 0x84b25c,
    terrain: {
      height: 26,
      scale: 900,
      ramp: 600,
      ridged: false,
      forest: 0.75,
      meadow: 0x4f6332,
      woods: 0x22351c,
      rock: 0x6e6a5e,
      rockLine: 1,
    },
  },
  // Northamptonshire: overcast, flat farmland with hedges and copses.
  england: {
    ...BASE,
    id: 'england',
    hdri: 'kloofendal_overcast_puresky_2k.exr',
    exposure: 1.1,
    sunIntensity: 0.9,
    sunColor: 0xe8ecf0,
    hemiIntensity: 0.55,
    envIntensity: 1.1,
    fogDensity: 0.0003,
    skyTop: 0x8a97a6,
    skyHorizon: 0xc4ccd4,
    grassTint: 0x7fb15c,
    terrain: {
      height: 45,
      scale: 1800,
      ramp: 1200,
      ridged: false,
      forest: 0.3,
      meadow: 0x41602d,
      woods: 0x1f331b,
      rock: 0x6b6a62,
      rockLine: 1,
    },
  },
  // Ardennes around Spa: steep wooded valleys, misty.
  ardennes: {
    ...BASE,
    id: 'ardennes',
    hdri: 'kloofendal_28d_misty_puresky_2k.exr',
    exposure: 1.05,
    // Soft, cool Ardennes light, but enough sun to model the hills.
    sunIntensity: 2.3,
    sunColor: 0xfff0dc,
    hemiIntensity: 0.4,
    fogDensity: 0.00017,
    skyTop: 0x9fb2c4,
    skyHorizon: 0xd2d9df,
    grassTint: 0x7fb45a,
    terrain: {
      height: 380,
      scale: 2200,
      ramp: 1500,
      ridged: false,
      forest: 0.85,
      meadow: 0x41602b,
      woods: 0x182a15,
      rock: 0x6b675d,
      rockLine: 1,
    },
  },
  // Albert Park, Montreal: city parkland by the water, clear sky, flat.
  parkland: {
    ...BASE,
    id: 'parkland',
    hdri: 'kloofendal_43d_clear_puresky_2k.exr',
    sunIntensity: 2.8,
    fogDensity: 0.00018,
    grassTint: 0x8cc463,
    terrain: { height: 35, scale: 1500, ramp: 900, ridged: false, forest: 0.45, meadow: 0x46652f, woods: 0x22381c, rock: 0x6d6a62, rockLine: 1 },
  },
  // Yangtze delta: flat, humid, hazy and pale.
  delta: {
    ...BASE,
    id: 'delta',
    hdri: 'qwantani_puresky_2k.exr',
    exposure: 1.05,
    sunIntensity: 2.0,
    sunColor: 0xfff0d8,
    hemiIntensity: 0.4,
    fogDensity: 0.00042,
    skyTop: 0x9fb0c0,
    skyHorizon: 0xd6d8d2,
    grassTint: 0x8fb862,
    terrain: { height: 18, scale: 900, ramp: 600, ridged: false, forest: 0.25, meadow: 0x506a34, woods: 0x2a3f22, rock: 0x6d6a62, rockLine: 1 },
  },
  // Mie prefecture: green wooded hills, the Suzuka mountains on the horizon.
  japan: {
    ...BASE,
    id: 'japan',
    // Warm late-season afternoon (the Japanese GP).
    hdri: 'qwantani_late_afternoon_puresky_2k.exr',
    sunColor: 0xffe2b8,
    sunIntensity: 3.0,
    fogDensity: 0.00016,
    grassTint: 0x82bd5e,
    terrain: { height: 900, scale: 3200, ramp: 4000, ridged: true, forest: 0.8, meadow: 0x3e5c2a, woods: 0x1a2e17, rock: 0x6a665c, rockLine: 0.85 },
  },
  // Bahrain: bright desert, sand and low rocky ridges.
  desert: {
    ...BASE,
    id: 'desert',
    hdri: 'syferfontein_6d_clear_puresky_2k.exr',
    exposure: 0.95,
    sunIntensity: 3.2,
    sunColor: 0xfff0d6,
    fogDensity: 0.00026,
    skyTop: 0x6f9bd0,
    skyHorizon: 0xe9dcc4,
    grassTint: 0xd9c49b,
    terrain: { height: 70, scale: 1400, ramp: 1200, ridged: true, forest: 0, meadow: 0xc8ad80, woods: 0xb09670, rock: 0x9c8466, rockLine: 0.6 },
  },
  // Abu Dhabi twilight race: sand, warm low sun.
  desertDusk: {
    ...BASE,
    id: 'desertDusk',
    hdri: 'qwantani_dusk_2_puresky_2k.exr',
    exposure: 1.15,
    sunIntensity: 1.6,
    sunColor: 0xffb070,
    hemiIntensity: 0.45,
    fogDensity: 0.0003,
    skyTop: 0x3b4f7a,
    skyHorizon: 0xe8a878,
    grassTint: 0xcdb08a,
    terrain: { height: 30, scale: 1100, ramp: 800, ridged: false, forest: 0, meadow: 0xb89a74, woods: 0xa48a68, rock: 0x8a765e, rockLine: 1 },
  },
  // Catalonia: dry Mediterranean hills, olive scrub, strong sun.
  mediterranean: {
    ...BASE,
    id: 'mediterranean',
    hdri: 'syferfontein_6d_clear_puresky_2k.exr',
    sunIntensity: 3.0,
    fogDensity: 0.00018,
    grassTint: 0xa8bb6a,
    terrain: { height: 420, scale: 2600, ramp: 2500, ridged: true, forest: 0.5, meadow: 0x8a8158, woods: 0x3d4a2a, rock: 0x9a8a70, rockLine: 0.7 },
  },
  // Monte Carlo: bright Riviera sun, deep blue sea, the Maritime Alps behind the town.
  riviera: {
    ...BASE,
    id: 'riviera',
    hdri: 'syferfontein_6d_clear_puresky_2k.exr',
    exposure: 1.02,
    sunIntensity: 3.4,
    sunColor: 0xfff0d8,
    hemiIntensity: 0.3,
    envIntensity: 1.05,
    fogDensity: 0.00012,
    skyTop: 0x3f7fd0,
    skyHorizon: 0xcfe3f2,
    grassTint: 0x8fb05e,
    terrain: { height: 900, scale: 3000, ramp: 2000, ridged: true, forest: 0.35, meadow: 0x7d7a52, woods: 0x3a4a2a, rock: 0xa89c86, rockLine: 0.6 },
  },
  // Hungarian plain around the Hungaroring: rolling hills, hot summer.
  pannonia: {
    ...BASE,
    id: 'pannonia',
    hdri: 'kloofendal_43d_clear_puresky_2k.exr',
    sunIntensity: 2.9,
    fogDensity: 0.0002,
    grassTint: 0x9cbd62,
    terrain: { height: 140, scale: 2400, ramp: 1600, ridged: false, forest: 0.45, meadow: 0x6b7a40, woods: 0x2c4223, rock: 0x7a7060, rockLine: 1 },
  },
  // Zandvoort: North Sea dunes, marram grass, breezy clouds.
  dunes: {
    ...BASE,
    id: 'dunes',
    hdri: 'sky_2k.exr',
    fogDensity: 0.00024,
    grassTint: 0xa9b878,
    terrain: { height: 28, scale: 500, ramp: 500, ridged: false, forest: 0.15, meadow: 0xb7aa82, woods: 0x6b7a4a, rock: 0xcbbd98, rockLine: 1 },
  },
  // Central Texas: dry grassland, big clear sky.
  texas: {
    ...BASE,
    id: 'texas',
    hdri: 'syferfontein_6d_clear_puresky_2k.exr',
    sunIntensity: 3.1,
    fogDensity: 0.00017,
    grassTint: 0xb5b86a,
    terrain: { height: 60, scale: 2200, ramp: 1500, ridged: false, forest: 0.25, meadow: 0x8a8a52, woods: 0x3f4a2a, rock: 0x8a7a62, rockLine: 1 },
  },
  // Mexico City: high basin, smoggy haze, volcanoes far away.
  highland: {
    ...BASE,
    id: 'highland',
    hdri: 'qwantani_puresky_2k.exr',
    exposure: 1.05,
    sunIntensity: 2.6,
    fogDensity: 0.00022,
    skyTop: 0x8aa6c4,
    skyHorizon: 0xd8d0c0,
    grassTint: 0x9cb862,
    terrain: { height: 2200, scale: 6000, ramp: 7000, ridged: true, forest: 0.4, meadow: 0x6a6a48, woods: 0x34452a, rock: 0x7a6e60, rockLine: 0.7 },
  },
  // São Paulo: lush, hilly, humid and cloudy.
  tropical: {
    ...BASE,
    id: 'tropical',
    hdri: 'kloofendal_28d_misty_puresky_2k.exr',
    exposure: 1.05,
    sunIntensity: 1.8,
    hemiIntensity: 0.4,
    fogDensity: 0.00026,
    skyTop: 0x9fb2c4,
    skyHorizon: 0xd2d9df,
    grassTint: 0x78b852,
    terrain: { height: 300, scale: 1800, ramp: 1400, ridged: false, forest: 0.7, meadow: 0x3f6a2a, woods: 0x1c3a18, rock: 0x6a6458, rockLine: 1 },
  },
};

const BY_TRACK: Record<string, string> = {
  melbourne: 'parkland',
  shanghai: 'delta',
  suzuka: 'japan',
  sakhir: 'desert',
  montreal: 'parkland',
  catalunya: 'mediterranean',
  budapest: 'pannonia',
  zandvoort: 'dunes',
  austin: 'texas',
  mexicocity: 'highland',
  saopaulo: 'tropical',
  yasmarina: 'desertDusk',
  spielberg: 'alpine',
  monza: 'lombardy',
  silverstone: 'england',
  spa: 'ardennes',
  monaco: 'riviera',
  jeddah: 'desertDusk',
  miami: 'tropical',
  madrid: 'mediterranean',
  baku: 'mediterranean',
  singapore: 'tropical',
  lasvegas: 'desertDusk',
  lusail: 'desertDusk',
};

export function themeFor(trackId: string, override?: string | null): WorldTheme {
  return THEMES[override ?? ''] ?? THEMES[BY_TRACK[trackId] ?? 'default'];
}
