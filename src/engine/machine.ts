// 作答主流程（M2：单 group 跑通，M3 再扩成整课程遍历）。
// 实测依据：docs/PAGE-MAP.md §4/§5/§8。
import { getSettings, RUNTIME } from '../core/settings';
import { log } from '../core/log';
import { parseAnswerRoute, buildAnswerHash } from '../core/api';
import { waitForQuestions } from '../page/capture';
import {
  applyChoices,
  audioUrlFromContent,
  blankItems,
  emptyBlanks,
  fillBlanks,
  detectTaskKind,
  fillTextArea,
  questionsFromContent,
  questionsFromDom,
  speakingPromptText,
  textInputs,
  transcriptFromContent,
  unansweredGroups,
  type TaskKind,
} from '../page/questions';
import { submitCurrentGroup } from '../page/submit';
import { draftSpeakingScript, judgeBlanks, judgeObjective } from './judge';

export type EngineState = 'idle' | 'planning' | 'group_open' | 'answering' | 'submitting' | 'paused' | 'stopped' | 'failed';

export interface EngineStatus {
  state: EngineState;
  group?: string;
  kind?: TaskKind;
  filled?: number;
  skipped?: number;
  score?: number;
  /** 说类任务生成的口语短稿 */
  script?: string;
  lastError?: string;
  /** 批量模式进度 */
  batch?: { total: number; index: number; done: number; current?: string };
  /** 批量模式收集到的说类短稿 */
  scripts?: Array<{ group: string; name: string; text: string }>;
}

type StatusListener = (s: EngineStatus) => void;

let status: EngineStatus = { state: 'idle', filled: 0, skipped: 0 };
const listeners = new Set<StatusListener>();

export function getStatus(): EngineStatus {
  return status;
}

