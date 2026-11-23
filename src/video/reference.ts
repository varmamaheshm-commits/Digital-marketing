/**
 * Reference videos: the owner uploads a video whose style they like, the app measures it on this
 * device (length, where the cuts are, colours, brightness, how much moves) and creates a new video
 * for their product with the same rhythm and look. Only the measurements are kept; none of the
 * reference footage is stored or used in the new video.
 */
import type { MusicMood, ReferenceLook, ScriptScene, Video, VideoStyle } from '../core/types';
import { shapeOf } from './upload';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Finds the cuts in a video from how much each sampled frame differs from the one before
 * (`diffs[i]` is the change between sample i and i+1, from 0 to 1, samples `step` seconds apart).
 * A cut is a change far above the video's typical movement, at least 0.4 seconds after the last cut.
 */
export function findCuts(diffs: number[], step: number): number[] {
  if (!diffs.length) return [];
  // Median-based: the cuts themselves must not raise the bar they are measured against.
  const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const mid = median(diffs);
  const spread = median(diffs.map((d) => Math.abs(d - mid))) * 1.4826;
  const limit = Math.max(0.12, mid + 6 * spread);
  const cuts: number[] = [];
  let last = -Infinity;
  diffs.forEach((d, i) => {
    const t = (i + 1) * step;
    if (d >= limit && t - last >= 0.4) { cuts.push(round1(t)); last = t; }
  });
  return cuts;
}

/** Shot lengths between the cuts; a shot shorter than 0.2 seconds is joined to the one before. */
export function shotLengths(cuts: number[], seconds: number): number[] {
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < seconds), seconds];
  const shots: number[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const len = bounds[i] - bounds[i - 1];
    if (len < 0.2 && shots.length) shots[shots.length - 1] += len;
    else shots.push(len);
  }
  return shots.map(round1).filter((s) => s > 0);
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0')).join('');
const parse = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Saturation (0-1) and lightness (0-1) of a colour. */
export function satLight(h: string): { s: number; l: number } {
  const [r, g, b] = parse(h).map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

/**
 * The most common colours in RGBA pixels: colours are grouped into buckets, the biggest buckets are
 * averaged, and colours too close to one already chosen are skipped.
 */
export function paletteFrom(rgba: ArrayLike<number>, count = 5): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const k = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    k.n++; k.r += r; k.g += g; k.b += b;
    buckets.set(key, k);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).map((k) => [k.r / k.n, k.g / k.n, k.b / k.n]);
  const chosen: number[][] = [];
  for (const c of ranked) {
    if (chosen.every((p) => dist(p, c) > 48)) chosen.push(c);
    if (chosen.length >= count) break;
  }
  return chosen.map((c) => hex(c[0], c[1], c[2]));
}

/** Picks the look and music that match the reference's colours and pace. */
export function styleFor(ref: ReferenceLook): { style: VideoStyle; mood: MusicMood } {
  const avgShot = ref.shots.length ? ref.seconds / ref.shots.length : ref.seconds;
  const fast = avgShot < 1.8 || ref.motion > 0.06;
  const style: VideoStyle = ref.brightness < 0.36 && ref.saturation < 0.4 ? 'luxe' : ref.saturation > 0.45 || fast ? 'bold' : 'clean';
  const mood: MusicMood = fast ? 'upbeat' : ref.brightness < 0.36 || avgShot > 4 ? 'cinematic' : 'chill';
  return { style, mood };
}

/**
 * Brand-like colours from the reference palette: the most common vivid colour that text can sit on
 * as the main colour, and the next clearly different vivid colour as the accent. Null when the reference is
 * too grey to give useful colours (then the brand colours are kept).
 */
export function colorsFrom(palette: string[]): { primary: string; accent: string } | null {
  const vivid = palette
    .map((h) => ({ h, ...satLight(h) }))
    .filter((c) => c.s > 0.25 && c.l > 0.15 && c.l < 0.85);
  if (!vivid.length) return null;
  const primary = vivid[0].h;
  const accent = vivid.find((c) => dist(parse(c.h), parse(primary)) > 90)?.h ?? (satLight(primary).l > 0.5 ? '#111827' : '#ffffff');
  return { primary, accent };
}

/** Length of the new video: the reference's length, kept within the 10-30 seconds the app makes. */
export const targetFor = (ref: ReferenceLook) => clamp(Math.round(ref.seconds), 10, 30);

/**
 * Spreads the reference's cut rhythm over the script's scenes: the reference shots are grouped into
 * as many parts as there are scenes, each scene gets its part's share of the new length, and every
 * scene stays at least 1.2 seconds (2 seconds for the closing call to action) so its text can be read.
 */
