// OpenAI 兼容 LLM 客户端（docs/DESIGN.md 决策 8）。脚本直连，不经服务端。
import { getSettings } from './settings';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmDisabledError extends Error {
  constructor() {
    super('LLM 未配置（设置页填写 baseURL / model / apiKey 后启用）');
    this.name = 'LlmDisabledError';
  }
}

function joinUrl(baseURL: string, path: string): string {
  return baseURL.replace(/\/+$/, '') + path;
}

export async function chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<string> {
  const { llm } = getSettings();
  if (!llm.enabled || !llm.baseURL || !llm.model) throw new LlmDisabledError();

  const res = await fetch(joinUrl(llm.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: llm.model,
      messages,
      temperature: opts?.temperature ?? 0.3,
      max_tokens: opts?.maxTokens ?? 1200,
      stream: false,
    }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM 返回空内容');
  return text;
}

/** 只返回纯文本主体（去掉 ``` 围栏） */
export function stripFence(s: string): string {
  const m = s.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}
