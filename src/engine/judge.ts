// 客观题判题（docs/DESIGN.md 决策 5 + 本轮实测补充）：
//  * 接口**不下发**正确答案（`answers: []`）→ 必须自己判（LLM）。
//  * 听力原文随内容下发 → 优先用原文（决策 2026-11-26：双路，原文优先、缺失回退 ASR）。
import { chat, stripFence } from '../core/llm';
import { recognizeUrl } from '../core/asr';
import { getSettings } from '../core/settings';
import { log } from '../core/log';
import type { Question } from '../page/questions';

export interface JudgeInput {
  direction?: string;
  transcript?: string;
  audioUrl?: string | null;
  questions: Question[];
}

export interface JudgeResult {
  answers: Record<number, string>;
  confidence: number;
  note?: string;
}

const SYS = [
  '你是英语听力题的答题助手。根据听力原文与题干、选项，为每题选出唯一正确答案。',
  '要求：只依据原文信息作答；原文没有直接证据时按最可能选项判断并把 confidence 降低。',
  '必须严格输出 JSON：{"answers":{"0":"A","1":"C"},"confidence":0.0-1.0,"note":"简短理由"}',
  'answers 的键是题目的 0 基序号（与输入顺序一致），值是选项字母（大写）。',
].join('\n');

export async function resolveTranscript(input: JudgeInput): Promise<{ text: string; source: 'page' | 'asr' | 'none' }> {
  if (input.transcript && input.transcript.trim().length > 40) return { text: input.transcript.trim(), source: 'page' };
  if (!input.audioUrl) return { text: '', source: 'none' };
  if (!getSettings().asr.baseURL) return { text: '', source: 'none' };
  try {
    log('原文缺失，回退 SenseVoice 识别…');
    const r = await recognizeUrl(input.audioUrl);
    const text = (r.text || '').replace(/<\|[^|]*\|>/g, '').trim();
    if (text.length > 20) return { text, source: 'asr' };
  } catch (e) {
    log(`ASR 失败，改用纯选项推断：${(e as Error).message}`);
  }
  return { text: '', source: 'none' };
}

export async function judgeObjective(input: JudgeInput): Promise<JudgeResult> {
  const { text: transcript, source } = await resolveTranscript(input);
  const qBlock = input.questions
    .map((q) => {
      const opts = q.options.map((o) => `${o.caption}. ${o.label}`).join('\n');
      return `Q${q.index + 1}. ${q.stem}\n${opts}`;
    })
    .join('\n\n');

  const user = [
    input.direction ? `题目要求：${input.direction}` : '',
    transcript ? `听力原文（来源：${source === 'asr' ? '语音识别' : '页面下发'}）：\n${transcript}` : '注意：没有可用原文，请仅凭题干与选项的语义常识判断。',
    `题目：\n${qBlock}`,
    '只输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const raw = await chat(
    [
      { role: 'system', content: SYS },
      { role: 'user', content: user },
    ],
    { temperature: 0.1, maxTokens: 2400 },
  );

  return parseJudge(raw, input.questions.length);
}

export function parseJudge(raw: string, count: number): JudgeResult {
  const text = stripFence(raw);
  let obj: { answers?: Record<string, string>; confidence?: number; note?: string } | null = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
  }
  if (!obj?.answers) throw new Error(`LLM 输出无法解析：${text.slice(0, 200)}`);
  const answers: Record<number, string> = {};
  for (const [k, v] of Object.entries(obj.answers)) {
    const idx = Number(k.replace(/\D/g, ''));
    const i = Number.isFinite(idx) && idx >= 1 && idx <= count ? idx - 1 : Number(k);
    const letter = String(v).trim().toUpperCase().slice(0, 1);
    if (letter >= 'A' && letter <= 'Z') answers[i] = letter;
  }
  return { answers, confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5, note: obj.note };
}

/* ------------------------------ 说：短稿生成 ------------------------------ */

const SPEAK_SYS = [
  '你帮学生准备英语口语题的发言稿。要求：',
  '1) 直接给出可朗读书面稿，不要解释、不要项目符号；',
  '2) 长度控制在 60–90 秒口语量（约 90–140 词）；',
  '3) 语言自然、口语化，用简单句，适用于中国大学英语课堂；',
  '4) 内容紧扣题目要求与页面给出的提示要点。',
].join('\n');

export async function draftSpeakingScript(promptText: string, targetSec = 75): Promise<string> {
  const words = Math.round((targetSec / 60) * 110);
  const raw = await chat(
    [
      { role: 'system', content: SPEAK_SYS },
      {
        role: 'user',
        content: `目标时长约 ${targetSec} 秒（约 ${words} 词）。题目与提示如下：\n${promptText.slice(0, 4000)}\n\n只输出英文稿正文。`,
      },
    ],
    { temperature: 0.6, maxTokens: 2400 },
  );
  return stripFence(raw).replace(/^["']|["']$/g, '').trim();
}
