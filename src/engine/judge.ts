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
  '必须严格输出 JSON：{"letters":["A","C","B"],"confidence":0.0-1.0,"note":"简短理由"}',
  'letters 是按题目顺序排列的选项字母数组，**长度必须等于题目数量**，一个都不能省；不确定也要给一个。',
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

  const call = (extra: string) =>
    chat(
      [
        { role: 'system', content: SYS },
        { role: 'user', content: user + extra },
      ],
      { temperature: 0.1, maxTokens: 2400 },
    );

  let raw = await call('');
  let result = parseJudge(raw, input.questions.length);

  // 实测问题：模型偶尔少给几题（思考模型尤甚）→ 对缺的题再要一次，避免页面留空
  for (let round = 0; round < 2; round++) {
    const missing = input.questions.map((q) => q.index).filter((i) => !(i in result.answers));
    if (!missing.length) break;
    log(`判题缺少第 ${missing.map((i) => i + 1).join(',')} 题的答案，补问一次`);
    const askMissing = `\n\n上一次只给了部分答案，请补齐这些题：${missing.map((i) => i + 1).join(',')}，仍然只输出完整 JSON。`;
    raw = await call(askMissing);
    const more = parseJudge(raw, input.questions.length);
    result = {
      answers: { ...result.answers, ...more.answers },
      confidence: Math.min(result.confidence, more.confidence),
      note: more.note ?? result.note,
    };
  }

  return result;
}

export function parseJudge(raw: string, count: number): JudgeResult {
  const text = stripFence(raw);
  let obj: { answers?: Record<string, string>; letters?: unknown; confidence?: number; note?: string } | null = null;
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
  if (!obj) throw new Error(`LLM 输出无法解析：${text.slice(0, 200)}`);
  const answers: Record<number, string> = {};

  // 首选 letters 数组（实测「按题号给 map」时思考模型容易漏题）
  if (Array.isArray(obj.letters)) {
    obj.letters.forEach((v, i) => {
      const letter = String(v).trim().toUpperCase().slice(0, 1);
      if (i < count && letter >= 'A' && letter <= 'Z') answers[i] = letter;
    });
  }
  if (obj.answers && typeof obj.answers === 'object') {
    for (const [k, v] of Object.entries(obj.answers)) {
      const idx = Number(k.replace(/\D/g, ''));
      const i = Number.isFinite(idx) && idx >= 1 && idx <= count ? idx - 1 : Number(k);
      const letter = String(v).trim().toUpperCase().slice(0, 1);
      if (letter >= 'A' && letter <= 'Z' && !(i in answers)) answers[i] = letter;
    }
  }
  if (!Object.keys(answers).length) throw new Error(`LLM 未给出任何答案：${text.slice(0, 200)}`);
  return { answers, confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5, note: obj.note };
}

/* --------------------------- 听力填空（cloze）判题 --------------------------- */

export interface BlankJudgeResult {
  words: string[];
  confidence: number;
  note?: string;
}

const BLANK_SYS = [
  '你是英语听力填空助手。给定听力原文和若干带编号空格的句子，请用原文里出现的词/短语填空。',
  '要求：每空只填原文中真实出现的词（1–4 个词），保持原形，不加标点；空格处应为原文对应位置的词。',
  '必须严格输出 JSON：{"words":["词1","词2"],"confidence":0.0-1.0,"note":"简短理由"}',
  'words 按空位编号顺序排列，**长度必须等于空位数量**，一个都不能省。',
].join('\n');

export async function judgeBlanks(input: {
  transcript?: string;
  audioUrl?: string | null;
  sentences: Array<{ index: number; sentence: string }>;
}): Promise<BlankJudgeResult> {
  const { text: transcript } = await resolveTranscript({ transcript: input.transcript, audioUrl: input.audioUrl, questions: [] });
  const block = input.sentences.map((s) => `${s.index}) ${s.sentence}`).join('\n');
  const user = [
    transcript ? `听力原文：\n${transcript}` : '注意：没有可用原文，只能按句子语义与常见表达推断。',
    `需要填空的句子（空位用 N) 标出）：\n${block}`,
    `共 ${input.sentences.length} 个空，只输出 JSON。`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const call = (extra: string) =>
    chat(
      [
        { role: 'system', content: BLANK_SYS },
        { role: 'user', content: user + extra },
      ],
      { temperature: 0.1, maxTokens: 2400 },
    );

  let raw = await call('');
  let result = parseBlanks(raw, input.sentences.length);
  for (let round = 0; round < 2; round++) {
    const missing = input.sentences.map((_, i) => i).filter((i) => !result.words[i]);
    if (!missing.length) break;
    log(`填空缺少第 ${missing.map((i) => i + 1).join(',')} 空，补问一次`);
    raw = await call(`\n\n上一次少了这些空位：${missing.map((i) => i + 1).join(',')}，请补齐，仍然只输出完整 JSON。`);
    const more = parseBlanks(raw, input.sentences.length);
    result = {
      words: result.words.map((w, i) => w || more.words[i] || ''),
      confidence: Math.min(result.confidence, more.confidence),
      note: more.note ?? result.note,
    };
  }
  return result;
}

export function parseBlanks(raw: string, count: number): BlankJudgeResult {
  const text = stripFence(raw);
  let obj: { words?: unknown; confidence?: number; note?: string } | null = null;
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
  if (!obj) throw new Error(`LLM 输出无法解析：${text.slice(0, 200)}`);
  const words: string[] = new Array(count).fill('');
  if (Array.isArray(obj.words)) {
    obj.words.forEach((v, i) => {
      if (i < count) words[i] = String(v ?? '').trim();
    });
  } else if (obj.words && typeof obj.words === 'object') {
    for (const [k, v] of Object.entries(obj.words as Record<string, unknown>)) {
      const idx = Number(k.replace(/\D/g, ''));
      if (Number.isFinite(idx) && idx >= 1 && idx <= count) words[idx - 1] = String(v ?? '').trim();
    }
  }
  if (!words.some(Boolean)) throw new Error(`LLM 未给出任何填空答案：${text.slice(0, 200)}`);
  return { words, confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5, note: obj.note };
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