export function retime(script: ScriptScene[], shots: number[], total: number): ScriptScene[] {
  const n = script.length;
  if (!n) return script;
  let parts: number[];
  if (shots.length >= n) {
    parts = Array(n).fill(0);
    shots.forEach((s, i) => { parts[Math.min(n - 1, Math.floor((i * n) / shots.length))] += s; });
  } else {
    parts = Array(n).fill(1);
  }
  const min = script.map((sc) => (sc.kind === 'cta' ? 2 : 1.2));
  const minSum = min.reduce((a, b) => a + b, 0);
  const free = Math.max(0, total - minSum);
  const weight = parts.reduce((a, b) => a + b, 0) || 1;
  const out = script.map((sc, i) => ({ ...sc, seconds: round1(min[i] + (free * parts[i]) / weight) }));
  const drift = round1(total - out.reduce((a, b) => a + b.seconds, 0));
  out[n - 1].seconds = round1(out[n - 1].seconds + drift);
  return out;
}

/** Turns a freshly written video into one made in the reference's style. */
export function applyReference(v: Video, ref: ReferenceLook, opts: { useColors: boolean; style?: VideoStyle; mood?: MusicMood }): Video {
  const auto = styleFor(ref);
  const total = v.script.reduce((a, b) => a + b.seconds, 0);
  const colors = opts.useColors ? colorsFrom(ref.palette) : null;
  return {
    ...v,
    style: opts.style ?? auto.style,
    mood: opts.mood ?? auto.mood,
    script: retime(v.script, ref.shots, total),
    reference: ref,
    colors: colors ?? undefined,
  };
}

/** Plain words for the owner: what the app took from the reference. */
export function describeReference(ref: ReferenceLook): string {
  const avg = ref.shots.length ? ref.seconds / ref.shots.length : ref.seconds;
  const pace = avg < 1.8 ? 'fast cuts' : avg > 4 ? 'slow, long shots' : 'steady cuts';
  const light = ref.brightness < 0.36 ? 'dark' : ref.brightness > 0.62 ? 'bright' : 'medium-bright';
  const colour = ref.saturation > 0.45 ? 'vivid colours' : ref.saturation < 0.2 ? 'muted colours' : 'natural colours';
  return `${Math.round(ref.seconds)} seconds, ${ref.shots.length} shot${ref.shots.length === 1 ? '' : 's'} (${pace}), ${light}, ${colour}`;
}

// ---------- reading the video on this device ----------

const once = (el: HTMLMediaElement, ok: string, ms: number) =>
  new Promise<boolean>((resolve) => {
    const done = (v: boolean) => { clearTimeout(t); el.removeEventListener(ok, yes); el.removeEventListener('error', no); resolve(v); };
    const yes = () => done(true), no = () => done(false);
    const t = setTimeout(no, ms);
    el.addEventListener(ok, yes);
    el.addEventListener('error', no);
  });

/** Longest stretch of a reference that is measured; the rest of a long video adds little. */
export const MAX_ANALYSED_SECONDS = 90;

/**
 * Measures a reference video on this device. Returns null when this device cannot decode it
 * (for example some HEVC phone recordings). `onProgress` gets a fraction from 0 to 1.
 */
export async function analyzeReference(file: File, onProgress?: (fraction: number) => void): Promise<ReferenceLook | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  try {
    const loaded = once(v, 'loadeddata', 15000);
    v.src = url;
    if (!(await loaded) || !v.videoWidth || !Number.isFinite(v.duration) || v.duration <= 0) return null;
    const seconds = v.duration;
    const span = Math.min(seconds, MAX_ANALYSED_SECONDS);
    const step = Math.max(0.1, span / 180);
    const W = 64, H = Math.max(16, Math.round((64 * v.videoHeight) / v.videoWidth));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const diffs: number[] = [];
    const sample: number[] = [];
    let prev: Uint8ClampedArray | null = null;
    let light = 0, sat = 0, frames = 0;
    for (let t = 0; t < span; t += step) {
      const seeked = once(v, 'seeked', 5000);
      v.currentTime = Math.min(t, seconds - 0.05);
      if (!(await seeked)) break;
      ctx.drawImage(v, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      let d = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        light += (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        sat += max ? (max - min) / max : 0;
        if (prev) d += (Math.abs(r - prev[i]) + Math.abs(g - prev[i + 1]) + Math.abs(b - prev[i + 2])) / 765;
        if (i % 32 === 0) sample.push(r, g, b, 255);
      }
      if (prev) diffs.push(d / (px.length / 4));
      prev = px;
      frames++;
      onProgress?.(Math.min(1, t / span));
    }
    if (frames < 2) return null;
    const pixels = (W * H) * frames;
    const cuts = findCuts(diffs, step);
    const motion = diffs.filter((d) => d < 0.12).reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
    return {
      name: file.name,
      seconds: round1(seconds),
      format: shapeOf(v.videoWidth, v.videoHeight),
      shots: shotLengths(cuts, round1(span)),
      palette: paletteFrom(sample),
      brightness: Math.round((light / pixels) * 100) / 100,
      saturation: Math.round((sat / pixels) * 100) / 100,
      motion: Math.round(motion * 1000) / 1000,
    };
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}
