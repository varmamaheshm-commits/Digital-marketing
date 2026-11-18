/**
 * Voice-over: each scene's words are spoken by the speech engine built into Windows,
 * through the desktop app (no outside service). Scenes are lengthened when the spoken
 * line needs more time, and the music is turned down underneath the voice.
 */
import type { ScriptScene, Settings, Video } from '../core/types';
import { envelopeFromAudio } from './presenter';
import { SAMPLE_RATE } from './music';

export interface VoiceBridge {
  speak: (text: string, opts: { lang: string; gender: 'female' | 'male' }) => Promise<{ ok: boolean; wav?: ArrayBuffer; error?: string }>;
  voices: () => Promise<{ ok: boolean; voices?: { name: string; culture: string; gender: string }[]; error?: string }>;
}
export const desktopVoice = (): VoiceBridge | undefined => (globalThis as any).desktop?.voice;

export interface SpokenScenes {
  script: ScriptScene[];
  clips: { start: number; buffer: AudioBuffer }[];
  envelope: Float32Array;
}

const LEAD_IN = 0.3; // seconds of silence before each line

/** What is said in each scene: the on-screen words, plus the supporting line where it adds meaning. */
export function lineFor(sc: ScriptScene): string {
  const sub = sc.sub && (sc.kind === 'reveal' || sc.kind === 'offer' || sc.kind === 'cta') ? sc.sub.replace(/\s*·\s*/g, ', ') : '';
  return [sc.text, sub].filter(Boolean).join('. ').replace(/[#*_]/g, '');
}

async function decode(wav: ArrayBuffer): Promise<AudioBuffer> {
  const Ctx: typeof OfflineAudioContext = (globalThis as any).OfflineAudioContext;
  return new Ctx(1, 1, SAMPLE_RATE).decodeAudioData(wav.slice(0));
}

/** Returns null when no speech engine is available, so the video is made without a voice. */
export async function speakScenes(video: Video, _s: Settings, bridge = desktopVoice()): Promise<SpokenScenes | null> {
  if (!bridge) return null;
  const gender = video.presenter === 'host-b' ? 'male' : 'female';
  const script = video.script.map((s) => ({ ...s }));
  const clips: SpokenScenes['clips'] = [];
  let start = 0;
  for (const sc of script) {
    const text = lineFor(sc);
    if (text) {
      try {
        const res = await bridge.speak(text, { lang: video.lang ?? 'en', gender });
        if (res.ok && res.wav && res.wav.byteLength > 100) {
          const buffer = await decode(res.wav);
          clips.push({ start: start + LEAD_IN, buffer });
          sc.seconds = Math.max(sc.seconds, Math.round((buffer.duration + LEAD_IN + 0.5) * 10) / 10);
        }
      } catch { /* this line stays silent */ }
    }
    start += sc.seconds;
  }
  if (!clips.length) return null;
  const envelope = envelopeFromAudio(clips.map((c) => ({ start: c.start, data: c.buffer.getChannelData(0), rate: c.buffer.sampleRate })), start);
  return { script, clips, envelope };
}

/** Music (if any) ducked under the voice clips. */
export async function mixAudio(music: AudioBuffer | null, clips: SpokenScenes['clips'], seconds: number): Promise<AudioBuffer | null> {
  if (!clips.length) return music;
  const Ctx: typeof OfflineAudioContext = (globalThis as any).OfflineAudioContext;
  const ac = new Ctx(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  if (music) {
    const src = ac.createBufferSource();
    src.buffer = music;
    const g = ac.createGain();
    g.gain.value = 0.28;
    src.connect(g).connect(ac.destination);
    src.start(0);
  }
  for (const c of clips) {
    const src = ac.createBufferSource();
    src.buffer = c.buffer;
    const g = ac.createGain();
    g.gain.value = 1.1;
    src.connect(g).connect(ac.destination);
    src.start(c.start);
  }
  return ac.startRendering();
}
