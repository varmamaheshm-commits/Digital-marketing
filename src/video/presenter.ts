/**
 * Animated on-screen host, drawn by the app frame by frame (no outside service, no model).
 * The mouth follows a loudness envelope: taken from the real voice-over when there is one,
 * otherwise a speaking rhythm timed to the words on screen.
 */
import type { Presenter, ScriptScene } from '../core/types';

type Ctx = CanvasRenderingContext2D;
export const FPS = 30;

interface Look { skin: string; skinShade: string; hair: string; shirt: string; long: boolean }
const LOOKS: Record<Exclude<Presenter, 'none'>, Look> = {
  'host-a': { skin: '#c98e6b', skinShade: '#a8714f', hair: '#1f1612', shirt: '#f5f5f4', long: true },
  'host-b': { skin: '#b97f5c', skinShade: '#956243', hair: '#16110e', shirt: '#1e3a5f', long: false },
};

/** Per-frame mouth openness (0-1) for a video whose scenes have no recorded voice. */
export function speakingEnvelope(scenes: ScriptScene[], seed: number): Float32Array {
  const total = scenes.reduce((a, s) => a + s.seconds, 0);
  const env = new Float32Array(Math.ceil(total * FPS) + 1);
  let start = 0;
  for (const s of scenes) {
    const words = `${s.text} ${s.sub ?? ''}`.trim().split(/\s+/).filter(Boolean).length;
    const talk = Math.min(s.seconds - 0.4, 0.35 + words * 0.32);
    for (let f = Math.round((start + 0.3) * FPS); f < Math.round((start + 0.3 + talk) * FPS) && f < env.length; f++) {
      const t = f / FPS;
      // syllable-like rhythm: two mixed rates, never fully closed for long
      const v = 0.5 + 0.5 * Math.sin(t * 17 + seed) * Math.sin(t * 6.3 + seed * 0.7);
      env[f] = Math.max(0.08, Math.min(1, v));
    }
    start += s.seconds;
  }
  return env;
}

/** Mouth envelope from real audio clips placed at given start times (seconds). */
export function envelopeFromAudio(clips: { start: number; data: Float32Array; rate: number }[], seconds: number): Float32Array {
  const env = new Float32Array(Math.ceil(seconds * FPS) + 1);
  let peak = 1e-6;
  for (const c of clips) {
    const per = Math.round(c.rate / FPS);
    for (let i = 0; i * per < c.data.length; i++) {
      let sum = 0;
      const end = Math.min(c.data.length, (i + 1) * per);
      for (let j = i * per; j < end; j++) sum += c.data[j] * c.data[j];
      const rms = Math.sqrt(sum / Math.max(1, end - i * per));
      const f = Math.round(c.start * FPS) + i;
      if (f < env.length) { env[f] = Math.max(env[f], rms); peak = Math.max(peak, rms); }
    }
  }
  for (let f = 0; f < env.length; f++) env[f] = Math.min(1, Math.pow(env[f] / peak, 0.6) * 1.15);
  // light smoothing so the mouth does not flicker
  for (let f = 1; f < env.length; f++) env[f] = env[f] * 0.6 + env[f - 1] * 0.4;
  return env;
}

const ellipse = (ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string) => {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
};

/**
 * Draws the host in a round frame. (x, y) is the centre, r the radius.
 * `mouth` 0-1, `t` seconds since the video started, `wave` 0-1 raises a hand.
 */
