// Knowledge / RAG pipeline: ingestion -> chunking -> embedding -> vector store -> retrieval -> ranking.
// Embeddings are computed locally (hashed word + bigram features, 512 dimensions) so the
// platform works with no external service; generation is done by the agent's model.
import { all, now, run, uid } from './db.ts';

const DIM = 512;
const STOP = new Set('a an and are as at be but by for from has have i if in into is it its of on or that the their then there these this to was were what when where which who will with you your we our not can do does how'.split(' '));

export const tokens = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % DIM;
}
export type Vec = Record<number, number>;
export function embed(text: string): Vec {
  const t = tokens(text);
  const v: Vec = {};
  const add = (f: string, w: number) => { const i = hash(f); v[i] = (v[i] ?? 0) + w; };
  t.forEach((tok, i) => { add(tok, 1); if (i) add(t[i - 1] + '_' + tok, 0.5); });
  let norm = 0;
  for (const k in v) { v[k] = Math.log1p(v[k]); norm += v[k] * v[k]; }
  norm = Math.sqrt(norm) || 1;
  for (const k in v) v[k] = +(v[k] / norm).toFixed(5);
  return v;
}
export function cosine(a: Vec, b: Vec): number {
  let s = 0;
  for (const k in a) if (b[k] !== undefined) s += a[k] * b[k];
  return s;
}

export function chunk(text: string, size = 900, overlap = 150): string[] {
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); };
  for (const p of paras) {
    if (p.length > size) {
      push(); cur = '';
      for (let i = 0; i < p.length; i += size - overlap) out.push(p.slice(i, i + size));
    } else if ((cur + '\n\n' + p).length > size) {
      push();
      cur = cur.slice(-overlap) + '\n\n' + p;
    } else cur = cur ? cur + '\n\n' + p : p;
  }
  push();
  return out;
}

/** Strip markup from HTML so web pages can be ingested as text. */
export function htmlToText(html: string): string {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').trim();
}

export function ingest(orgId: string, kbId: string, name: string, text: string, opts: { size?: number; overlap?: number } = {}) {
  const docId = uid('doc_');
  const parts = chunk(text, opts.size, opts.overlap);
  parts.forEach((t, i) => run('INSERT INTO chunks (id, org_id, kb_id, doc_id, doc_name, seq, text, vec, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    uid('ch_'), orgId, kbId, docId, name, i, t, JSON.stringify(embed(t)), now()));
  return { docId, chunks: parts.length, characters: text.length };
}

export interface Hit { docName: string; seq: number; text: string; score: number; vector: number; keyword: number }
export function search(orgId: string, kbIds: string[], query: string, k = 4): Hit[] {
  if (!kbIds.length || !query.trim()) return [];
  const qv = embed(query);
  const qt = new Set(tokens(query));
  const rows = all(`SELECT doc_name, seq, text, vec FROM chunks WHERE org_id = ? AND kb_id IN (${kbIds.map(() => '?').join(',')})`, orgId, ...kbIds);
  return rows.map((r) => {
    const vector = cosine(qv, JSON.parse(r.vec));
    const ct = new Set(tokens(r.text));
    const keyword = qt.size ? [...qt].filter((t) => ct.has(t)).length / qt.size : 0;
    return { docName: r.doc_name, seq: r.seq, text: r.text, vector, keyword, score: +(0.6 * vector + 0.4 * keyword).toFixed(4) }; // re-rank
  }).filter((h) => h.score > 0.05).sort((a, b) => b.score - a.score).slice(0, k);
}

/** Share of the answer's content words that also appear in the retrieved context (hallucination heuristic). */
export function groundedness(answer: string, context: string): number {
  const a = tokens(answer);
  if (!a.length) return 1;
  const c = new Set(tokens(context));
  return a.filter((t) => c.has(t)).length / a.length;
}
export function similarity(a: string, b: string): number { return cosine(embed(a), embed(b)); }
