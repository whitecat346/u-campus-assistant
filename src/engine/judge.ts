// 客观题判题（docs/DESIGN.md 决策 5 + 本轮实测补充）：
//  * 接口**不下发**正确答案（`answers: []`）→ 必须自己判（LLM）。
//  * 听力原文随内容下发 → 优先用原文（决策 2026-11-26：双路，原文优先、缺失回退 ASR）。
import { chat, stripFence } from '../core/llm';
import { recognizeUrl } from '../core/asr';
import { getSettings } from '../core/settings';
import { log } from '../core/log';
import type { Question } from '../page/questions';
import type { ExamQuestion } from '../page/exam';

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
  '你是一位英语听力命题专家，正在替中国大学生做「大学英语听说」课的选择题。',
  '作答方法：',
  '1) 先通读听力原文，把与题干相关的句子逐句对照四个选项；',
  '2) 正确项必须能在原文找到直接依据（同义改写也算），与原文矛盾或原文未提及的选项一律排除；',
  '3) 涉及数字、时间、地点、原因、态度时，务必回原文核对，不要凭常识脑补；',
  '4) 原文来自语音识别时可能有错词，请按上下文纠正后再判断。',
  '题干或选项里用方括号包起来的片段（如 [ea] ）是页面上划线/加粗强调的部分，通常是发音题要你对比读音的位置。',
  '遇到发音题（选与划线部分读音相同的单词）：只按音标规则判断，先写出划线部分的音标，再逐个比对选项单词里相同位置/相同字母组合的读音，不要展开长篇讨论。',
  '没有原文时，只能依据题干与选项的语义常识选最合理的一项，并把 confidence 压到 0.4 以下。',
  '必须严格输出 JSON：{"letters":["A","C","B"],"confidence":0.0-1.0,"note":"简短理由"}',
  'letters 是按题目顺序排列的选项字母数组，长度必须等于题目数量，一个都不能省；不确定也要给一个。不要输出任何多余文字。',
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
  '你是一位英语听力填空专家，正在替中国大学生填「听录音补全句子」的空。',
  '作答方法：',
  '1) 先按空位编号在听力原文里定位对应位置，再抄出原文中的那个词或短语；',
  '2) 每空只填 1–4 个词，保持原文的词形（含单复数、时态、连字符），不加标点、不加引号、不改写；',
  '3) 若原文中找不到确切位置，就按句子语法与语义给出最可能的原文式表达，并把 confidence 压低；',
  '4) 空位顺序与句子里的编号一致，不要跳号、不要重复填同一空。',
  '必须严格输出 JSON：{"words":["词1","词2"],"confidence":0.0-1.0,"note":"简短理由"}',
  'words 按空位编号顺序排列，长度必须等于空位数量，一个都不能省。不要输出任何多余文字。',
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

/** 说类任务的三种形态（由 base 决定）+ 写作 */
export type ScriptMode = 'speech' | 'readaloud' | 'dialogue' | 'essay';

const SPEECH_SYS = [
  '场景：中国大学英语听说课的课堂口语环节。老师抛出问题，学生当场口头回答，说完就结束，不是演讲、不是讲故事、不是写作文。',
  '写作要求：',
  '1) 开门见山直接回应问题本身：第一句就给出你的观点/答案（例如 "Personally, social media does affect my sleep."），不要用叙事开场，不要描述"昨晚我室友给我看了一张图"这类小故事；',
  '2) 每个理由只给一句解释 + 最多一句简短例证（可以提自己的情况，但一句话带过，不许展开成情节）；',
  '3) 用课堂口语常见的连接词（First / Besides / For example / So），句子短，允许缩写（I\'ve、don\'t），四级词汇水平；',
  '4) 如果题目里有多个分问（1. 2. 3. 或两三个问句），必须逐条回答、顺序与题号一致：每条独立成段，段首用 "First," / "As for the second question," / "Finally," 这类提示语，让听者知道你换到下一个问题了；不许把所有分问揉成一段故事；',
  '5) 结尾一句话收住（可以是态度或建议），不要 "Thank you for listening"；',
  '6) 只有段落，不要标题、不要序号、不要项目符号、不要括号注释、不要 markdown；总长度不超过后端给的词数。',
  '只输出英文正文，不要任何解释。',
].join('\n');

