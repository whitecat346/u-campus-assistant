// 批量遍历整门课程（M3）。设计依据 docs/DESIGN.md 决策 3/4/11 + docs/PAGE-MAP.md §3/§8。
// 关键实测事实：
//  * 进度接口 /course/api/v2/course_progress/{courseId}/{unit}/{openId}/default/，leafs 按 groupId 索引
//  * 整课进度接口只返回 rt.units，leafs 必须逐单元取（api.fetchAllProgress 已处理）
//  * courseId 不能 encodeURIComponent（含 '+'，编码后服务端返回 code:2）
//  * 路由 hash = #/{courseId}/courseware/{unit}/{node0}/{node1}/{group}/p_1
//  * 听力原文随内容下发；正确答案只在提交后下发 → 必须 LLM 判题
//  * 说类（sentencerecord 等）内容常常不经过 JSON.parse → 用 DOM 兜底判就绪
//  * 页面偶尔会被弹回目录页 → 队列与下标持久化到 GM，回到 pc.html 自动续跑
import { getSettings, RUNTIME } from '../core/settings';
import { log } from '../core/log';
import {
  fetchAllProgress,
  fetchCourseTree,
  flattenCourse,
  getOpenId,
  itemToRoute,
  navigateToGroup,
  parseAnswerRoute,
  type AnswerPageRoute,
  type CourseItem,
  type LeafState,
} from '../core/api';
import { clearCapture, latestQuestionsContent, waitForNewCapture } from '../page/capture';
import {
  applyChoices,
  audioUrlFromContent,
  blankItems,
  emptyBlanks,
  fillBlanks,
  fillTextArea,
  questionsFromContent,
  questionsFromDom,
  speakingPromptText,
  textInputs,
  transcriptFromContent,
  unansweredGroups,
  writingPromptFromContent,
  type TaskKind,
} from '../page/questions';
import { submitCurrentGroup } from '../page/submit';
import { draftSpeakingScript, judgeBlanks, judgeObjective } from './judge';
import { assertRunning, getStatus, setStatus, StopSignal, PauseSignal } from './machine';

const DONE_KEY = 'uc.batch.done';
const STATE_KEY = 'uc.batch.state';

type DoneMap = Record<string, string[]>;

export interface BatchState {
  courseId: string;
  /** 结果页查询串（cid=…&schId=…），续跑时用来重建 pc.html URL */
  pcQuery: string;
  plan: CourseItem[];
  index: number;
  running: boolean;
  ts: number;
  handled: number;
  skipped: number;
  scripts: Array<{ group: string; name: string; text: string }>;
  failed: string[];
}

function loadDone(): DoneMap {
  return GM_getValue<DoneMap>(DONE_KEY, {});
}

function markDone(courseId: string, group: string): void {
  const all = loadDone();
  const list = new Set(all[courseId] ?? []);
  list.add(group);
  all[courseId] = [...list];
  GM_setValue(DONE_KEY, all);
}

export function resetBatchProgress(courseId?: string): void {
  if (!courseId) {
    GM_setValue(DONE_KEY, {});
    return;
  }
  const all = loadDone();
  delete all[courseId];
  GM_setValue(DONE_KEY, all);
}

export function doneCount(courseId: string): number {
  return (loadDone()[courseId] ?? []).length;
}

export function loadBatchState(): BatchState | null {
  const s = GM_getValue<BatchState | null>(STATE_KEY, null);
  if (!s || !Array.isArray(s.plan)) return null;
  return s;
}

function saveBatchState(s: BatchState | null): void {
  if (s) GM_setValue(STATE_KEY, { ...s, ts: Date.now() });
  else GM_deleteValue(STATE_KEY);
}

export function clearBatchState(): void {
  GM_deleteValue(STATE_KEY);
  RUNTIME.stopped = true;
}

/** base（服务端任务类型）→ 本地题型 */
export function kindOfBase(base: string): TaskKind {
  if (!base) return 'unknown';
  if (/sentencerecord|readaloud|presentation|roleplay|oral|magic_/i.test(base)) return 'speaking';
  if (/shortanswer/i.test(base)) return 'writing';
  if (/objectivesimple|purecontent|singlechoice|shortanswer_multi/i.test(base)) return 'listening';
  return 'unknown';
}

