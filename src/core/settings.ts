// 设置模型（docs/DESIGN.md §7）。全部持久化到 GM 存储，键前缀 uc.setting.

export type Scope = 'required' | 'all';
export type SubmitMode = 'dryRun' | 'auto';

export interface LlmConfig {
  enabled: boolean;
  baseURL: string;
  model: string;
  apiKey: string;
}

export interface Settings {
  scope: Scope;
  submitMode: SubmitMode;
  delayMinMs: number;
  delayMaxMs: number;
  llm: LlmConfig;
  asr: { baseURL: string };
  listening: { mute: boolean; rate: number };
  exams: boolean;
  speaking: { targetSec: number };
  /** 页面渲染节奏：等题目选项出现的上限（毫秒），实测 3 秒够绝大多数听力页 */
  wait: { questionsMs: number };
  /** 整课批量的范围限制：unit 如 'u4'（空=全部单元），limit 0=不限 */
  batch: { unit: string; limit: number };
  ui: { opacity: number; x: number | null; y: number | null };
}

export const DEFAULT_SETTINGS: Settings = {
  scope: 'required',
  // 2026-11-26 用户决定：u4 已零失败，听力/填空改为默认自动提交。
  // 说类永远不提交（决策 10），所以「自动提交」不影响口语。
  submitMode: 'auto',
  delayMinMs: 3000,
  delayMaxMs: 8000,
  llm: { enabled: true, baseURL: '', model: '', apiKey: '' },
  asr: { baseURL: 'http://127.0.0.1:8000' },
  listening: { mute: true, rate: 1 },
  exams: false,
  speaking: { targetSec: 75 },
  wait: { questionsMs: 3000 },
  batch: { unit: '', limit: 0 },
  ui: { opacity: 0.95, x: null, y: null },
};

const KEY = 'uc.setting.settings';

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();

function merge(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    llm: { ...base.llm, ...(patch.llm ?? {}) },
    asr: { ...base.asr, ...(patch.asr ?? {}) },
    listening: { ...base.listening, ...(patch.listening ?? {}) },
    speaking: { ...base.speaking, ...(patch.speaking ?? {}) },
    wait: { ...base.wait, ...(patch.wait ?? {}) },
    batch: { ...base.batch, ...(patch.batch ?? {}) },
    ui: { ...base.ui, ...(patch.ui ?? {}) },
  };
}

let cache: Settings | null = null;

/** 一次性迁移：老用户存的是 dryRun，用户已明确要求改默认自动提交 */
const MIGRATE_AUTO = 'uc.setting.migrate.autoSubmit';

export function getSettings(): Settings {
  if (!cache) {
    const stored = GM_getValue<Partial<Settings> | null>(KEY, null);
    cache = merge(DEFAULT_SETTINGS, stored ?? {});
    if (!GM_getValue<boolean>(MIGRATE_AUTO, false)) {
      GM_setValue(MIGRATE_AUTO, true);
      cache = { ...cache, submitMode: 'auto' };
      if (stored) GM_setValue(KEY, cache);
    }
  }
  return cache;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  cache = merge(getSettings(), patch);
  GM_setValue(KEY, cache);
  listeners.forEach((fn) => fn(cache as Settings));
  return cache;
}

export function resetSettings(): Settings {
  GM_deleteValue(KEY);
  cache = structuredClone(DEFAULT_SETTINGS);
  listeners.forEach((fn) => fn(cache as Settings));
  return cache;
}

export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 运行期专用（不持久化）的进度/急停状态 */
export const RUNTIME = {
  paused: false,
  stopped: false,
};
