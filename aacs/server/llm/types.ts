export interface ToolDef { name: string; description: string; schema: Record<string, any> }
export interface ToolCall { id: string; name: string; input: Record<string, any> }
/** Provider-neutral conversation message. `raw` keeps the provider's own assistant payload so it can be replayed unchanged. */
export interface Msg { role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolCallId?: string; isError?: boolean; raw?: { provider: string; content: any } }
export interface ChatRequest { system: string; messages: Msg[]; tools?: ToolDef[] }
export interface ChatResult { text: string; toolCalls: ToolCall[]; tokensIn: number; tokensOut: number; raw?: Msg['raw'] }
export interface ModelCfg { name: string; provider: string; modelId: string; baseUrl?: string; apiKey?: string; inCost: number; outCost: number }
