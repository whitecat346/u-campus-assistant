// 作答主流程（M2：单 group 跑通，M3 再扩成整课程遍历）。
// 实测依据：docs/PAGE-MAP.md §4/§5/§8。
import { getSettings, RUNTIME } from '../core/settings';
import { log } from '../core/log';
import { parseAnswerRoute, buildAnswerHash } from '../core/api';
import { waitForQuestions } from '../page/capture';
import {
  applyChoices,
  audioUrlFromContent,
  detectTaskKind,
  questionsFromContent,
  speakingPromptText,
  transcriptFromContent,
  type Question,
  type TaskKind,
} from '../page/questions';
import { submitCurrentGroup } from '../page/submit';
import { draftSpeakingScript, judgeObjective } from './judge';

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

function setStatus(patch: Partial<EngineStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

class StopSignal extends Error {}
class PauseSignal extends Error {}

function assertRunning(): void {
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

/* --------------------------- DOM 兜底题目解析 --------------------------- */

function questionsFromDom(): Question[] {
  const out: Question[] = [];
  const names = new Set<string>();
  document.querySelectorAll<HTMLInputElement>('input[type=radio]').forEach((r) => names.add(r.name));
  [...names].forEach((name, i) => {
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${name}"]`));
    const scope = radios[0]?.closest('div[class*="questions--question-"], li, section') ?? document.body;
    const stem = (scope as HTMLElement).innerText.split('\n')[0]?.trim() ?? '';
    out.push({
      index: i,
      stem,
      options: radios.map((r) => {
        const label = (r.closest('label') ?? r.parentElement) as HTMLElement | null;
        return { caption: r.value, label: (label?.innerText ?? '').replace(/^[A-Z][.、]\s*/, '').trim() };
      }),
    });
  });
  return out;
}

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
  const content = await waitForQuestions(15000);
  assertRunning();

  if (kind === 'speaking') {
    const prompt = speakingPromptText();
    log('说类任务：只生成短稿，不录音、不提交（决策 10）');
    const script = await draftSpeakingScript(prompt, getSettings().speaking.targetSec);
    setStatus({ state: 'paused', script });
    log(`短稿已生成（${script.split(/\s+/).length} 词），请自己朗读后手动提交`);
    return;
  }

  if (kind === 'reading' || kind === 'unknown') {
    setStatus({ state: 'idle', skipped: (status.skipped ?? 0) + 1 });
    log('无题材料页：不填不交，跳过');
    return;
  }

  if (kind === 'writing') {
    log('写作/简答题：当前版本仅生成稿，自动填入待 M2.5 验证 textarea 事件');
    const prompt = speakingPromptText();
    const text = await draftSpeakingScript(prompt, Math.max(60, getSettings().speaking.targetSec));
    setStatus({ state: 'paused', script: text });
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

  const mode = getSettings().submitMode;
  const lowConfidence = judged.confidence < 0.5;
  if (mode !== 'auto') {
    log('dry-run：只填不交，请在页面上自行核对后提交');
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
