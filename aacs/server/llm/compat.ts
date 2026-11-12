// Adapter for providers that expose the "chat completions" wire format:
// OpenAI, Azure OpenAI, Gemini, Mistral, DeepSeek, and Llama through Ollama or any compatible gateway.
import type { ChatRequest, ChatResult, ModelCfg } from './types.ts';

export const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
};

export async function compatChat(cfg: ModelCfg, req: ChatRequest): Promise<ChatResult> {
  const base = (cfg.baseUrl || DEFAULT_BASE[cfg.provider] || '').replace(/\/+$/, '');
  if (!base) throw new Error(`${cfg.name}: no base URL configured`);
  const messages: any[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else messages.push({ role: 'assistant', content: m.content || null,
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) });
  }
  const body: any = { model: cfg.modelId, messages };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) { headers.authorization = `Bearer ${cfg.apiKey}`; if (cfg.provider === 'azure_openai') headers['api-key'] = cfg.apiKey; }
  const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const textBody = await res.text();
  if (!res.ok) throw new Error(`${cfg.name}: HTTP ${res.status} ${textBody.slice(0, 300)}`);
  const json = JSON.parse(textBody);
  const msg = json.choices?.[0]?.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((c: any) => {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* malformed arguments -> empty input, the tool reports the error */ }
    return { id: c.id, name: c.function?.name, input };
  });
  return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls, tokensIn: json.usage?.prompt_tokens ?? 0, tokensOut: json.usage?.completion_tokens ?? 0 };
}