/** 从页面文本里抽出「1. xxx / 2. xxx」形式的分问（说类题常常是 2–3 小问） */
export function extractSubQuestions(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:\d{1,2}[.)、]|Q\d+[.:)])\s*([^\n]{6,300})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const q = m[1].replace(/\s+/g, ' ').trim();
    if (q && !/^[\d\s.)、]*$/.test(q)) out.push(q);
    if (out.length >= 8) break;
  }
  return out;
}

const READALOUD_SYS = [
  '你是英语朗读任务助手。题目给出一段英文材料（句子或短文），学生需要跟着朗读。',
  '要求：',
  '1) 把材料整理成可直接朗读的稿子：保留原句措辞，去掉题号、"Read aloud" 之类的说明、括号提示和中文注释；',
  '2) 一句一行，标点补全，不要改写、不要翻译、不要加自己的话；',
  '3) 如果材料本身不完整，只按能读出来的部分整理，不要编造。',
  '只输出英文正文，不要任何解释。',
].join('\n');

const DIALOGUE_SYS = [
  '你是英语口语对话教练。题目是两人角色扮演（role-play），学生只负责其中一方。',
  '要求：',
  '1) 输出 A / B 两人的对话稿，每行以 "A: " 或 "B: " 开头，共 6–10 行；',
  '2) 覆盖题目要求的全部要点，用自然的日常口语，句子短，可以有重复和语气词；',
  '3) 学生要念的那一方（通常是角色 A，若题目另有说明按题目）台词要更完整、能独立成段；',
  '4) 不要标题、不要说明、不要 markdown。',
  '只输出英文对话。',
].join('\n');

const ESSAY_SYS = [
  '你是英语写作辅导老师，替一名非英语专业的大一学生完成课程里的书面写作/简答题。',
  '写作要求：',
  '1) 先直接回应题目要求（立场/做法/观点），不要复述题目；',
  '2) 主体 2 段：每段一个要点，配一个具体例子或细节；',
  '3) 结尾一句结论，不写 "In conclusion" 之类套话也可以，但要有收束；',
  '4) 语言按四级水平，语法正确、句子清楚，避免生僻词；',
  '5) 只有段落，不要标题、序号、项目符号、markdown；长度 120–180 词。',
  '只输出英文正文，不要任何解释。',
].join('\n');

