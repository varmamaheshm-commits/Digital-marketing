import { describe, expect, it } from 'vitest';
import { applyReference, colorsFrom, describeReference, findCuts, paletteFrom, retime, shotLengths, styleFor, targetFor } from '../src/video/reference';
import { buildComp } from '../src/video/draw';
import type { ReferenceLook, ScriptScene, Video } from '../src/core/types';

const look = (over: Partial<ReferenceLook> = {}): ReferenceLook => ({
  name: 'ad.mp4', seconds: 15, format: 'reel', shots: [1, 1, 1.5, 1, 2, 1.5, 3, 4], palette: ['#101010', '#e11d48', '#f5f5f5', '#2563eb'],
  brightness: 0.5, saturation: 0.5, motion: 0.03, ...over,
});

const script: ScriptScene[] = [
  { kind: 'hook', text: 'Fresh mangoes', seconds: 3 },
  { kind: 'reveal', text: 'Straight from the farm', seconds: 4 },
  { kind: 'feature', text: 'Sweet', seconds: 4 },
  { kind: 'offer', text: '10% off', seconds: 4 },
  { kind: 'cta', text: 'Order now', seconds: 5 },
];
const sum = (s: ScriptScene[]) => Math.round(s.reduce((a, b) => a + b.seconds, 0) * 10) / 10;

describe('reading a reference video', () => {
  it('finds hard cuts but not ordinary movement', () => {
    const diffs = [0.02, 0.03, 0.02, 0.6, 0.03, 0.02, 0.04, 0.55, 0.02, 0.03];
    expect(findCuts(diffs, 0.5)).toEqual([2, 4]);
    expect(findCuts([0.02, 0.03, 0.025, 0.02], 0.5)).toEqual([]);
    expect(findCuts([], 0.5)).toEqual([]);
  });
  it('ignores a second jump within 0.4 seconds of a cut (a flash, not a new shot)', () => {
    expect(findCuts([0.02, 0.7, 0.7, 0.02, 0.02, 0.02, 0.02, 0.02], 0.2)).toEqual([0.4]);
  });
  it('turns cuts into shot lengths that add up to the video', () => {
    expect(shotLengths([2, 4], 10)).toEqual([2, 2, 6]);
    expect(shotLengths([], 8)).toEqual([8]);
    expect(shotLengths([3, 3.1], 6)).toEqual([3.1, 2.9]); // a 0.1 s sliver joins the shot before
  });
  it('picks the most common distinct colours', () => {
    const px: number[] = [];
    for (let i = 0; i < 70; i++) px.push(220, 30, 60, 255);
    for (let i = 0; i < 25; i++) px.push(20, 40, 200, 255);
    for (let i = 0; i < 5; i++) px.push(222, 32, 61, 255); // same red, must not repeat
    for (let i = 0; i < 9; i++) px.push(0, 0, 0, 0); // transparent, ignored
    expect(paletteFrom(px)).toEqual(['#dc1e3c', '#1428c8']);
    expect(paletteFrom([])).toEqual([]);
  });
});

describe('making a video in the reference style', () => {
  it('chooses a look and music from pace and colour', () => {
    expect(styleFor(look())).toEqual({ style: 'bold', mood: 'chill' }); // vivid, steady 1.9 s shots
    expect(styleFor(look({ shots: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }))).toEqual({ style: 'bold', mood: 'upbeat' });
    expect(styleFor(look({ brightness: 0.25, saturation: 0.2, shots: [6, 7], seconds: 13, motion: 0.01 }))).toEqual({ style: 'luxe', mood: 'cinematic' });
    expect(styleFor(look({ brightness: 0.6, saturation: 0.3, shots: [3, 3, 3], seconds: 9, motion: 0.02 }))).toEqual({ style: 'clean', mood: 'chill' });
  });
  it('takes vivid colours that text can sit on, or none from a grey video', () => {
    expect(colorsFrom(look().palette)).toEqual({ primary: '#e11d48', accent: '#2563eb' });
    expect(colorsFrom(['#111111', '#eeeeee', '#808080'])).toBeNull();
  });
  it('keeps the new video between 10 and 30 seconds', () => {
    expect(targetFor(look({ seconds: 4 }))).toBe(10);
    expect(targetFor(look({ seconds: 17.4 }))).toBe(17);
    expect(targetFor(look({ seconds: 95 }))).toBe(30);
  });
  it('follows the reference rhythm while keeping every scene readable and the total length exact', () => {
    const out = retime(script, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 4, 4, 4, 4], 20);
    expect(sum(out)).toBe(20);
    expect(out[0].seconds).toBeLessThan(out[3].seconds); // fast start, slow end, like the reference
    out.forEach((sc) => expect(sc.seconds).toBeGreaterThanOrEqual(sc.kind === 'cta' ? 2 : 1.2));
    expect(out.map((s) => s.text)).toEqual(script.map((s) => s.text));
    const even = retime(script, [15], 20); // a single long shot: scenes share the time evenly
    expect(sum(even)).toBe(20);
  });
  it('builds a video that keeps the reference and draws with its colours', () => {
    const base = { id: 'v1', productId: 'p1', format: 'reel', style: 'clean', mood: 'chill', seed: 1, script, caption: '', hashtags: [], title: 'x', status: 'queued', createdAt: 0 } as Video;
    const v = applyReference(base, look(), { useColors: true });
    expect(v).toMatchObject({ style: 'bold', mood: 'chill', colors: { primary: '#e11d48', accent: '#2563eb' }, reference: { name: 'ad.mp4' } });
    expect(sum(v.script)).toBe(sum(script));
    expect(applyReference(base, look(), { useColors: false, style: 'luxe' })).toMatchObject({ style: 'luxe', colors: undefined });
    const s = { brand: { primary: '#000000', accent: '#ffffff' }, business: { name: 'Shop' } } as any;
    const comp = buildComp(v, [], s);
    expect([comp.primary, comp.accent]).toEqual(['#e11d48', '#2563eb']);
    expect(buildComp(base, [], s).primary).toBe('#000000');
  });
  it('describes the reference in plain words', () => {
    expect(describeReference(look())).toBe('15 seconds, 8 shots (steady cuts), medium-bright, vivid colours');
  });
});
