// 作答状态机骨架（docs/DESIGN.md §5）。
// 真实题目解析/提交动作全部依赖勘察，不要在此臆想选择器。
import { getSettings, RUNTIME } from '../core/settings';
import { log } from '../core/log';

export type EngineState =
  | 'idle'
  | 'planning'
  | 'unit_open'
  | 'question_loop'
  | 'unit_submit'
  | 'paused'
  | 'stopped'
  | 'failed';

export interface EngineStatus {
  state: EngineState;
  unit?: string;
  question?: string;
  filled?: number;
  skipped?: number;
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

function assertRunning(): void {
  if (RUNTIME.stopped) throw new StopSignal();
  if (RUNTIME.paused) throw new PauseSignal();
}

class StopSignal extends Error {}
class PauseSignal extends Error {}

export function pause(): void {
  RUNTIME.paused = true;
  setStatus({ state: 'paused' });
  log('引擎已暂停');
}

export function resume(): void {
  RUNTIME.paused = false;
  setStatus({ state: 'question_loop' });
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
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * M2 入口：跑通单题流程后再扩展成整单元循环。
 * TODO(勘察): 课程/单元清单拉取、题目遍历、题型分派、提交。
 */
export async function startEngine(): Promise<void> {
  if (status.state !== 'idle' && status.state !== 'stopped' && status.state !== 'failed') {
    log('引擎已在运行，忽略重复启动');
    return;
  }
  RUNTIME.paused = false;
  RUNTIME.stopped = false;
  setStatus({ state: 'planning', lastError: undefined });
  try {
    assertRunning();
    setStatus({ state: 'question_loop' });
    log('骨架已启动：等待页面勘察结果接入题目解析与提交');
  } catch (e) {
    if (e instanceof PauseSignal) return;
    if (e instanceof StopSignal) return;
    setStatus({ state: 'failed', lastError: (e as Error).message });
    log(`引擎异常: ${(e as Error).message}`);
  }
}