export async function draftSpeakingScript(promptText: string, targetSec = 75, mode: ScriptMode = 'speech'): Promise<string> {
  const words = Math.round((targetSec / 60) * 110);
  const sys = mode === 'readaloud' ? READALOUD_SYS : mode === 'dialogue' ? DIALOGUE_SYS : mode === 'essay' ? ESSAY_SYS : SPEECH_SYS;
  const subs = mode === 'speech' ? extractSubQuestions(promptText) : [];
  const subHint =
    subs.length >= 2
      ? `\n\n页面上的分问共 ${subs.length} 条（必须逐条回答、顺序一致、每问一段）：\n${subs
          .map((q, i) => `${i + 1}) ${q}`)
          .join('\n')}\n输出必须是 ${subs.length} 段，每段回答一个分问。`
      : '';
  const ask =
    mode === 'readaloud'
      ? `下面是页面给出的朗读材料：\n${promptText.slice(0, 4000)}\n\n请输出可直接朗读的英文稿。`
      : mode === 'dialogue'
        ? `下面是题目要求：\n${promptText.slice(0, 4000)}\n\n请输出 A / B 对话稿。`
        : mode === 'essay'
          ? `题目要求与提示如下：\n${promptText.slice(0, 4000)}\n\n写一段 120–180 词的书面英语。只输出英文正文。`
          : `课堂问题如下：\n${promptText.slice(0, 4000)}${subHint}\n\n请以学生当堂回答的口吻作答，总长度不超过 ${words} 词。只输出英文回答正文。`;
  if (subs.length >= 2) log(`说类题目识别到 ${subs.length} 个分问，要求逐条回答`);
  const raw = await chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: ask },
    ],
    { temperature: 0.5, maxTokens: 2400 },
  );
  return stripFence(raw)
    .replace(/^["']|["']$/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/* --------------------------- 考试（uexercise）判题 --------------------------- */

const EXAM_SYS = [
  '你是一位英语听力命题专家，正在替中国大学生做「大学英语听说」的期末考试听力选择题。',
  '这段录音里会先朗读材料，再逐题朗读题干与四个选项；页面只给出选项文字，题干只在录音里。',
  '作答方法：',
  '1) 先把录音里听到的每道题的题干找出来（第 1 题、第 2 题……按出现顺序），再对照选项；',
  '2) 正确项必须能在材料原文或题干本身找到依据；与原文矛盾、原文未提及的选项一律排除；',
  '3) 数字、时间、地点、原因、态度务必回原文核对，不要凭常识脑补；',
  '4) 原文来自语音识别，可能有错词与人名错误，请按上下文纠正后再判断。',
  '必须严格输出 JSON：{"letters":["A","C","B"],"confidence":0.0-1.0,"note":"简短理由"}',
  'letters 按题目顺序排列，长度必须等于题目数量，一个都不能省；不确定也要给一个。不要输出任何多余文字。',
].join('\n');

export interface ExamJudgeResult {
  /** 题号（卷面 1 基）→ 选项字母 */
  answers: Record<number, string>;
  confidence: number;
  note?: string;
}

export function parseExamJudge(raw: string, questions: ExamQuestion[]): ExamJudgeResult {
  const text = stripFence(raw);
  let obj: { letters?: unknown; answers?: Record<string, string>; confidence?: number; note?: string } | null = null;
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

  const norm = (v: unknown): string => {
    const s = String(v ?? '').trim().toUpperCase();
    return /^[A-Z]$/.test(s) ? s : '';
  };
  const answers: Record<number, string> = {};

  if (Array.isArray(obj.letters)) {
    obj.letters.forEach((v, i) => {
      const q = questions[i];
      const letter = norm(v);
      if (q && letter) answers[q.num] = letter;
    });
  }
  if (obj.answers && typeof obj.answers === 'object') {
    for (const [k, v] of Object.entries(obj.answers)) {
      const n = Number(String(k).replace(/\D/g, ''));
      const q = questions.find((x) => x.num === n) ?? questions[n - 1];
      const letter = norm(v);
      if (q && letter && !(q.num in answers)) answers[q.num] = letter;
    }
  }
  const confidence = Math.min(1, Math.max(0, Number(obj.confidence ?? 0.6) || 0.6));
  if (!Object.keys(answers).length) throw new Error(`LLM 未给出任何答案：${text.slice(0, 200)}`);
  return { answers, confidence, note: obj.note };
}

/**
 * 一段材料（一个音频 + 2~4 题）判题：原文来自 ASR（录音里含朗读出来的题干）。
 * 缺题会补问最多 2 轮，与课程内判题一致。
 */
export async function judgeExamSet(input: {
  transcript: string;
  part?: string;
  questions: ExamQuestion[];
}): Promise<ExamJudgeResult> {
  const qBlock = input.questions
    .map((q) => {
      const opts = q.options.map((o) => `${o.letter}. ${o.text}`).join('\n');
      return `第${q.num}题\n${opts}`;
    })
    .join('\n\n');

  const user = [
    input.part ? `本段材料：${input.part}` : '',
    `录音转写（含朗读出来的题干，可能有识别错词）：\n${input.transcript.slice(0, 6000)}`,
    `题目选项：\n${qBlock}`,
    '只输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const call = (extra: string) =>
    chat(
      [
        { role: 'system', content: EXAM_SYS },
        { role: 'user', content: user + extra },
      ],
      { temperature: 0.1, maxTokens: 2400 },
    );

  let raw = await call('');
  let result = parseExamJudge(raw, input.questions);

  for (let round = 0; round < 2; round++) {
    const missing = input.questions.map((q) => q.num).filter((n) => !(n in result.answers));
    if (!missing.length) break;
    log(`考试判题缺少第 ${missing.join(',')} 题的答案，补问一次`);
    raw = await call(`\n\n上一次只给了部分答案，请补齐这些题：${missing.join(',')}，仍然只输出完整 JSON。`);
    const more = parseExamJudge(raw, input.questions);
    const merged: Record<number, string> = { ...more.answers };
    for (const [k, v] of Object.entries(result.answers)) merged[Number(k)] = v;
    result = { ...more, answers: merged, confidence: Math.min(more.confidence, result.confidence) };
  }
  return result;
}
