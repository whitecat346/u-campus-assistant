// OpenAI 兼容 LLM 客户端（docs/DESIGN.md 决策 8）。脚本直连，不经服务端。
// 注意：答题页在 ucontent.unipus.cn，而 LLM 在第三方域 → 浏览器 fetch 会被 CORS 拦，
// 因此这里走 GM_xmlhttpRequest（脚本已申请该权限）；只有 localhost 才回退 fetch。
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

function isLocal(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
}

interface GmResponse {
  status: number;
  responseText: string;
}

function gmPost(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<GmResponse> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers,
      data: body,
      timeout: timeoutMs,
      onload: (r) => resolve({ status: r.status, responseText: r.responseText }),
      onerror: () => reject(new Error('LLM 网络错误（GM_xmlhttpRequest）')),
      ontimeout: () => reject(new Error('LLM 请求超时')),
      onabort: () => reject(new Error('LLM 请求被中断')),
    });
  });
}

export async function chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
  const { llm } = getSettings();
  if (!llm.enabled || !llm.baseURL || !llm.model) throw new LlmDisabledError();

  const url = joinUrl(llm.baseURL, '/chat/completions');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;
  const body = JSON.stringify({
    model: llm.model,
    messages,
    temperature: opts?.temperature ?? 0.3,
    max_tokens: opts?.maxTokens ?? 1200,
    stream: false,
  });

  let status: number;
  let text: string;
  if (isLocal(url)) {
    const res = await fetch(url, { method: 'POST', headers, body });
    status = res.status;
    text = await res.text();
  } else {
    const r = await gmPost(url, headers, body, 180000);
    status = r.status;
    text = r.responseText;
  }

  if (status < 200 || status >= 300) {
    throw new Error(`LLM ${status}: ${text.slice(0, 300)}`);
  }
  let json: { choices?: Array<{ message?: { content?: string } }> };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`LLM 返回非 JSON: ${text.slice(0, 200)}`);
  }
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('LLM 返回空内容');
  return content;
}

/** 只返回纯文本主体（去掉 ``` 围栏） */
export function stripFence(s: string): string {
  const m = s.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}
