// SenseVoice 服务端客户端（docs/DESIGN.md §6 + 决策 7）。
// 双通道：优先把音频 URL 交给服务端下载；失败回退浏览器侧抓取后上传。
import { getSettings } from './settings';

export interface AsrResult {
  text: string;
  lang?: string;
  emotion?: string;
  events?: string;
  duration_ms?: number;
}

function base(): string {
  return getSettings().asr.baseURL.replace(/\/+$/, '');
}

export async function health(): Promise<{ status: string; model: string; device: string }> {
  const res = await fetch(`${base()}/health`);
  if (!res.ok) throw new Error(`ASR /health ${res.status}`);
  return res.json();
}

/** 通道 1：服务端下载解码 */
export async function recognizeUrl(url: string, headers?: Record<string, string>): Promise<AsrResult> {
  const res = await fetch(`${base()}/asr/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, headers }),
  });
  const json = (await res.json()) as AsrResult & { error?: { message?: string } };
  if (!res.ok || json.error) throw new Error(`ASR /asr/url 失败: ${json.error?.message ?? res.status}`);
  return json;
}

/** 通道 2：浏览器侧拿到音频字节后上传（回退路径） */
export async function recognizeBlob(blob: Blob, filename = 'audio.bin'): Promise<AsrResult> {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await fetch(`${base()}/asr`, { method: 'POST', body: form });
  const json = (await res.json()) as AsrResult & { error?: { message?: string } };
  if (!res.ok || json.error) throw new Error(`ASR /asr 失败: ${json.error?.message ?? res.status}`);
  return json;
}

/** 跨域下载音频（绕 CORS），返回 Blob；失败抛错由调用方回退到录制 */
export function fetchAudioBlob(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'blob',
      timeout: 60000,
      onload: (r) => {
        if (r.status >= 200 && r.status < 300) resolve(r.response as Blob);
        else reject(new Error(`音频下载 ${r.status}`));
      },
      onerror: () => reject(new Error('音频下载网络错误')),
      ontimeout: () => reject(new Error('音频下载超时')),
    });
  });
}
