/**
 * Royalty-free background music, synthesised on the device with the Web Audio API.
 * No audio files, no downloads: every track is generated from a seed.
 */
import { rng } from '../core/copy';
import type { MusicMood } from '../core/types';

export const SAMPLE_RATE = 48_000;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const CHORD: Record<string, number[]> = { I: [0, 4, 7], V: [-5, -1, 2], vi: [-3, 0, 4], IV: [-7, -3, 0], ii: [2, 5, 9] };
const SETUP = {
  upbeat: { bpm: 118, prog: ['I', 'V', 'vi', 'IV'] },
  chill: { bpm: 88, prog: ['I', 'vi', 'IV', 'V'] },
  cinematic: { bpm: 72, prog: ['vi', 'IV', 'I', 'V'] },
};

export async function synthMusic(mood: MusicMood, seconds: number, seed: number): Promise<AudioBuffer | null> {
  const Offline: typeof OfflineAudioContext | undefined = (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (mood === 'none' || !Offline) return null;
  const r = rng(seed);
  const ac = new Offline(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const { bpm, prog } = SETUP[mood];
  const beat = 60 / bpm;
  const bar = beat * 4;
  const root = 57 + Math.floor(r() * 6); // A3 … D4

  const master = ac.createGain();
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.85, 0.2);
  master.gain.setValueAtTime(0.85, Math.max(0.3, seconds - 1.1));
  master.gain.linearRampToValueAtTime(0, seconds);
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  master.connect(comp).connect(ac.destination);

  const padFilter = ac.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = mood === 'cinematic' ? 700 : mood === 'chill' ? 1100 : 1700;
  padFilter.connect(master);

  const noiseBuf = ac.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;

  const tone = (type: OscillatorType, freq: number, t: number, dur: number, gain: number, attack: number, dest: AudioNode, pan = 0, detune = 0) => {
    if (t >= seconds) return;
    const o = ac.createOscillator();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  };
  const kick = (t: number, gain: number) => {
    if (t >= seconds) return;
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.35);
  };
  const noise = (t: number, dur: number, gain: number, freq: number, type: BiquadFilterType) => {
    if (t >= seconds) return;
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(master);
    s.start(t, r() * 0.5, dur + 0.02);
  };

  const bars = Math.ceil(seconds / bar);
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const chord = CHORD[prog[b % prog.length]].map((n) => root + n);
    // pad: three slightly detuned voices per chord note
    for (const n of chord) {
      for (const d of [-7, 0, 7]) tone(mood === 'chill' ? 'triangle' : 'sawtooth', hz(n), t0, bar * 1.05, mood === 'upbeat' ? 0.035 : 0.05, bar * 0.25, padFilter, d / 10, d);
    }
    const bassNote = hz(chord[0] - 12);
    for (let step = 0; step < 8; step++) {
      const t = t0 + (step * beat) / 2;
      const onBeat = step % 2 === 0;
      if (mood === 'upbeat') {
        if (onBeat) kick(t, 0.8);
        else noise(t, 0.05, 0.14, 8000, 'highpass');
        if (step === 2 || step === 6) noise(t, 0.16, 0.22, 1800, 'bandpass');
        tone('sine', bassNote, t, beat * 0.45, 0.28, 0.01, master);
        tone('triangle', hz(chord[(step * 2 + b) % 3] + 12), t, beat * 0.4, 0.07, 0.005, master, step % 2 ? 0.4 : -0.4);
      } else if (mood === 'chill') {
        if (step === 0 || step === 5) kick(t, 0.55);
        if (step === 4) noise(t, 0.2, 0.1, 1500, 'bandpass');
        if (onBeat) noise(t, 0.04, 0.05, 9000, 'highpass');
        if (step === 0 || step === 3) tone('sine', bassNote, t, beat * 1.3, 0.3, 0.02, master);
        if (step % 3 === 1) tone('sine', hz(chord[step % 3] + 12), t, beat * 1.2, 0.07, 0.01, master, step % 2 ? 0.5 : -0.5);
      } else {
        if (step === 0) { kick(t, 0.7); tone('sine', bassNote / 2, t, bar, 0.3, 0.05, master); tone('sine', bassNote, t, bar, 0.16, 0.2, master); }
        if (step % 2 === 1) tone('sine', hz(chord[((step - 1) / 2) % 3] + 12), t, beat * 1.8, 0.05, 0.03, master, step % 4 === 1 ? 0.5 : -0.5);
        if (step === 7 && b % 2 === 1) noise(t, beat * 0.5, 0.05, 4000, 'highpass');
      }
    }
  }
  return ac.startRendering();
}
