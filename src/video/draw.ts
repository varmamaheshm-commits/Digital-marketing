/**
 * Frame renderer. `drawFrame(ctx, comp, t)` paints the exact picture for time `t`,
 * so the encoder can render frame-by-frame at full quality regardless of device speed.
 */
import { rng } from '../core/copy';
import { FORMAT_INFO, type ScriptScene, type Settings, type Video, type VideoStyle } from '../core/types';

type Ctx = CanvasRenderingContext2D;
export interface Img {
  src: CanvasImageSource;
  w: number;
  h: number;
  blur: CanvasImageSource;
}
interface StyleDef {
  font: string;
  weight: number;
  upper: boolean;
  box: 'brand' | 'white' | 'none';
  dim: number;
  accent?: string;
  spacing: number;
}
const STYLES: Record<VideoStyle, StyleDef> = {
  bold: { font: '"Arial Black", "Segoe UI Black", "Roboto Black", "Helvetica Neue", Arial, sans-serif', weight: 900, upper: true, box: 'brand', dim: 0.3, spacing: 0 },
  clean: { font: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', weight: 700, upper: false, box: 'white', dim: 0.22, spacing: 0 },
  luxe: { font: 'Georgia, "Times New Roman", "Noto Serif", serif', weight: 600, upper: false, box: 'none', dim: 0.42, accent: '#d9b871', spacing: 0.02 },
};
interface CompScene extends ScriptScene {
  start: number;
  img: number;
  layout: 'full' | 'card' | 'brand';
  motion: { s0: number; s1: number; px: number; py: number };
  n: number;
}
export interface Comp {
  w: number;
  h: number;
  fps: number;
  duration: number;
  scenes: CompScene[];
  style: StyleDef;
  primary: string;
  accent: string;
  business: string;
  images: Img[];
  cache: Map<string, Fit>;
}

export function buildComp(video: Video, images: Img[], s: Settings): Comp {
  const { w, h } = FORMAT_INFO[video.format];
  const r = rng(video.seed ^ 0x5f3759df);
  const style = STYLES[video.style];
  let t = 0;
  let feature = 0;
  let imgCursor = 0;
  const scenes = video.script.map((sc): CompScene => {
    const zoomIn = r() > 0.4;
    const scene: CompScene = {
      ...sc,
      start: t,
      img: images.length ? imgCursor++ % images.length : -1,
      layout: sc.kind === 'cta' ? 'brand' : sc.kind === 'feature' ? 'card' : 'full',
      motion: { s0: zoomIn ? 1.04 : 1.2, s1: zoomIn ? 1.2 : 1.04, px: (r() - 0.5) * 1.2, py: (r() - 0.5) * 0.8 },
      n: sc.kind === 'feature' ? ++feature : 0,
    };
    if (sc.kind === 'cta' && images.length) scene.img = 0;
    t += sc.seconds;
    return scene;
  });
  return {
    w, h, fps: 30, duration: t, scenes, style,
    primary: s.brand.primary, accent: style.accent ?? s.brand.accent,
    business: s.business.name, images, cache: new Map(),
  };
}

// ---------- maths & colour ----------
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const outCubic = (x: number) => 1 - (1 - clamp(x)) ** 3;
const inOut = (x: number) => { x = clamp(x); return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2; };
const outBack = (x: number) => { x = clamp(x); const c = 1.70158; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0x6d28d9;
  const f = (c: number) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
const onColor = (hex: string) => (luminance(hex) > 0.62 ? '#111827' : '#ffffff');

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- text ----------
interface Fit { size: number; lines: string[] }
const fontOf = (c: Comp, size: number, weight = c.style.weight) => `${weight} ${Math.round(size)}px ${c.style.font}`;

function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest font size (between min and max) at which the text fits the box. */
function fit(ctx: Ctx, c: Comp, text: string, maxW: number, maxH: number, max: number, weight = c.style.weight, lh = 1.12): Fit {
  const k = `${text}|${Math.round(maxW)}|${Math.round(maxH)}|${Math.round(max)}|${weight}`;
  const hit = c.cache.get(k);
  if (hit) return hit;
  let out: Fit = { size: max, lines: [text] };
  for (let size = max; size >= max * 0.28; size *= 0.94) {
    ctx.font = fontOf(c, size, weight);
    const lines = wrap(ctx, text, maxW);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    out = { size, lines };
    if (lines.length * size * lh <= maxH && widest <= maxW) break;
  }
  c.cache.set(k, out);
  return out;
}

interface TextOpts {
  align?: 'left' | 'center';
  color?: string;
  weight?: number;
  box?: string | null;
  boxText?: string;
  delay?: number;
  stagger?: number;
  alpha?: number;
  shadow?: boolean;
  lh?: number;
}
/** Draws wrapped text with a word-by-word reveal. (x, y) is the left/centre top of the block. Returns block height. */
function words(ctx: Ctx, c: Comp, f: Fit, x: number, y: number, lt: number, o: TextOpts = {}): number {
  const { align = 'center', color = '#fff', weight = c.style.weight, delay = 0, stagger = 0.07, alpha = 1, shadow = true } = o;
  const lh = o.lh ?? 1.12;
  ctx.font = fontOf(c, f.size, weight);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const space = ctx.measureText(' ').width;
  let wi = 0;
  f.lines.forEach((line, li) => {
    const lw = ctx.measureText(line).width;
    let cx = align === 'center' ? x - lw / 2 : x;
    const top = y + li * f.size * lh;
    const base = top + f.size * 0.86;
    if (o.box) {
      const k = outCubic((lt - delay - li * 0.12) / 0.35);
      if (k > 0) {
        ctx.save();
        ctx.globalAlpha = alpha * k;
        ctx.fillStyle = o.box;
        const padX = f.size * 0.32;
        const bw = (lw + padX * 2) * k;
        rr(ctx, cx - padX, top - f.size * 0.06, bw, f.size * lh * 1.02, f.size * 0.18);
        ctx.fill();
        ctx.restore();
      }
    }
    for (const word of line.split(' ')) {
      const k = outCubic((lt - delay - wi * stagger) / 0.32);
      if (k > 0) {
        ctx.save();
        ctx.globalAlpha = alpha * k;
        if (shadow && !o.box) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = f.size * 0.25; ctx.shadowOffsetY = f.size * 0.04; }
        ctx.fillStyle = o.box ? o.boxText ?? color : color;
        ctx.fillText(word, cx, base + (1 - k) * f.size * 0.45);
        ctx.restore();
      }
      cx += ctx.measureText(word).width + space;
      wi++;
    }
  });
  return f.lines.length * f.size * lh;
}

const say = (c: Comp, s: string) => (c.style.upper ? s.toUpperCase() : s);

// ---------- backgrounds ----------
function cover(ctx: Ctx, im: Img, x: number, y: number, w: number, h: number, scale: number, px: number, py: number, blurred = false) {
  const base = Math.max(w / im.w, h / im.h) * scale;
  const dw = im.w * base, dh = im.h * base;
  ctx.drawImage(blurred ? im.blur : im.src, x + (w - dw) / 2 + (px * (dw - w)) / 2, y + (h - dh) / 2 + (py * (dh - h)) / 2, dw, dh);
}

function gradientBg(ctx: Ctx, c: Comp, t: number) {
  const g = ctx.createLinearGradient(0, 0, c.w, c.h);
  g.addColorStop(0, shade(c.primary, -0.15));
  g.addColorStop(1, shade(c.primary, -0.72));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.w, c.h);
  // slow drifting light shapes
  const m = Math.min(c.w, c.h);
  for (let i = 0; i < 4; i++) {
    const a = t * 0.25 + i * 1.7;
    const x = c.w * (0.5 + 0.38 * Math.cos(a + i)), y = c.h * (0.5 + 0.38 * Math.sin(a * 0.8 + i * 2));
    const rad = m * (0.35 + 0.1 * i);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    rg.addColorStop(0, i % 2 ? 'rgba(255,255,255,0.10)' : shade(c.accent, 0).replace('rgb', 'rgba').replace(')', ',0.22)'));
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, c.w, c.h);
  }
}

