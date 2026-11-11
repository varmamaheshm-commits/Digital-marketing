/**
 * Connection to the owner's own AI engine: an open-source language model served on
 * this same computer (Ollama-compatible API on the loopback address). Nothing is sent
 * to the internet — the only address ever contacted is this machine itself.
 */
const BASES = ['http://127.0.0.1:11434', 'http://localhost:11434'];
let base: string | null = null;

/** Names of the models installed on this PC, or null when no AI engine is running. */
export async function aiModels(): Promise<string[] | null> {
  for (const b of base ? [base] : BASES) {
    try {
      const res = await fetch(b + '/api/tags', { signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      const j = await res.json();
      base = b;
      return (j.models ?? []).map((m: any) => String(m.name)).filter(Boolean);
    } catch { /* try the next address */ }
  }
  base = null;
  return null;
}

/** Asks the local model for a JSON object. Throws when the engine is unreachable or the reply is not JSON. */
export async function aiJson(model: string, system: string, user: string): Promise<Record<string, unknown>> {
  if (!base && !(await aiModels())) throw new Error('The AI engine is not running on this computer.');
  const res = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model, stream: false, format: 'json', options: { temperature: 0.6 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`The AI engine answered with an error (${res.status}).`);
  const j = await res.json();
  const out = JSON.parse(String(j?.message?.content ?? ''));
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('The AI engine did not return a usable answer.');
  return out;
}
