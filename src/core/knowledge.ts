/**
 * Private knowledge base with on-device retrieval (the "R" of RAG).
 * Documents are split into passages and ranked with BM25 — no outside service.
 * The best passages are used to draft answers to customer questions.
 */
import type { KnowledgeDoc, Settings } from './types';

export interface Passage {
  docId: string;
  title: string;
  text: string;
}
export interface Hit extends Passage {
  score: number;
}

const STOP = new Set('a an and are as at be but by do does for from has have how i in is it its me my of on or our that the this to was we what when where which who will with you your can'.split(' '));
export const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

/** Splits a document into passages of roughly one paragraph (at most ~450 characters). */
export function passages(doc: KnowledgeDoc): Passage[] {
  const out: Passage[] = [];
  for (const para of doc.text.split(/\n\s*\n|\r\n\s*\r\n/)) {
    let cur = '';
    for (const sentence of para.replace(/\s+/g, ' ').trim().split(/(?<=[.!?।])\s+/)) {
      if (cur && (cur + ' ' + sentence).length > 450) { out.push({ docId: doc.id, title: doc.title, text: cur }); cur = sentence; }
      else cur = cur ? cur + ' ' + sentence : sentence;
    }
    if (cur.trim()) out.push({ docId: doc.id, title: doc.title, text: cur.trim() });
  }
  return out;
}

export function search(docs: KnowledgeDoc[], query: string, limit = 3): Hit[] {
  const all = docs.flatMap(passages);
  const q = [...new Set(tokenize(query))];
  if (!all.length || !q.length) return [];
  const toks = all.map((p) => tokenize(p.title + ' ' + p.text));
  const avg = toks.reduce((a, t) => a + t.length, 0) / toks.length || 1;
  const k1 = 1.4, b = 0.75;
  const hits = all.map((p, i) => {
    let score = 0;
    for (const term of q) {
      const tf = toks[i].filter((t) => t === term || (term.length > 3 && t.startsWith(term))).length;
      if (!tf) continue;
      const df = toks.filter((t) => t.some((x) => x === term || (term.length > 3 && x.startsWith(term)))).length;
      const idf = Math.log(1 + (all.length - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * toks[i].length) / avg));
    }
    return { ...p, score };
  });
  return hits.filter((h) => h.score > 0).sort((a, b2) => b2.score - a.score).slice(0, limit);
}

/** A reply built only from the owner's own documents, ready to edit and send. */
export function draftAnswer(hits: Hit[], s: Settings, customer = ''): string {
  const hello = `Hi${customer ? ' ' + customer.trim().split(/\s+/)[0] : ''}, thank you for your question.`;
  if (!hits.length) return `${hello} Let me check this and get back to you shortly.\n\n— ${s.business.name || 'our team'}`;
  return `${hello}\n\n${hits.slice(0, 2).map((h) => h.text).join('\n\n')}\n\nPlease let me know if you need anything else.\n\n— ${s.business.name || 'our team'}${s.business.phone ? ', ' + s.business.phone : ''}`;
}
