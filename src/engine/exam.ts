// 考试作答流程（docs/PAGE-MAP.md §14）：一段音频 → 一次 ASR → 一次判题 → 点选，
// 全部填完后由人确认再交卷（脚本不自动交卷）。
import { log } from '../core/log';
import { recognizeUrl } from '../core/asr';
import { getSettings } from '../core/settings';
import { judgeExamSet } from './judge';
import { setStatus } from './machine';
import {
  emptyExamQuestions,
  examSets,
  fillExamByNumber,
  isExamPage,
  submitExamPage,
  type ExamSet,
} from '../page/exam';

/** 同一段音频只识别一次（跨多题、多次点击都复用） */
const transcriptCache = new Map<string, string>();

export interface ExamRunResult {
  sets: number;
  questions: number;
  filled: number;
  missing: number[];
  lowConfidence: number;
}

function asrReady(): boolean {
  return !!getSettings().asr.baseURL;
}

async function transcriptOf(set: ExamSet, index: number, total: number): Promise<string> {
  const cached = transcriptCache.get(set.audioUrl);
  if (cached) return cached;
  log(`[${index + 1}/${total}] 识别音频（${set.duration ? `${set.duration}s` : '时长未知'}）…`);
  const r = await recognizeUrl(set.audioUrl);
  const text = (r.text || '').replace(/<\|[^|]*\|>/g, '').trim();
  if (text.length > 20) transcriptCache.set(set.audioUrl, text);
  return text;
}

/**
 * 判题并填入（不交卷）。返回填入情况；未填的题号交给面板提示。
 */
export async function runExam(): Promise<ExamRunResult> {
  if (!isExamPage()) throw new Error('当前不是试题作答页');

  const sets = examSets();
  if (!sets.length) throw new Error('没有解析到试题（页面可能还没渲染完）');

  const questions = sets.reduce((n, s) => n + s.questions.length, 0);
  log(`考试页解析到 ${sets.length} 段材料 / ${questions} 题`);

  if (!asrReady()) {
    setStatus({ lastError: '未配置 ASR 地址：考试没有文字原文，必须先用 SenseVoice 识别音频' });
    throw new Error('未配置 ASR 地址（设置页「ASR 地址」）');
  }

  setStatus({ state: 'answering', kind: 'listening', lastError: undefined, filled: 0, skipped: 0 });

  const answers: Record<number, string> = {};
  let lowConfidence = 0;
  let recognized = 0;

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    setStatus({ batch: { total: sets.length, index: i + 1, done: i, current: `${set.part ?? '材料'}（${set.questions.length} 题）` } });

    if (!set.audioUrl) {
      log(`[${i + 1}/${sets.length}] 这段没有音频地址，跳过`);
      continue;
    }

    let transcript = '';
    try {
      transcript = await transcriptOf(set, i, sets.length);
    } catch (e) {
      log(`[${i + 1}/${sets.length}] 识别失败：${(e as Error).message}`);
    }
    if (transcript.length < 20) {
      log(`[${i + 1}/${sets.length}] 没拿到有效转写，这段先跳过`);
      continue;
    }
    recognized += 1;

    const judged = await judgeExamSet({ transcript, part: set.part, questions: set.questions });
    if (judged.confidence < 0.5) lowConfidence += 1;
    for (const [k, v] of Object.entries(judged.answers)) answers[Number(k)] = v;
    log(
      `[${i + 1}/${sets.length}] ${set.questions.map((q) => `${q.num}${judged.answers[q.num] ?? '?'}`).join(' ')}（置信度 ${judged.confidence.toFixed(2)}）`,
    );
  }

  const filled = await fillExamByNumber(answers);
  const missing = emptyExamQuestions();
  setStatus({ filled, skipped: missing.length, state: 'idle' });

  log(`已填 ${filled} / ${questions} 题；识别成功 ${recognized}/${sets.length} 段；低置信段 ${lowConfidence} 段`);
  if (missing.length) {
    log(`还没填的题：${missing.join(',')}（这几题的音频没识别出来或判题缺项，请人工确认）`);
  } else {
    log('全部题目已填好。核对无误后点「提交试卷」——脚本不会自动交卷。');
  }

  return { sets: sets.length, questions, filled, missing, lowConfidence };
}

/** 交卷（需要人在面板上点确认） */
export async function submitExam(): Promise<boolean> {
  const missing = emptyExamQuestions();
  if (missing.length) {
    log(`还有 ${missing.length} 题没填（${missing.join(',')}），不提交`);
    setStatus({ lastError: `还有 ${missing.length} 题没填：${missing.join(',')}` });
    return false;
  }
  const r = await submitExamPage();
  if (r.ok) {
    log(`交卷完成：${r.message}`);
    setStatus({ lastError: undefined, state: 'idle' });
  } else {
    log(`交卷未完成：${r.message}`);
    setStatus({ lastError: r.message, state: 'failed' });
  }
  return r.ok;
}

/** 面板上的「判题并填入」按钮 */
export async function fillExam(): Promise<void> {
  try {
    await runExam();
  } catch (e) {
    const msg = (e as Error).message;
    log(`考试流程出错：${msg}`);
    setStatus({ lastError: msg, state: 'failed' });
  }
}