function cardRect(c: Comp) {
  const { w, h } = c;
  if (w > h) return { x: w * 0.05, y: h * 0.1, w: w * 0.46, h: h * 0.8 };
  if (w === h) return { x: w * 0.08, y: h * 0.08, w: w * 0.84, h: h * 0.54 };
  return { x: w * 0.07, y: h * 0.13, w: w * 0.86, h: h * 0.5 };
}

/** True when the photo's shape is too different from the frame to fill it without heavy cropping. */
function contained(c: Comp, sc: CompScene): boolean {
  const im = sc.img >= 0 ? c.images[sc.img] : null;
  if (!im || sc.layout !== 'full') return false;
  const mismatch = im.w / im.h / (c.w / c.h);
  return mismatch <= 0.62 || mismatch >= 1.65;
}

function background(ctx: Ctx, c: Comp, sc: CompScene, lt: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const im = sc.img >= 0 ? c.images[sc.img] : null;
  const k = inOut(lt / sc.seconds);
  const scale = lerp(sc.motion.s0, sc.motion.s1, k);
  const px = sc.motion.px * (k - 0.5), py = sc.motion.py * (k - 0.5);
  const m = Math.min(c.w, c.h);
  if (!im || sc.layout === 'brand') {
    gradientBg(ctx, c, sc.start + lt);
  } else if (sc.layout === 'card') {
    cover(ctx, im, 0, 0, c.w, c.h, 1.25, 0, 0, true);
    ctx.fillStyle = `rgba(8,10,20,${0.38 + c.style.dim * 0.5})`;
    ctx.fillRect(0, 0, c.w, c.h);
    const r = cardRect(c);
    const enter = outCubic(lt / 0.55);
    const dy = (1 - enter) * m * 0.06;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = m * 0.05; ctx.shadowOffsetY = m * 0.015;
    rr(ctx, r.x, r.y + dy, r.w, r.h, m * 0.035);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    ctx.save();
    rr(ctx, r.x, r.y + dy, r.w, r.h, m * 0.035);
    ctx.clip();
    cover(ctx, im, r.x, r.y + dy, r.w, r.h, scale, px, py);
    ctx.restore();
  } else {
    if (!contained(c, sc)) {
      cover(ctx, im, 0, 0, c.w, c.h, scale, px, py);
    } else {
      // Photo shape is very different from the frame: show it whole over a blurred copy.
      cover(ctx, im, 0, 0, c.w, c.h, 1.25, 0, 0, true);
      ctx.fillStyle = 'rgba(8,10,20,0.35)';
      ctx.fillRect(0, 0, c.w, c.h);
      // Leave clear room for the title on the product-reveal scene.
      let boxW = c.w * 0.92, boxH = c.h * 0.7, cx = c.w / 2, cy = c.h * 0.47;
      if (sc.kind === 'reveal') {
        if (c.w > c.h) { boxW = c.w * 0.4; boxH = c.h * 0.78; cx = c.w * 0.75; cy = c.h * 0.5; }
        else { boxH = c.h * 0.48; cy = c.h * 0.36; }
      }
      const base = Math.min(boxW / im.w, boxH / im.h) * (0.9 + (scale - 1) * 0.5);
      const dw = im.w * base, dh = im.h * base;
      const x = cx - dw / 2, y = cy - dh / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = m * 0.05;
      rr(ctx, x, y, dw, dh, m * 0.03);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();
      ctx.save();
      rr(ctx, x, y, dw, dh, m * 0.03);
      ctx.clip();
      ctx.drawImage(im.src, x, y, dw, dh);
      ctx.restore();
    }
    // legibility gradient
    const g = ctx.createLinearGradient(0, 0, 0, c.h);
    const d = c.style.dim + (sc.kind === 'offer' ? 0.25 : 0);
    g.addColorStop(0, `rgba(5,8,18,${d + 0.15})`);
    g.addColorStop(0.3, `rgba(5,8,18,${d * 0.5})`);
    g.addColorStop(0.55, `rgba(5,8,18,${d * 0.6})`);
    g.addColorStop(1, `rgba(5,8,18,${Math.min(0.9, d + 0.5)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.w, c.h);
  }
  ctx.restore();
}

// ---------- scene foregrounds ----------
function foreground(ctx: Ctx, c: Comp, sc: CompScene, lt: number, last: boolean) {
  const { w, h } = c;
  const m = Math.min(w, h);
  const out = last ? 1 : clamp((sc.seconds - lt) / 0.22);
  const boxColor = c.style.box === 'brand' ? c.primary : c.style.box === 'white' ? '#ffffff' : null;
  const boxText = c.style.box === 'brand' ? onColor(c.primary) : '#111827';
  const d = 0.25; // let the transition settle before text enters

  if (sc.kind === 'hook') {
    const f = fit(ctx, c, say(c, sc.text), w * 0.84, h * 0.34, m * 0.15);
    const bh = f.lines.length * f.size * 1.12;
    const y = h * 0.47 - bh / 2;
    words(ctx, c, f, w / 2, y, lt, { delay: d, stagger: 0.11, alpha: out, box: boxColor, boxText });
    if (sc.sub) {
      const fs = fit(ctx, c, sc.sub, w * 0.8, h * 0.1, m * 0.05, 600);
      words(ctx, c, fs, w / 2, y + bh + m * 0.05, lt, { delay: d + 0.7, alpha: out, weight: 600, color: '#fff' });
    }
  } else if (sc.kind === 'reveal') {
    const x = w * 0.07;
    const boxed = contained(c, sc);
    const side = boxed && w > h; // photo sits on the right, title on the left
    const tw = side ? w * 0.46 : w * 0.86;
    const f = fit(ctx, c, say(c, sc.text), tw, h * (side ? 0.4 : boxed ? 0.13 : 0.2), m * 0.13);
    const fs = sc.sub ? fit(ctx, c, sc.sub, tw * 0.96, h * (side ? 0.2 : 0.09), m * 0.046, 500) : null;
    const bh = f.lines.length * f.size * 1.12;
    const sh = fs ? fs.lines.length * fs.size * 1.25 : 0;
    const y = side ? h * 0.52 - (bh + sh) / 2 : h * 0.86 - bh - sh;
    const k = outCubic((lt - d) / 0.5);
    ctx.save();
    ctx.globalAlpha = out;
    ctx.fillStyle = c.accent;
    ctx.fillRect(x, y - m * 0.045, m * 0.16 * k, m * 0.012);
    ctx.restore();
    words(ctx, c, f, x, y, lt, { align: 'left', delay: d + 0.1, alpha: out });
    if (fs) words(ctx, c, fs, x, y + bh + m * 0.015, lt, { align: 'left', delay: d + 0.6, stagger: 0.03, alpha: out, weight: 500, color: 'rgba(255,255,255,0.92)', lh: 1.25 });
  } else if (sc.kind === 'feature') {
    const r = cardRect(c);
    const wide = w > h;
    const bare = sc.img < 0; // no photo: use the whole frame for the text
    const ax = bare ? w * 0.1 : wide ? r.x + r.w + w * 0.05 : w * 0.08;
    const aw = bare ? w * 0.8 : wide ? w - ax - w * 0.05 : w * 0.84;
    const ay = bare ? h * 0.3 : wide ? h * 0.3 : r.y + r.h + h * 0.05;
    const ah = bare ? h * 0.45 : wide ? h * 0.45 : h - ay - h * 0.1;
    const k = outBack((lt - d) / 0.45);
    // numbered badge
    const br = m * 0.05;
    if (k > 0) {
      ctx.save();
      ctx.globalAlpha = out * clamp(k);
      ctx.translate(ax + br, ay + br);
      ctx.scale(k, k);
      ctx.fillStyle = c.accent;
      ctx.beginPath(); ctx.arc(0, 0, br, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = onColor(c.accent.startsWith('#') ? c.accent : '#d9b871');
      ctx.font = fontOf(c, br * 1.05, 800);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(sc.n), 0, br * 0.06);
      ctx.restore();
    }
    const f = fit(ctx, c, say(c, sc.text), aw, ah - br * 2.6, m * (bare ? 0.11 : 0.085));
    words(ctx, c, f, ax, ay + br * 2.6, lt, { align: 'left', delay: d + 0.15, alpha: out });
  } else if (sc.kind === 'offer') {
    const k = outBack((lt - d) / 0.55);
    const pulse = 1 + 0.025 * Math.sin((lt - d) * 6);
    const rad = m * 0.3;
    if (k > 0) {
      ctx.save();
      ctx.globalAlpha = out * clamp(k * 1.5);
      ctx.translate(w / 2, h * 0.45);
      ctx.scale(k * pulse, k * pulse);
      ctx.rotate(-0.07);
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = m * 0.05;
      ctx.fillStyle = c.accent;
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = m * 0.006;
      ctx.setLineDash([m * 0.02, m * 0.014]);
      ctx.beginPath(); ctx.arc(0, 0, rad * 0.9, 0, Math.PI * 2); ctx.stroke();
      const f = fit(ctx, c, sc.text, rad * 1.5, rad * 0.9, rad * 0.62, 900);
      ctx.fillStyle = onColor(c.accent.startsWith('#') ? c.accent : '#d9b871');
      ctx.font = fontOf(c, f.size, 900);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      f.lines.forEach((line, i) => ctx.fillText(line, 0, (i - (f.lines.length - 1) / 2) * f.size * 1.08));
      ctx.restore();
    }
    if (sc.sub) {
      const fs = fit(ctx, c, say(c, sc.sub), w * 0.8, h * 0.12, m * 0.06);
      words(ctx, c, fs, w / 2, h * 0.45 + rad + m * 0.07, lt, { delay: d + 0.5, alpha: out, box: boxColor ?? 'rgba(0,0,0,0.55)', boxText: boxColor ? boxText : '#fff' });
    }
  } else {
    // call to action
    const im = sc.img >= 0 ? c.images[sc.img] : null;
    const wide = w > h;
    let top = h * (wide ? 0.2 : 0.2);
    if (im) {
      const rad = m * (wide ? 0.15 : 0.19);
      const k = outBack(lt / 0.6);
      ctx.save();
      ctx.translate(w / 2, top + rad);
      ctx.scale(k, k);
      ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = m * 0.04;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(0, 0, rad * 1.05, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.clip();
      cover(ctx, im, -rad, -rad, rad * 2, rad * 2, 1.05 + lt * 0.015, 0, 0);
      ctx.restore();
      top += rad * 2 + m * 0.06;
    } else top = h * 0.32;
    const f = fit(ctx, c, say(c, sc.text), w * 0.84, h * 0.2, m * 0.105);
    const bh = words(ctx, c, f, w / 2, top, lt, { delay: d, alpha: out });
    if (sc.sub) {
      const fs = fit(ctx, c, sc.sub, w * 0.74, h * 0.07, m * 0.044, 700);
      ctx.font = fontOf(c, fs.size, 700);
      const tw = Math.max(...fs.lines.map((l) => ctx.measureText(l).width));
      const k = outBack((lt - d - 0.6) / 0.5);
      if (k > 0) {
        const pulse = 1 + 0.03 * Math.sin(lt * 5);
        const bw = tw + fs.size * 2.2, bhh = fs.lines.length * fs.size * 1.25 + fs.size * 1.1;
        ctx.save();
        ctx.translate(w / 2, top + bh + m * 0.06 + bhh / 2);
        ctx.scale(k * pulse, k * pulse);
        ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = m * 0.03; ctx.shadowOffsetY = m * 0.008;
        ctx.fillStyle = c.accent;
        rr(ctx, -bw / 2, -bhh / 2, bw, bhh, bhh / 2);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = onColor(c.accent.startsWith('#') ? c.accent : '#d9b871');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        fs.lines.forEach((line, i) => ctx.fillText(line, 0, (i - (fs.lines.length - 1) / 2) * fs.size * 1.25 + fs.size * 0.05));
        ctx.restore();
      }
    }
  }
}

function chrome(ctx: Ctx, c: Comp, t: number, sc: CompScene) {
  const m = Math.min(c.w, c.h);
  // soft vignette
  const v = ctx.createRadialGradient(c.w / 2, c.h / 2, m * 0.45, c.w / 2, c.h / 2, Math.hypot(c.w, c.h) / 2);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, c.w, c.h);
  // brand chip
  if (c.business && sc.kind !== 'cta') {
    const a = clamp((t - 0.4) / 0.5);
    const size = m * 0.03;
    ctx.save();
    ctx.globalAlpha = a * 0.95;
    ctx.font = fontOf(c, size, 700);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const x = c.w * 0.06, y = c.h * (c.w < c.h ? 0.065 : 0.07);
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(x + size * 0.4, y, size * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = size * 0.5;
    ctx.fillStyle = '#fff';
    ctx.fillText(c.business, x + size * 1.2, y + size * 0.05);
    ctx.restore();
  }
  // progress line
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(0, c.h - m * 0.008, c.w, m * 0.008);
  ctx.fillStyle = c.accent;
  ctx.fillRect(0, c.h - m * 0.008, c.w * clamp(t / c.duration), m * 0.008);
}

const TRANSITION = 0.45;

export function drawFrame(ctx: Ctx, c: Comp, t: number) {
  t = clamp(t, 0, c.duration - 1e-4);
  let i = c.scenes.findIndex((s) => t < s.start + s.seconds);
  if (i < 0) i = c.scenes.length - 1;
  const sc = c.scenes[i];
  const lt = t - sc.start;
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, c.w, c.h);
  if (i > 0 && lt < TRANSITION) {
    const prev = c.scenes[i - 1];
    background(ctx, c, prev, prev.seconds, 1);
    const k = inOut(lt / TRANSITION);
    ctx.save();
    // incoming scene eases in with a slight push
    const z = 1.06 - 0.06 * k;
    ctx.translate(c.w / 2, c.h / 2); ctx.scale(z, z); ctx.translate(-c.w / 2, -c.h / 2);
    background(ctx, c, sc, lt, k);
    ctx.restore();
  } else {
    background(ctx, c, sc, lt, 1);
  }
  foreground(ctx, c, sc, lt, i === c.scenes.length - 1);
  chrome(ctx, c, t, sc);
  if (t < 0.25) { // fade from black at the very start
    ctx.fillStyle = `rgba(5,7,15,${1 - t / 0.25})`;
    ctx.fillRect(0, 0, c.w, c.h);
  }
}
