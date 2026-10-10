import linesRaw from './radio-lines.json?raw';

/**
 * Engineer team radio: pre-recorded voice clips (open-source TTS, see
 * scripts/radio/generate.py) chained into a message, played through a radio
 * effect (beep, 300-3000 Hz band, light distortion, static) while the game
 * sound is ducked, with a Korean subtitle at the bottom of the screen.
 *
 * Messages come from src/audio/radio-lines.json: each line is a template per
 * language ("You are P{pos}. Car ahead is {gap} seconds up the road."); the
 * fixed text between placeholders is one clip, numbers are spoken from the
 * 0-99 clips. Clips load on demand; a missing clip only drops the voice, the
 * subtitle still shows.
 */

export type RadioLang = 'en' | 'ko';
export type RadioPriority = 0 | 1 | 2;
export type RadioVars = { pos?: number; gap?: number };

export interface RadioSettings {
  /** Radio on at all. */
  on: boolean;
  /** Spoken language. */
  lang: RadioLang;
  /** Subtitles on screen. */
  subtitles: boolean;
  /** Radio voice volume 0..1 (separate from the game sound). */
  volume: number;
}

const SETTINGS_KEY = 'f1:radio';
/** The engineer speaks English only (as in F1; the player asked for it). */
const DEFAULTS: RadioSettings = { on: true, lang: 'en', subtitles: true, volume: 0.9 };

export function readRadioSettings(): RadioSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<RadioSettings>), lang: 'en' };
  } catch {
    return { ...DEFAULTS };
  }
}

const settingsListeners = new Set<(s: RadioSettings) => void>();

export function saveRadioSettings(s: RadioSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* not remembered */
  }
  for (const l of settingsListeners) l(s);
}

export function onRadioSettings(l: (s: RadioSettings) => void): () => void {
  settingsListeners.add(l);
  return () => settingsListeners.delete(l);
}

interface Lines {
  lines: Record<string, Record<RadioLang, string>>;
  point: Record<RadioLang, string>;
}
// Vite hands ?raw over as text; Node scripts (tsx) get the parsed JSON.
const LINES = (typeof linesRaw === 'string' ? JSON.parse(linesRaw) : linesRaw) as Lines;
export type RadioLine = keyof typeof LINES.lines & string;

const EN_ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const EN_TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const KO_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

/** Spoken form of 0..99 (same as number_text() in generate.py). */
function numberText(n: number, lang: RadioLang): string {
  n = Math.min(Math.max(Math.round(n), 0), 99);
  if (lang === 'en') {
    if (n < 20) return EN_ONES[n];
    const t = Math.floor(n / 10);
    const u = n % 10;
    return EN_TENS[t - 2] + (u === 0 ? '' : ` ${EN_ONES[u]}`);
  }
  if (n === 0) return '영';
  const t = Math.floor(n / 10);
  const u = n % 10;
  return (t === 0 ? '' : (t === 1 ? '' : KO_DIGITS[t]) + '십') + KO_DIGITS[u];
}

/** Clip text for a template piece (same as chunk_key() in generate.py). */
const clipText = (piece: string) => piece.replace(/^[\s.,!?]+/, '').trim();

/** FNV-1a 32-bit, hex (same as fnv1a() in generate.py). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** File of a clip under public/ (scripts/radio/generate.py writes it). */
export const clipFile = (lang: RadioLang, text: string) => `audio/radio/${lang}/${fnv1a(`${lang}:${text}`)}.mp3`;

/** Every line, for checks. */
export const RADIO_LINES = Object.keys(LINES.lines) as RadioLine[];

const formatGap = (g: number) => (Math.min(Math.max(g, 0), 99.9)).toFixed(1);

/** Subtitle text of a line. */
export function radioText(id: RadioLine, vars: RadioVars, lang: RadioLang): string {
  return LINES.lines[id][lang].replace(/\{(\w+)\}/g, (_, k: string) => (k === 'gap' ? formatGap(vars.gap ?? 0) : String(Math.round(vars.pos ?? 0))));
}

/** Clip texts to play, in order. */
export function clipSequence(id: RadioLine, vars: RadioVars, lang: RadioLang): string[] {
  const out: string[] = [];
  const parts = LINES.lines[id][lang].split(/(\{\w+\})/);
  for (const part of parts) {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) {
      const t = clipText(part);
      if (t) out.push(t);
    } else if (m[1] === 'gap') {
      const [whole, tenth] = formatGap(vars.gap ?? 0).split('.');
      out.push(numberText(+whole, lang), LINES.point[lang], numberText(+tenth, lang));
    } else {
      out.push(numberText(vars.pos ?? 0, lang));
    }
  }
  return out;
}

interface Pending {
  id: RadioLine;
  vars: RadioVars;
  priority: RadioPriority;
  queuedAt: number;
}

/** Minimum quiet time before a message of each priority (s): chatter waits, warnings don't. */
const QUIET: Record<RadioPriority, number> = { 0: 25, 1: 8, 2: 0 };
/** A queued message older than this is no longer news (s), by priority. */
const STALE: Record<RadioPriority, number> = { 0: 6, 1: 12, 2: 20 };

export class TeamRadio {
  private settings = readRadioSettings();
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly queue: Pending[] = [];
  private busyUntil = 0;
  private lastSpoke = -Infinity;
  private readonly subtitle: HTMLDivElement;
  private out: GainNode | null = null;
  private input: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly offSettings: () => void;

  private ctx: AudioContext | null = null;