export function drawPresenter(ctx: Ctx, kind: Presenter, x: number, y: number, r: number, t: number, mouth: number, wave: number, ring: string) {
  if (kind === 'none') return;
  const L = LOOKS[kind];
  const enter = Math.min(1, Math.max(0, (t - 0.2) / 0.5));
  if (enter <= 0) return;
  const k = 1 - Math.pow(1 - enter, 3);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);

  // frame
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = r * 0.25;
  ellipse(ctx, 0, 0, r * 1.06, r * 1.06, ring);
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  const bg = ctx.createLinearGradient(0, -r, 0, r);
  bg.addColorStop(0, '#fdf6ec');
  bg.addColorStop(1, '#e8dccb');
  ctx.fillStyle = bg;
  ctx.fillRect(-r, -r, r * 2, r * 2);

  const bob = Math.sin(t * 2.1) * r * 0.012 + mouth * r * 0.01;
  const tilt = Math.sin(t * 0.9) * 0.04;
  // body and shoulders
  ellipse(ctx, 0, r * 0.98, r * 0.78, r * 0.48, L.shirt);
  ellipse(ctx, 0, r * 0.62, r * 0.17, r * 0.16, L.skinShade); // neck
  // raised hand (waving)
  if (wave > 0.01) {
    const a = Math.sin(t * 9) * 0.35 * wave;
    ctx.save();
    ctx.translate(r * 0.55, r * 0.7);
    ctx.rotate(-0.9 * wave + a);
    ctx.fillStyle = L.shirt;
    ctx.fillRect(-r * 0.09, -r * 0.5 * wave, r * 0.18, r * 0.5 * wave);
    ellipse(ctx, 0, -r * 0.55 * wave, r * 0.11, r * 0.13, L.skin);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(0, bob);
  ctx.rotate(tilt);
  // hair behind the head
  if (L.long) ellipse(ctx, 0, r * 0.12, r * 0.47, r * 0.62, L.hair);
  // head
  ellipse(ctx, 0, -r * 0.05, r * 0.38, r * 0.46, L.skin);
  ellipse(ctx, -r * 0.38, -r * 0.02, r * 0.06, r * 0.1, L.skinShade); // ears
  ellipse(ctx, r * 0.38, -r * 0.02, r * 0.06, r * 0.1, L.skinShade);
  // hair on top
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.3, r * 0.41, r * 0.27, 0, Math.PI, 0);
  ctx.fillStyle = L.hair;
  ctx.fill();
  if (L.long) { ellipse(ctx, -r * 0.33, -r * 0.12, r * 0.09, r * 0.24, L.hair); ellipse(ctx, r * 0.33, -r * 0.12, r * 0.09, r * 0.24, L.hair); }

  // eyes with blinking
  const blinkPhase = (t + (kind === 'host-a' ? 0 : 1.3)) % 3.7;
  const open = blinkPhase < 0.12 ? 0.12 : 1;
  for (const s of [-1, 1]) {
    ellipse(ctx, s * r * 0.14, -r * 0.07, r * 0.065, r * 0.05 * open, '#ffffff');
    ellipse(ctx, s * r * 0.14 + Math.sin(t * 0.7) * r * 0.01, -r * 0.07, r * 0.032, r * 0.032 * open, '#2b1b12');
    // eyebrows lift a little while talking
    ctx.save();
    ctx.translate(s * r * 0.14, -r * 0.17 - mouth * r * 0.015);
    ctx.rotate(s * -0.08);
    ctx.fillStyle = L.hair;
    ctx.fillRect(-r * 0.075, -r * 0.012, r * 0.15, r * 0.024);
    ctx.restore();
  }
  ellipse(ctx, 0, r * 0.06, r * 0.035, r * 0.05, L.skinShade); // nose
  // cheeks
  ellipse(ctx, -r * 0.2, r * 0.1, r * 0.06, r * 0.035, 'rgba(220,110,110,0.25)');
  ellipse(ctx, r * 0.2, r * 0.1, r * 0.06, r * 0.035, 'rgba(220,110,110,0.25)');
  // mouth: a smile when closed, an open mouth while speaking
  const m = Math.max(0, Math.min(1, mouth));
  if (m < 0.08) {
    ctx.beginPath();
    ctx.arc(0, r * 0.17, r * 0.09, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.strokeStyle = '#7a2e2e';
    ctx.lineWidth = r * 0.025;
    ctx.lineCap = 'round';
    ctx.stroke();
  } else {
    ellipse(ctx, 0, r * 0.23, r * (0.075 + m * 0.025), r * (0.02 + m * 0.07), '#5a1c1c');
    ellipse(ctx, 0, r * 0.23 + r * (0.02 + m * 0.07) * 0.55, r * 0.05, r * 0.02 * m, '#d46a6a'); // tongue
    ellipse(ctx, 0, r * 0.23 - r * (0.02 + m * 0.07) * 0.7, r * 0.06, r * 0.012, '#ffffff'); // teeth
  }
  ctx.restore();
  ctx.restore();
  ctx.restore();
}
