/** Saving and sharing files on every platform (desktop, browser, Android app). */
import { Capacitor } from '@capacitor/core';
import { toB64 } from './crypto';

export const isNativeApp = () => Capacitor.isNativePlatform();

const safeName = (n: string) => n.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 80) || 'file';

async function nativeShare(blob: Blob, name: string, text?: string) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const path = `share/${name}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 3 * 256 * 1024; // multiple of 3 so base64 pieces join cleanly
  await Filesystem.writeFile({ path, directory: Directory.Cache, data: toB64(bytes.subarray(0, CHUNK)), recursive: true });
  for (let i = CHUNK; i < bytes.length; i += CHUNK) {
    await Filesystem.appendFile({ path, directory: Directory.Cache, data: toB64(bytes.subarray(i, i + CHUNK)) });
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: name, text, files: [uri] });
}

/** Saves to disk (desktop/browser) or opens the system share sheet (phone/tablet). */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  const name = safeName(filename);
  if (isNativeApp()) return nativeShare(blob, name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles(): boolean {
  if (isNativeApp()) return true;
  try {
    return !!navigator.canShare?.({ files: [new File([''], 'a.mp4', { type: 'video/mp4' })] });
  } catch {
    return false;
  }
}

/** Hands the file to the phone's share sheet (Instagram, YouTube, WhatsApp … chosen by the owner). */
export async function shareFile(blob: Blob, filename: string, text?: string): Promise<void> {
  const name = safeName(filename);
  if (isNativeApp()) return nativeShare(blob, name, text);
  const file = new File([blob], name, { type: blob.type });
  try {
    await navigator.share({ files: [file], text });
  } catch (e: any) {
    if (e?.name !== 'AbortError') throw e;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Photos are re-encoded on import: strips EXIF/GPS metadata and caps the size. */
export async function importPhoto(file: Blob, maxSide = 2400): Promise<ArrayBuffer> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.92));
  if (!out) throw new Error('Could not read this image.');
  return out.arrayBuffer();
}