  /**
   * @param duck lowers / restores the game sound while the engineer talks
   * @param muted whether the game sound is muted (M): the radio follows it
   */
  constructor(
    private readonly duck: (on: boolean) => void = () => {},
    private readonly muted: () => boolean = () => false,
  ) {
    this.subtitle = document.createElement('div');
    this.subtitle.className = 'radio-subtitle';
    this.subtitle.hidden = true;
    document.body.append(this.subtitle);
    this.offSettings = onRadioSettings((s) => {
      this.settings = s;
      if (this.out) this.out.gain.value = s.volume;
    });
  }

  /** Voice output once the game's AudioContext exists (before that: subtitles only). */
  attach(ctx: AudioContext): void {
    this.ctx = ctx;
    // Radio band and grit, straight to the speakers (not through the ducked game bus).
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 300, Q: 0.7 });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3000, Q: 0.7 });
    const drive = new WaveShaperNode(ctx, { curve: softClip(2.2), oversample: '2x' });
    this.out = new GainNode(ctx, { gain: this.settings.volume });
    hp.connect(lp).connect(drive).connect(this.out).connect(ctx.destination);
    this.input = hp;
    const n = Math.floor(ctx.sampleRate * 1.5);
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }

  get speaking(): boolean {
    return performance.now() / 1000 < this.busyUntil;
  }

  /** Queues a message; higher priority goes first, chatter keeps its distance. */
  say(id: RadioLine, vars: RadioVars = {}, priority: RadioPriority = 0): void {
    if (!this.settings.on) return;
    const now = performance.now() / 1000;
    // One of each line at a time.
    const same = this.queue.findIndex((q) => q.id === id);
    if (same >= 0) this.queue.splice(same, 1);
    this.queue.push({ id, vars, priority, queuedAt: now });
    this.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
  }

  /** Call every frame: starts the next message when the channel is free. */
  update(): void {
    const now = performance.now() / 1000;
    if (now >= this.busyUntil && !this.subtitle.hidden && now > this.busyUntil + 1.2) this.subtitle.hidden = true;
    if (now < this.busyUntil || !this.queue.length) return;
    for (let i = this.queue.length - 1; i >= 0; i--) if (now - this.queue[i].queuedAt > STALE[this.queue[i].priority]) this.queue.splice(i, 1);
    const next = this.queue[0];
    if (!next || now - this.lastSpoke < QUIET[next.priority]) return;
    this.queue.shift();
    void this.play(next, now);
  }

  private async play(m: Pending, now: number): Promise<void> {
    const lang = this.settings.lang;
    // Hold the channel while the clips load (they are small, usually cached).
    this.busyUntil = now + 30;
    this.lastSpoke = now;
    this.showSubtitle(m.id, m.vars);
    const ctx = this.ctx;
    if (!ctx || !this.input || this.muted() || ctx.state !== 'running') {
      this.busyUntil = now + 3.5;
      this.lastSpoke = now + 3.5;
      return;
    }
    const clips = await Promise.all(clipSequence(m.id, m.vars, lang).map((t) => this.clip(lang, t)));
    let t = ctx.currentTime + 0.05;
    this.duck(true);
    t = this.beep(t, true);
    const startVoice = t;
    for (const buf of clips) {
      if (!buf) continue;
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      src.connect(this.input);
      src.start(t);
      t += buf.duration + 0.04;
    }
    if (t === startVoice) t += 2.5; // no voice: leave the subtitle up a moment
    this.staticBed(startVoice - 0.15, t + 0.1);
    t = this.beep(t + 0.08, false);
    const end = performance.now() / 1000 + (t - ctx.currentTime);
    this.busyUntil = end;
    this.lastSpoke = end;
    window.setTimeout(() => this.duck(false), (t - ctx.currentTime) * 1000);
  }

  private showSubtitle(id: RadioLine, vars: RadioVars): void {
    if (!this.settings.subtitles) return;
    // English voice (as in F1), Korean subtitles (the players asked for both).
    this.subtitle.replaceChildren();
    const who = document.createElement('b');
    who.textContent = '🎧 엔지니어';
    const main = document.createElement('span');
    main.textContent = radioText(id, vars, 'ko');
    this.subtitle.append(who, main);
    this.subtitle.hidden = false;
  }

  /** "Beep" in (two rising tones) or out (one short tone); returns the end time. */
  private beep(t: number, open: boolean): number {
    const ctx = this.ctx!;
    const tones = open ? [1250, 1650] : [1450];
    for (const f of tones) {
      const o = new OscillatorNode(ctx, { type: 'square', frequency: f });
      const g = new GainNode(ctx, { gain: 0 });
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.005);
      g.gain.setValueAtTime(0.12, t + 0.065);
      g.gain.linearRampToValueAtTime(0, t + 0.075);
      o.connect(g).connect(this.input!);
      o.start(t);
      o.stop(t + 0.08);
      t += 0.085;
    }
    return t + 0.05;
  }

  /** Soft static under the voice. */
  private staticBed(from: number, to: number): void {
    const ctx = this.ctx!;
    const src = new AudioBufferSourceNode(ctx, { buffer: this.noise, loop: true });
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, from);
    g.gain.linearRampToValueAtTime(0.035, from + 0.05);
    g.gain.setValueAtTime(0.035, Math.max(from + 0.05, to - 0.05));
    g.gain.linearRampToValueAtTime(0, to);
    src.connect(g).connect(this.input!);
    src.start(from);
    src.stop(to + 0.05);
  }

  private clip(lang: RadioLang, text: string): Promise<AudioBuffer | null> {
    const key = `${lang}:${text}`;
    let p = this.buffers.get(key);
    if (!p) {
      const url = `${import.meta.env.BASE_URL}${clipFile(lang, text)}`;
      p = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => this.ctx!.decodeAudioData(b))
        .catch(() => null);
      this.buffers.set(key, p);
    }
    return p;
  }

  dispose(): void {
    this.offSettings();
    this.subtitle.remove();
    this.duck(false);
  }
}

function softClip(k: number): Float32Array {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}
