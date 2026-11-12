// Claude adapter - official Anthropic SDK, manual tool loop driven by the agent runtime.
import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResult, ModelCfg, Msg } from './types.ts';

function toParams(messages: Msg[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic') out.push({ role: 'assistant', content: m.raw.content }); // keeps thinking blocks intact
      else {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        out.push({ role: 'assistant', content: blocks });
      }
    } else {
      // All results of one assistant turn go back in a single user message.
      const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId!, content: m.content, is_error: m.isError || undefined };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export async function claudeChat(cfg: ModelCfg, req: ChatRequest): Promise<ChatResult> {
  // Each organisation brings its own key; never fall through to credentials in the server's environment.
  if (!cfg.apiKey) throw new Error(`${cfg.name}: no API key secret is configured`);
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}), maxRetries: 1 });
  const tools: Anthropic.Tool[] = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema }));
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: cfg.modelId || 'claude-opus-5-5',
      max_tokens: 16000,
      system: req.system,
      messages: toParams(req.messages),
      ...(tools.length ? { tools } : {}),
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude: the API key was rejected');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude: rate limited');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude: API error ${e.status ?? ''} ${e.message}`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new Error(`Claude declined the request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`);
  let text = '';
  const toolCalls: ChatResult['toolCalls'] = [];
  for (const b of response.content) {
    if (b.type === 'text') text += b.text;
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, any> });
  }
  const u = response.usage;
  return {
    text, toolCalls,
    tokensIn: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    tokensOut: u.output_tokens,
    raw: { provider: 'anthropic', content: response.content },
  };
}