export function onStatus(fn: StatusListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setStatus(patch: Partial<EngineStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

class StopSignal extends Error {}
class PauseSignal extends Error {}

export { StopSignal, PauseSignal };

export function assertRunning(): void {
  if (RUNTIME.stopped) throw new StopSignal();
  if (RUNTIME.paused) throw new PauseSignal();
}

export function pause(): void {
  RUNTIME.paused = true;
  setStatus({ state: 'paused' });
  log('引擎已暂停');
}

export function resume(): void {
  RUNTIME.paused = false;
  setStatus({ state: 'answering' });
  log('引擎已恢复');
}

export function stop(): void {
  RUNTIME.stopped = true;
  setStatus({ state: 'stopped' });
  log('引擎已急停');
}

/** 随机间隔（决策 13） */
export function jitter(min = getSettings().delayMinMs, max = getSettings().delayMaxMs): Promise<void> {
  const ms = min + Math.random() * Math.max(0, max - min);
  return new Promise((r) => window.setTimeout(r, ms));
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/* ------------------------------ 单 group 流程 ------------------------------ */

export async function runCurrentGroup(): Promise<void> {
  const route = parseAnswerRoute();
  if (!route) {
    setStatus({ state: 'failed', lastError: '当前不在答题页（hash 未匹配 courseware 路由）' });
    return;
  }
  setStatus({ state: 'group_open', group: route.group, script: undefined, lastError: undefined });
  log(`进入 group ${route.group}（${buildAnswerHash(route)}）`);

  const kind = detectTaskKind();
  setStatus({ kind });
  log(`题型判定：${kind}`);

  // 等页面把内容下发（听力原文/题干都来自截获的解密内容）
  // 注意 from 传 0：内容可能在本轮开始前就已被截获，不能被「必须更新」卡住。
  const content = await waitForQuestions(Math.max(1000, getSettings().wait.questionsMs), 0);
  assertRunning();

  if (kind === 'cloze') {
    const items = blankItems();
    if (!items.length) {
      setStatus({ state: 'failed', lastError: '填空页没有找到空位' });
      return;
    }
    const transcript = content ? transcriptFromContent(content) : '';
    const audioUrl = content ? audioUrlFromContent(content) : (document.querySelector('audio') as HTMLAudioElement | null)?.currentSrc ?? null;
    log(`听力填空 ${items.length} 空；原文${transcript ? '已下发' : '缺失（将回退 ASR）'}`);
    const judged = await judgeBlanks({
      transcript,
      audioUrl,
      sentences: items.map((b) => ({ index: b.index, sentence: b.sentence })),
    });
    assertRunning();
    const filled = fillBlanks(judged.words);
    setStatus({ filled: (status.filled ?? 0) + filled });
    await sleep(300 + filled * 120);
    const empty = emptyBlanks();
    if (empty.length) log(`第 ${empty.join(',')} 空没有答案（判题未给出），本次不提交`);
    if (getSettings().submitMode !== 'auto') {
      log('dry-run：填空已填好，未提交（可在页面核对）');
      setStatus({ state: 'idle' });
      return;
    }
    if (empty.length || judged.confidence < 0.5) {
      setStatus({ state: 'idle' });
      return;
    }
    setStatus({ state: 'submitting' });
    const outcome = await submitCurrentGroup(true);
    setStatus({ state: outcome.submitted ? 'idle' : 'failed', lastError: outcome.submitted ? undefined : (outcome.message ?? '提交未完成') });
    return;
  }

  if (kind === 'speaking') {
    const prompt = speakingPromptText();
    log('说类任务：只生成短稿，不录音、不提交（决策 10）');
    const script = await draftSpeakingScript(prompt, getSettings().speaking.targetSec);
    setStatus({ state: 'paused', kind: 'speaking', script });
    log(`短稿已生成（${script.split(/\s+/).length} 词），请自己朗读后手动提交`);
    return;
  }

  if (kind === 'reading' || kind === 'unknown') {
    setStatus({ state: 'idle', skipped: (status.skipped ?? 0) + 1 });
    log('无题材料页：不填不交，跳过');
    return;
  }

  if (kind === 'writing') {
    const prompt = speakingPromptText();
    const text = await draftSpeakingScript(prompt, Math.max(60, getSettings().speaking.targetSec), 'essay');
    const target = textInputs()[0];
    if (target && fillTextArea(target, text)) {
      log('写作/简答题：已写入文本域（是否提交取决于「提交」设置）');
      if (getSettings().submitMode === 'auto') {
        setStatus({ state: 'submitting' });
        const outcome = await submitCurrentGroup(true);
        setStatus({ state: outcome.submitted ? 'idle' : 'failed', lastError: outcome.submitted ? undefined : (outcome.message ?? '提交未完成') });
      } else {
        log('dry-run：写作内容已填入，未提交');
        setStatus({ state: 'idle' });
      }
    } else {
      log('写作/简答题：没有找到可写入的文本域，只给出稿子');
      setStatus({ state: 'paused', kind: 'writing', script: text });
    }
    return;
  }

  // 听力/客观题
  const questions = content ? questionsFromContent(content) : questionsFromDom();
  if (!questions.length) {
    setStatus({ state: 'failed', lastError: '未能解析到题目（内容与 DOM 均为空）' });
    return;
  }
  const transcript = content ? transcriptFromContent(content) : '';
  const audioUrl = content ? audioUrlFromContent(content) : (document.querySelector('audio') as HTMLAudioElement | null)?.currentSrc ?? null;
  log(`题目 ${questions.length} 道；原文${transcript ? '已下发' : '缺失（将回退 ASR）'}；音频 ${audioUrl ? '有' : '无'}`);

  setStatus({ state: 'answering' });
  const judged = await judgeObjective({ transcript, audioUrl, questions });
  assertRunning();
  log(`判题结果：${JSON.stringify(judged.answers)}（置信度 ${judged.confidence.toFixed(2)}）${judged.note ? ` — ${judged.note}` : ''}`);

  const filled = applyChoices(judged.answers);
  setStatus({ filled: (status.filled ?? 0) + filled });
  await sleep(400 + filled * 150);

  // 硬性安全阀：页面上还有没选的题 → 绝不提交（漏题＝白丢分，且只记第一次得分）
  const missing = unansweredGroups();
  if (missing.length) {
    log(`第 ${missing.map((i) => i + 1).join(',')} 题没有答案（判题未给出），本次不提交`);
  }

  const mode = getSettings().submitMode;
  const lowConfidence = judged.confidence < 0.5;
  if (mode !== 'auto') {
    log('dry-run：只填不交，请在页面上自行核对后提交');
    setStatus({ state: 'idle' });
    return;
  }
  if (missing.length) {
    setStatus({ state: 'idle' });
    return;
  }
  if (lowConfidence) {
    log(`置信度偏低（${judged.confidence.toFixed(2)}），按风控不自动提交（决策 11）`);
    setStatus({ state: 'idle' });
    return;
  }

  setStatus({ state: 'submitting' });
  const outcome = await submitCurrentGroup(true);
  if (!outcome.submitted) {
    setStatus({ state: 'failed', lastError: outcome.message ?? '提交未完成' });
    return;
  }
  setStatus({ state: 'idle', group: route.group });
  log('本 group 完成');
}

export async function startEngine(): Promise<void> {
  RUNTIME.paused = false;
  RUNTIME.stopped = false;
  setStatus({ state: 'planning', lastError: undefined, filled: 0, skipped: 0, script: undefined });
  try {
    assertRunning();
    await runCurrentGroup();
  } catch (e) {
    if (e instanceof PauseSignal) {
      setStatus({ state: 'paused' });
      return;
    }
    if (e instanceof StopSignal) {
      setStatus({ state: 'stopped' });
      return;
    }
    setStatus({ state: 'failed', lastError: (e as Error).message });
    log(`引擎异常: ${(e as Error).message}`);
  }
}

