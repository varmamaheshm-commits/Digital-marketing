/** Reads an uploaded recording: size, length, shape and a preview picture. Nothing leaves the device. */
import type { VideoFormat } from '../core/types';

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
/** File types every connected platform accepts. */
export const UPLOAD_TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime' };

export function uploadMime(file: { name: string; type: string }): string | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (UPLOAD_TYPES[ext]) return UPLOAD_TYPES[ext];
  if (file.type === 'video/mp4' || file.type === 'video/quicktime') return file.type;
  return null;
}

export function shapeOf(width: number, height: number): VideoFormat {
  const r = width / height;
  return r < 0.8 ? 'reel' : r > 1.25 ? 'wide' : 'square';
}

export interface VideoInfo {
  readable: boolean;
  width: number;
  height: number;
  seconds: number;
  thumb: ArrayBuffer | null;
}

const once = (el: HTMLMediaElement, ok: string, ms: number) =>
  new Promise<boolean>((resolve) => {
    const done = (v: boolean) => { clearTimeout(t); el.removeEventListener(ok, yes); el.removeEventListener('error', no); resolve(v); };
    const yes = () => done(true), no = () => done(false);
    const t = setTimeout(no, ms);
    el.addEventListener(ok, yes);
    el.addEventListener('error', no);
  });

/**
 * Some phone recordings (for example HEVC) cannot be previewed by this device even though the
 * platforms accept them; in that case `readable` is false and the owner picks the shape by hand.
 */
export async function inspectVideo(file: Blob): Promise<VideoInfo> {
  const none: VideoInfo = { readable: false, width: 0, height: 0, seconds: 0, thumb: null };
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  try {
    const loaded = once(v, 'loadeddata', 15000);
    v.src = url;
    if (!(await loaded) || !v.videoWidth) return none;
    const seconds = Number.isFinite(v.duration) ? v.duration : 0;
    const info: VideoInfo = { readable: true, width: v.videoWidth, height: v.videoHeight, seconds, thumb: null };
    const seeked = once(v, 'seeked', 8000);
    v.currentTime = Math.min(1, seconds / 2);
    if (await seeked) {
      const k = 480 / Math.max(v.videoWidth, v.videoHeight);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.82));
      info.thumb = blob ? await blob.arrayBuffer() : null;
    }
    return info;
  } catch {
    return none;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}
