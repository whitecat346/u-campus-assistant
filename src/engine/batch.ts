// 批量遍历整门课程（M3）。设计依据 docs/DESIGN.md 决策 3/4/11 + docs/PAGE-MAP.md §3/§8。
// 关键实测事实：
//  * 进度接口 /course/api/v2/course_progress/{courseId}/{unit}/{openId}/default/，leafs 按 groupId 索引
//  * courseId 不能 encodeURIComponent（含 '+'，编码后服务端返回 code:2）
//  * 路由 hash = #/{courseId}/courseware/{unit}/{node0}/{node1}/{group}/p_1
//  * 听力原文随内容下发；正确答案只在提交后下发 → 必须 LLM 判题
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
  type CourseItem,
  type LeafState,
} from '../core/api';
import { clearCapture, latestQuestionsContent, waitForNewCapture } from '../page/capture';
import {
  applyChoices,
  audioUrlFromContent,
  fillTextArea,
  questionsFromContent,
  speakingPromptText,
  textInputs,
  transcriptFromContent,
  writingPromptFromContent,
  type TaskKind,
} from '../page/questions';
import { submitCurrentGroup } from '../page/submit';
import { draftSpeakingScript, judgeObjective } from './judge';
import { assertRunning, getStatus, setStatus, StopSignal, PauseSignal } from './machine';

const DONE_KEY = 'uc.batch.done';

type DoneMap = Record<string, string[]>;

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

/** 等待页面切到目标 group 且新内容已下发 */
async function gotoGroup(route: ReturnType<typeof itemToRoute>, timeoutMs = 30000): Promise<boolean> {
  clearCapture();
  const from = Date.now();
  navigateToGroup(route);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    assertRunning();
    if (await waitForNewCapture(from, 1000)) {
      // 内容已到，再给 DOM 一点渲染时间（radio 列表要等 React 渲染完才能点）
      await sleep(800);
      return true;
    }
  }
  return false;
}

export interface BatchOutcome {
  total: number;
  handled: number;
  skipped: number;
  scripts: number;
  failed: string[];
}

/** 主入口：从当前课程遍历所有未完成项 */
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

  for (const it of items) {
    const st = progress[it.group];
    if (!st) continue;
    if (it.tabType === 'text') {
      skippedText += 1;
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

  log(
    `待办 ${queue.length}（跳过：已完成 ${skippedDone} / 无提交文本页 ${skippedText} / 非必修 ${skippedOptional} / 测试或已过截止 ${skippedExam}）`,
  );

  const scripts: Array<{ group: string; name: string; text: string }> = [];
  const failed: string[] = [];
  let handled = 0;
  let skipped = 0;

  for (let i = 0; i < queue.length; i++) {
    const it = queue[i];
    assertRunning();
    setStatus({ batch: { total: queue.length, index: i + 1, done: handled, current: `${it.unitName} / ${it.name}` }, group: it.group });

    const kind = kindOfBase(it.base);
    log(`[${i + 1}/${queue.length}] ${it.unitName} / ${it.name}（${it.group}，base=${it.base} → ${kind}）`);

    try {
      const ok = await gotoGroup(itemToRoute(it, courseId));
      assertRunning();
      if (!ok) {
        log('内容未下发，跳过该 group');
        failed.push(it.group);
        continue;
      }

      const content = latestQuestionsContent();

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

      // 听力 / 客观题
      const questions = content ? questionsFromContent(content) : [];
      if (!questions.length) {
        log('未解析到题目，跳过');
        failed.push(it.group);
        continue;
      }
      const transcript = content ? transcriptFromContent(content) : '';
      const audioUrl = content ? audioUrlFromContent(content) : null;
      const judged = await judgeObjective({ transcript, audioUrl, questions });
      assertRunning();
      const filled = applyChoices(judged.answers);
      handled += 1;
      setStatus({ filled: (getStatus().filled ?? 0) + filled });
      await sleep(400 + filled * 120);

      if (settings.submitMode === 'auto') {
        if (judged.confidence < 0.5) {
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

    assertRunning();
    await sleep(jitterMs());
  }

  setStatus({ state: 'idle', batch: { total: queue.length, index: queue.length, done: handled } });
  log(`批量结束：处理 ${handled}，跳过 ${skipped}，失败 ${failed.length}，短稿 ${scripts.length}`);
  return { total: queue.length, handled, skipped, scripts: scripts.length, failed };
}
