/**
 * Offline video renderer: draws every frame to a canvas, encodes with the
 * device's own WebCodecs encoder and writes a standard MP4 — all on the device.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { FORMAT_INFO, type Settings, type Video } from '../core/types';
import { buildComp, drawFrame, type Img } from './draw';
import { SAMPLE_RATE, synthMusic } from './music';

export interface RenderResult {
  data: ArrayBuffer;
  thumb: ArrayBuffer | null;
  mime: string;
  codec: string;
  seconds: number;
}

const VIDEO_CODECS: { mux: 'avc' | 'vp9' | 'av1'; codec: string }[] = [
  { mux: 'avc', codec: 'avc1.640028' }, // H.264 High – plays everywhere, accepted by Instagram / YouTube
  { mux: 'avc', codec: 'avc1.4d0028' },
  { mux: 'avc', codec: 'avc1.42e028' },
  { mux: 'vp9', codec: 'vp09.00.40.08' },
  { mux: 'av1', codec: 'av01.0.08M.08' },
];
const AUDIO_CODECS: { mux: 'aac' | 'opus'; codec: string }[] = [
  { mux: 'aac', codec: 'mp4a.40.2' },
  { mux: 'opus', codec: 'opus' },
];

export const canRenderVideo = () => typeof (globalThis as any).VideoEncoder === 'function';

/** Yields to the UI without being throttled when the window is in the background. */
const breathe = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

export async function loadImage(bytes: ArrayBuffer, maxSide = 2400): Promise<Img> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(2, Math.round(bmp.width * k)), h = Math.max(2, Math.round(bmp.height * k));
  const main = document.createElement('canvas');
  main.width = w; main.height = h;
  const mc = main.getContext('2d')!;
  mc.imageSmoothingQuality = 'high';
  mc.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  // Soft-focus copy for backgrounds: shrink hard, then enlarge (works on every browser).
  const tiny = document.createElement('canvas');
  tiny.width = Math.max(2, Math.round((w / Math.max(w, h)) * 40)); tiny.height = Math.max(2, Math.round((h / Math.max(w, h)) * 40));
  tiny.getContext('2d')!.drawImage(main, 0, 0, tiny.width, tiny.height);
  const blur = document.createElement('canvas');
  blur.width = tiny.width * 8; blur.height = tiny.height * 8;
  const bc = blur.getContext('2d')!;
  bc.imageSmoothingQuality = 'high';
  if ('filter' in bc) bc.filter = 'blur(6px)';
  bc.drawImage(tiny, -8, -8, blur.width + 16, blur.height + 16);
  return { src: main, w, h, blur };
}

async function pickVideo(w: number, h: number, bitrate: number, fps: number) {
  const VE = (globalThis as any).VideoEncoder;
  for (const c of VIDEO_CODECS) {
    const config: any = { codec: c.codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' };
    if (c.mux === 'avc') config.avc = { format: 'avc' };
    try {
      if ((await VE.isConfigSupported(config)).supported) return { ...c, config };
    } catch { /* try next */ }
  }
  return null;
}

async function pickAudio() {
  const AE = (globalThis as any).AudioEncoder;
  if (typeof AE !== 'function') return null;
  for (const c of AUDIO_CODECS) {
    const config = { codec: c.codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 160_000 };
    try {
      if ((await AE.isConfigSupported(config)).supported) return { ...c, config };
    } catch { /* try next */ }
  }
  return null;
}

export async function renderVideo(
  video: Video,
  imageBytes: ArrayBuffer[],
  settings: Settings,
  onProgress: (fraction: number) => void,
  isCancelled: () => boolean = () => false,
): Promise<RenderResult> {
  if (!canRenderVideo()) throw new Error('This device/browser has no built-in video encoder (WebCodecs). Use the desktop or Android app, or a current Chrome, Edge or Safari.');
  const { w, h } = FORMAT_INFO[video.format];
  const images: Img[] = [];
  for (const b of imageBytes) {
    try { images.push(await loadImage(b)); } catch { /* skip unreadable photo */ }
  }
  const comp = buildComp(video, images, settings);
  const fps = comp.fps;
  const total = Math.round(comp.duration * fps);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingQuality = 'high';

  const vsel = await pickVideo(w, h, w * h >= 1920 * 1080 ? 10_000_000 : 7_000_000, fps);
  if (!vsel) throw new Error('No supported video encoder was found on this device.');
  const music = await synthMusic(video.mood, comp.duration, video.seed).catch(() => null);
  const asel = music ? await pickAudio() : null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: vsel.mux, width: w, height: h, frameRate: fps },
    audio: asel ? { codec: asel.mux, numberOfChannels: 2, sampleRate: SAMPLE_RATE } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure: unknown = null;
  const VE = (globalThis as any).VideoEncoder;
  const encoder = new VE({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: unknown) => (failure = e),
  });
  encoder.configure(vsel.config);

  let thumb: ArrayBuffer | null = null;
  const thumbFrame = Math.min(total - 1, Math.round(((comp.scenes[1]?.start ?? 0) + 1.6) * fps));

  for (let f = 0; f < total; f++) {
    if (failure) throw failure;
    if (isCancelled()) { encoder.close(); throw new Error('cancelled'); }
    drawFrame(ctx, comp, f / fps);
    const frame = new (globalThis as any).VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();
    if (f === thumbFrame) thumb = await snapshot(canvas);
    while (encoder.encodeQueueSize > 3 && !failure) await breathe();
    if (f % 3 === 0) { onProgress((f / total) * 0.94); await breathe(); }
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  if (music && asel) {
    const AE = (globalThis as any).AudioEncoder;
    const aenc = new AE({
      output: (chunk: any, meta: any) => muxer.addAudioChunk(chunk, meta),
      error: (e: unknown) => (failure = e),
    });
    aenc.configure(asel.config);
    const L = music.getChannelData(0), R = music.getChannelData(1);
    const STEP = 4800;
    for (let i = 0; i < music.length; i += STEP) {
      const n = Math.min(STEP, music.length - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0);
      data.set(R.subarray(i, i + n), n);
      const ad = new (globalThis as any).AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / SAMPLE_RATE) * 1e6), data });
      aenc.encode(ad);
      ad.close();
      if (aenc.encodeQueueSize > 20) await breathe();
    }
    await aenc.flush();
    aenc.close();
    if (failure) throw failure;
  }
  muxer.finalize();
  onProgress(1);
  return {
    data: target.buffer,
    thumb,
    mime: 'video/mp4',
    codec: `${vsel.mux.toUpperCase()} ${w}×${h} ${fps}fps${asel ? ' + ' + asel.mux.toUpperCase() : ' (no audio)'}`,
    seconds: comp.duration,
  };
}

async function snapshot(canvas: HTMLCanvasElement): Promise<ArrayBuffer | null> {
  const k = 480 / Math.max(canvas.width, canvas.height);
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * k); small.height = Math.round(canvas.height * k);
  const sc = small.getContext('2d')!;
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(canvas, 0, 0, small.width, small.height);
  const blob = await new Promise<Blob | null>((res) => small.toBlob(res, 'image/jpeg', 0.82));
  return blob ? blob.arrayBuffer() : null;
}
