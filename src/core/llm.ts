// OpenAI 兼容 LLM 客户端（docs/DESIGN.md 决策 8）。脚本直连，不经服务端。
// 注意：答题页在 ucontent.unipus.cn，而 LLM 在第三方域 → 浏览器 fetch 会被 CORS 拦，
// 因此这里走 GM_xmlhttpRequest（脚本已申请该权限）；只有 localhost 才回退 fetch。
import { getSettings } from './settings';
import { log } from './log';

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

interface ChatJson {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string; reasoning_content?: string; reasoning?: string };
  }>;
}

async function callOnce(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<{ json: ChatJson; text: string }> {
  const body = JSON.stringify(payload);
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
  try {
    return { json: JSON.parse(text) as ChatJson, text };
  } catch {
    throw new Error(`LLM 返回非 JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * 调一次对话补全。思考型模型（如 deepseek-flash 带 reasoning_content）会把 max_tokens
 * 预算先花在思考上，导致 content 为空（finish=length）。
 * 处理顺序：正常请求 → 带 `thinking:{type:'disabled'}` 重试（DeepSeek 3.2 系列认这个字段）
 * → 再加大预算 → 再两者兼顾。后端不认 thinking 字段时会 4xx，这里吞掉继续试。
 */
export async function chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
  const { llm } = getSettings();
  if (!llm.enabled || !llm.baseURL || !llm.model) throw new LlmDisabledError();

  const url = joinUrl(llm.baseURL, '/chat/completions');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;

  const baseBudget = Math.max(1200, opts?.maxTokens ?? 4000);
  const plans: Array<{ budget: number; thinkingOff: boolean }> = [
    { budget: baseBudget, thinkingOff: false },
    { budget: baseBudget, thinkingOff: true },
    { budget: Math.min(8192, baseBudget * 2), thinkingOff: true },
    { budget: Math.min(8192, baseBudget * 2), thinkingOff: false },
  ];

  let lastText = '';
  for (const plan of plans) {
    const payload: Record<string, unknown> = {
      model: llm.model,
      messages,
      temperature: opts?.temperature ?? 0.3,
      max_tokens: plan.budget,
      stream: false,
    };
    if (plan.thinkingOff) payload.thinking = { type: 'disabled' };

    let json: ChatJson;
    let text: string;
    try {
      ({ json, text } = await callOnce(url, headers, payload));
    } catch (e) {
      if (!plan.thinkingOff) throw e;
      log(`关闭思考的请求被拒（${(e as Error).message.slice(0, 120)}），退回普通请求`);
      continue;
    }
    lastText = text;
    const choice = json.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (content) return content;
    log(
      `LLM 未给出正文（finish=${choice?.finish_reason ?? '?'}, max_tokens=${plan.budget}, 思考=${plan.thinkingOff ? '关' : '开'}），换策略重试；响应前 200 字：${text.slice(0, 200)}`,
    );
  }
  throw new Error(`LLM 未返回正文（思考 token 可能占满预算；末次响应：${lastText.slice(0, 200)}）`);
}

/** 只返回纯文本主体（去掉 ``` 围栏） */
export function stripFence(s: string): string {
  const m = s.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}