function isExamUnit(name: string): boolean {
  return /midterm|final|test|期中|期末|测试/i.test(name);
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function jitterMs(): number {
  const s = getSettings();
  const min = Math.min(s.delayMinMs, s.delayMaxMs);
  const max = Math.max(s.delayMinMs, s.delayMaxMs);
  return min + Math.random() * Math.max(0, max - min);
}

const LOADED_SELECTORS = [
  'div[class*="questions--question-"]',
  'input[type=radio]',
  'textarea',
  '[contenteditable="true"]',
  'audio',
  'button.record',
  'button[class*="submit-bar-pc--btn"]',
];

/** DOM 里是否已经出现该题型的可操作元素（有些 group 的内容不走 JSON.parse，抓不到就靠这个兜底） */
function pageLooksLoaded(): boolean {
  return LOADED_SELECTORS.some((sel) => document.querySelector(sel) !== null);
}

/** 等待页面切到目标 group 且内容已下发 */
async function gotoGroup(route: AnswerPageRoute, timeoutMs = 25000): Promise<boolean> {
  clearCapture();
  const from = Date.now();
  navigateToGroup(route);
  const started = Date.now();
  let domReadyAt = 0;
  while (Date.now() - started < timeoutMs) {
    assertRunning();
    if (await waitForNewCapture(from, 1000)) {
      // 内容已到，再给 DOM 一点渲染时间（radio 列表要等 React 渲染完才能点）
      await sleep(800);
      return true;
    }
    // 兜底：切过去 5 秒后 DOM 已有题目/音频/录音按钮，也认为可用（说类内容常常不经过 JSON.parse）
    if (!domReadyAt && Date.now() - started > 5000 && pageLooksLoaded()) domReadyAt = Date.now();
    if (domReadyAt && Date.now() - domReadyAt > 1500) return true;
  }
  return pageLooksLoaded();
}

export interface BatchOutcome {
  total: number;
  handled: number;
  skipped: number;
  scripts: number;
  failed: string[];
}

function isAnswerPage(): boolean {
  return /ucontent\.unipus\.cn$/.test(location.hostname) && location.pathname.includes('/pc.html');
}

function pcUrlFor(state: BatchState, item: CourseItem): string {
  const route = itemToRoute(item, state.courseId);
  const hash = `#/${state.courseId}/courseware/${[route.unit, ...route.nodes, route.group].join('/')}/p_1`;
  return `https://ucontent.unipus.cn/_pc_default/pc.html?${state.pcQuery}${hash}`;
}

/** 真正的执行循环：从 state.index 开始，每步持久化下标（页面被弹走也能续跑） */
async function runPlan(state: BatchState): Promise<BatchOutcome> {
  const { courseId, plan } = state;
  const settings = getSettings();
  const scripts = [...state.scripts];
  const failed = [...state.failed];
  let handled = state.handled;
  let skipped = state.skipped;

  RUNTIME.paused = false;
  RUNTIME.stopped = false;
  state.running = true;

  setStatus({
    state: 'planning',
    lastError: undefined,
    script: undefined,
    scripts,
    filled: getStatus().filled ?? 0,
    skipped: 0,
  });

  try {
    for (let i = state.index; i < plan.length; i++) {
      const it = plan[i];
      assertRunning();
      state.index = i;
      saveBatchState(state);
      setStatus({
        batch: { total: plan.length, index: i + 1, done: handled, current: `${it.unitName} / ${it.name}` },
        group: it.group,
      });

      const kind = kindOfBase(it.base);
      log(`[${i + 1}/${plan.length}] ${it.unitName} / ${it.name}（${it.group}，base=${it.base} → ${kind}）`);

      // 被弹回目录页/其它页面时，先回到答题页（整页跳转，靠下次 mount 自动续跑）
      if (!isAnswerPage()) {
        const url = pcUrlFor(state, it);
        log('当前不在答题页，跳回答题页后续跑');
        saveBatchState(state);
        location.href = url;
        return { total: plan.length, handled, skipped, scripts: scripts.length, failed };
      }

      try {
        const ok = await gotoGroup(itemToRoute(it, courseId));
        assertRunning();
        if (!ok) {
          log('内容未下发，跳过该 group');
          failed.push(it.group);
          continue;
        }

        const content = latestQuestionsContent();

        if (kind === 'cloze') {
          // 听录音补全句子：空位常常比播放器晚一点渲染
          const waitMs = Math.max(500, settings.wait.questionsMs | 0);
          for (let waited = 0; waited < waitMs && !blankItems().length; waited += 300) await sleep(300);
          const items = blankItems();
          if (!items.length) {
            log('填空页没有找到空位，跳过');
            failed.push(it.group);
            continue;
          }
          const ctx = latestQuestionsContent() ?? content;
          const transcript = ctx ? transcriptFromContent(ctx) : '';
          const audioUrl = ctx ? audioUrlFromContent(ctx) : (document.querySelector('audio') as HTMLAudioElement | null)?.currentSrc ?? null;
          log(`听力填空 ${items.length} 空；原文${transcript ? '已下发' : '缺失（将回退 ASR）'}`);
          const judged = await judgeBlanks({
            transcript,
            audioUrl,
            sentences: items.map((b) => ({ index: b.index, sentence: b.sentence })),
          });
          assertRunning();
          const filled = fillBlanks(judged.words);
          handled += 1;
          setStatus({ filled: (getStatus().filled ?? 0) + filled });
          await sleep(300 + filled * 120);

          const empty = emptyBlanks();
          if (empty.length) log(`第 ${empty.join(',')} 空没有答案（判题未给出），该组不提交`);

          if (settings.submitMode === 'auto') {
            if (empty.length) {
              log('有空位未填，禁止自动提交');
            } else if (judged.confidence < 0.5) {
              log(`置信度 ${judged.confidence.toFixed(2)} 偏低，不自动提交`);
            } else {
              const outcome = await submitCurrentGroup(true);
              if (outcome.submitted) {
                markDone(courseId, it.group);
                log(`已提交 ${it.name}`);
              } else {
                failed.push(it.group);
                log(`提交未完成：${outcome.message ?? ''}`);
              }
            }
          } else {
            log('dry-run：填空已填好，未提交（可在页面核对）');
          }
          continue;
        }

        if (kind === 'speaking') {
          const prompt = writingPromptFromContent(content) || (content ? transcriptFromContent(content) : '') || speakingPromptText();
          const text = await draftSpeakingScript(prompt, settings.speaking.targetSec);
          assertRunning();
          scripts.push({ group: it.group, name: `${it.unitName} / ${it.name}`, text });
          setStatus({ scripts: [...scripts] });
          log(`说类：已生成短稿（${text.split(/\s+/).length} 词），不录音不提交`);
          markDone(courseId, it.group);
          skipped += 1;
          continue;
        }

        if (kind === 'writing') {
          const prompt = writingPromptFromContent(content) || speakingPromptText();
          const text = await draftSpeakingScript(prompt, Math.max(60, settings.speaking.targetSec));
          assertRunning();
          const target = textInputs()[0];
          if (target && fillTextArea(target, text)) {
            handled += 1;
            if (settings.submitMode === 'auto') {
              const outcome = await submitCurrentGroup(true);
              log(`写作提交：${outcome.submitted ? '成功' : `未完成（${outcome.message ?? ''}）`}`);
            } else {
              log('dry-run：写作内容已填入，未提交');
            }
            markDone(courseId, it.group);
          } else {
            scripts.push({ group: it.group, name: `${it.unitName} / ${it.name}`, text });
            setStatus({ scripts: [...scripts] });
            log('写作：未找到可写入的文本域，已把内容放进短稿列表');
            skipped += 1;
          }
          continue;
        }

        // 听力 / 客观题：页面常先渲染播放器、后渲染选项，先等一小会儿（设置页可调，默认 3 秒）
        const waitMs = Math.max(500, settings.wait.questionsMs | 0);
        let ctx = content;
        let questions = ctx ? questionsFromContent(ctx) : [];
        for (let waited = 0; waited < waitMs && !questions.length; waited += 300) {
          await sleep(300);
          assertRunning();
          ctx = latestQuestionsContent() ?? ctx;
          questions = ctx ? questionsFromContent(ctx) : [];
          if (!questions.length) questions = questionsFromDom();
        }
        if (!questions.length) {
          log(`等待 ${(waitMs / 1000).toFixed(1)} 秒仍未拿到题目，跳过（可在设置页调大「等题目」）`);
          failed.push(it.group);
          continue;
        }
        const transcript = ctx ? transcriptFromContent(ctx) : '';
        const audioUrl = ctx ? audioUrlFromContent(ctx) : (document.querySelector('audio') as HTMLAudioElement | null)?.currentSrc ?? null;
        const judged = await judgeObjective({ transcript, audioUrl, questions });
        assertRunning();
        const filled = applyChoices(judged.answers);
        handled += 1;
        setStatus({ filled: (getStatus().filled ?? 0) + filled });
        await sleep(400 + filled * 120);

        // 硬性安全阀：还有没选的题就绝不提交（漏题＝白丢分，且只记第一次得分）
        const missing = unansweredGroups();
        if (missing.length) {
          log(`第 ${missing.map((i) => i + 1).join(',')} 题没有答案（判题未给出），该组不提交`);
        }

        if (settings.submitMode === 'auto') {
          if (missing.length) {
            log('有题未填，禁止自动提交');
          } else if (judged.confidence < 0.5) {
            log(`置信度 ${judged.confidence.toFixed(2)} 偏低，不自动提交`);
          } else {
            const outcome = await submitCurrentGroup(true);
            if (outcome.submitted) {
              markDone(courseId, it.group);
              log(`已提交 ${it.name}`);
            } else {
              failed.push(it.group);
              log(`提交未完成：${outcome.message ?? ''}`);
            }
          }
        } else {
          log('dry-run：已填好答案，未提交（可在页面核对）');
        }
      } catch (e) {
        if (e instanceof StopSignal || e instanceof PauseSignal) throw e;
        failed.push(it.group);
        log(`处理 ${it.group} 失败：${(e as Error).message}`);
      }

      state.handled = handled;
      state.skipped = skipped;
      saveBatchState(state);
      assertRunning();
      await sleep(jitterMs());
    }

    saveBatchState(null);
    setStatus({ state: 'idle', batch: { total: plan.length, index: plan.length, done: handled } });
    log(`批量结束：处理 ${handled}，跳过 ${skipped}，失败 ${failed.length}，短稿 ${scripts.length}`);
    return { total: plan.length, handled, skipped, scripts: scripts.length, failed };
  } catch (e) {
    // 暂停/急停：保留状态，允许「继续」
    state.running = false;
    saveBatchState(e instanceof StopSignal ? null : state);
    throw e;
  }
}

/** 主入口：从当前课程构建队列并开始跑 */
export async function startBatch(): Promise<BatchOutcome> {
  RUNTIME.paused = false;
  RUNTIME.stopped = false;

  const route = parseAnswerRoute();
  if (!route) throw new Error('当前不在答题页，无法确定 courseId');
  const courseId = route.courseId;
  const settings = getSettings();

  setStatus({ state: 'planning', lastError: undefined, script: undefined, scripts: [], filled: 0, skipped: 0 });
  log(`批量：读取课程树 ${courseId}`);

  const openId = await getOpenId();
  const tree = await fetchCourseTree(courseId);
  const items = flattenCourse(tree);
  log(`课程树解析出 ${items.length} 个 group`);

  const progress: Record<string, LeafState> = await fetchAllProgress(courseId, openId);
  const done = new Set(loadDone()[courseId] ?? []);

  const queue: CourseItem[] = [];
  let skippedText = 0;
  let skippedDone = 0;
  let skippedExam = 0;
  let skippedOptional = 0;
  let skippedUnit = 0;

  for (const it of items) {
    const st = progress[it.group];
    if (!st) continue;
    if (it.tabType === 'text') {
      skippedText += 1;
      continue;
    }
    if (settings.batch.unit && it.unit !== settings.batch.unit) {
      skippedUnit += 1;
      continue;
    }
    if ((st.state?.pass ?? 0) > 0 || done.has(it.group)) {
      skippedDone += 1;
      continue;
    }
    if (settings.scope === 'required' && !st.strategies?.required) {
      skippedOptional += 1;
      continue;
    }
    if (!settings.exams && isExamUnit(it.unitName)) {
      skippedExam += 1;
      continue;
    }
    if (st.strategies?.end_time && st.strategies.end_time * 1000 < Date.now()) {
      skippedExam += 1;
      continue;
    }
    queue.push(it);
  }

  const limit = Math.max(0, settings.batch.limit | 0);
  const plan = limit > 0 ? queue.slice(0, limit) : queue;

  log(
    `待办 ${queue.length}${limit > 0 ? `（本轮上限 ${limit}）` : ''}（跳过：已完成 ${skippedDone} / 无提交文本页 ${skippedText} / 非必修 ${skippedOptional} / 测试或已过截止 ${skippedExam} / 其它单元 ${skippedUnit}）`,
  );

  const state: BatchState = {
    courseId,
    pcQuery: location.search.replace(/^\?/, ''),
    plan,
    index: 0,
    running: true,
    ts: Date.now(),
    handled: 0,
    skipped: 0,
    scripts: [],
    failed: [],
  };
  saveBatchState(state);
  return runPlan(state);
}

/** 防止「跳回答题页 → 被弹回目录页 → 再跳」的死循环 */
let lastRedirectAt = 0;

/** 页面重新加载后（被弹回/手滑刷新）自动续跑；调用方在 mount 里试一次即可 */
export async function resumeBatchIfNeeded(): Promise<BatchOutcome | null> {
  const state = loadBatchState();
  if (!state || !state.running) return null;
  if (Date.now() - state.ts > 30 * 60 * 1000) {
    log('批量状态已超过 30 分钟，不再自动续跑');
    saveBatchState(null);
    return null;
  }
  if (state.index >= state.plan.length) {
    saveBatchState(null);
    return null;
  }
  if (!isAnswerPage()) {
    // 不在答题页：跳回下一条待办（整页跳转后 mount 会再调用本函数）
    if (Date.now() - lastRedirectAt < 20000) {
      log('刚尝试过跳回答题页（可能被服务端弹回），这次不重复跳，避免死循环');
      return null;
    }
    lastRedirectAt = Date.now();
    const url = pcUrlFor(state, state.plan[state.index]);
    log(`续跑：当前不在答题页，跳转到 ${state.plan[state.index].name}`);
    location.href = url;
    return null;
  }
  log(`自动续跑：从第 ${state.index + 1}/${state.plan.length} 条继续`);
  return runPlan(state);
}

