// 考试/测试页（uexercise.unipus.cn）实测结构，见 docs/PAGE-MAP.md §14。
// 事实（2026-11-26 实测 u10 Test 2 Final / exerciseId=7003）：
//  * 整张卷子渲染在一个页面里，三栏 tab 只是滚动定位；`.itest-section[sectionKey][sectionType=sHear]` 是区块。
//  * 每一段材料是 `.itest-ques-set[questionid]`：内含 `.itest-hear-reslist > span` 的文本是
//    JSON 数组 ["<mp3 url>", "<秒数>"]（**这段材料的唯一音频**），下面 `.css-danxuan.row` 是 2~4 道单选。
//  * 单选没有文字题干（题干在录音里），选项 label 文本形如 `A. xxx`；
//    `input[type=radio]` 的 `value` 是**原始选项序号**、`qOO` 是展示顺序映射，展示顺序即 A/B/C/D。
//  * 音频直链在 ucampus.cdn.unipus.cn，免 cookie（服务端可直下）。
import { log } from '../core/log';

export interface ExamOption {
  letter: string;
  text: string;
}

export interface ExamQuestion {
  /** 卷面题号（1 基，来自 `<b>1)</b>`） */
  num: number;
  options: ExamOption[];
  radios: HTMLInputElement[];
}

export interface ExamSet {
  qid: string;
  part?: string;
  sectionKey?: string;
  audioUrl: string;
  duration: number;
  questions: ExamQuestion[];
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function isExamHost(host: string = location.hostname): boolean {
  return /(^|\.)uexercise\.unipus\.cn$/.test(host);
}

/** 路由命中 + DOM 也要对：`.itest-ques-set` 是试题容器 */
export function isExamPage(): boolean {
  return isExamHost() && document.querySelectorAll('.itest-ques-set').length > 0;
}

function optionLetter(labelText: string, fallbackIndex: number): { letter: string; text: string } {
  const m = labelText.match(/^\s*([A-Z])[.、)]\s*([\s\S]*)$/);
  if (m) return { letter: m[1], text: m[2].replace(/\s+/g, ' ').trim() };
  return { letter: String.fromCharCode(65 + fallbackIndex), text: labelText.replace(/\s+/g, ' ').trim() };
}

/** 解析整页所有材料段（一段音频 + 若干题） */
export function examSets(): ExamSet[] {
  const out: ExamSet[] = [];
  const sets = Array.from(document.querySelectorAll('.itest-ques-set'));
  sets.forEach((set) => {
    const section = set.closest('.itest-section');
    const qid = set.getAttribute('questionid') || '';
    const resEl = set.querySelector('.itest-hear-reslist span');
    let audioUrl = '';
    let duration = 0;
    if (resEl) {
      try {
        const arr = JSON.parse((resEl.textContent || '').trim()) as unknown;
        if (Array.isArray(arr)) {
          audioUrl = String(arr[0] ?? '');
          duration = Number(arr[1] ?? 0) || 0;
        }
      } catch {
        audioUrl = '';
      }
    }

    const questions: ExamQuestion[] = [];
    set.querySelectorAll('.css-danxuan.row').forEach((row) => {
      const numText = (row.querySelector('.option-head .nu')?.textContent || '').replace(/[^0-9]/g, '');
      const num = Number(numText) || questions.length + 1;
      const radios = Array.from(row.querySelectorAll('input[type=radio]')) as HTMLInputElement[];
      if (!radios.length) return;
      const options = radios.map((r, i) => {
        const label = r.closest('label')?.textContent || '';
        return optionLetter(label, i);
      });
      questions.push({ num, options, radios });
    });

    if (questions.length) {
      out.push({
        qid,
        part: section?.getAttribute('part1') || undefined,
        sectionKey: section?.getAttribute('sectionKey') || undefined,
        audioUrl,
        duration,
        questions,
      });
    }
  });
  return out;
}

/** 已选中的选项字母（没选返回 null） */
export function checkedLetter(q: ExamQuestion): string | null {
  const i = q.radios.findIndex((r) => r.checked);
  return i >= 0 ? q.options[i]?.letter ?? null : null;
}

/** 还没选答案的题号 */
export function emptyExamQuestions(): number[] {
  const out: number[] = [];
  examSets().forEach((s) => {
    s.questions.forEach((q) => {
      if (checkedLetter(q) === null) out.push(q.num);
    });
  });
  return out;
}

/** 按题号 → 字母点选；返回成功填写的题数 */
export async function fillExamByNumber(answers: Record<number, string>, stepMs = 160): Promise<number> {
  let filled = 0;
  for (const set of examSets()) {
    for (const q of set.questions) {
      const want = answers[q.num];
      if (!want) continue;
      const idx = q.options.findIndex((o) => o.letter === want.toUpperCase());
      if (idx < 0) {
        log(`第 ${q.num} 题的选项里没有 ${want}`);
        continue;
      }
      const radio = q.radios[idx];
      if (!radio) continue;
      radio.scrollIntoView({ block: 'center' });
      radio.click();
      if (!radio.checked) {
        // 少数情况下合成点击不生效 → 直接置位并派发事件，让页面自己的 change 处理器记账
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        radio.dispatchEvent(new Event('click', { bubbles: true }));
      }
      if (radio.checked) filled += 1;
      await sleep(stepMs);
    }
  }
  return filled;
}

/* ------------------------------ 提交 ------------------------------ */

export function examSubmitButton(): HTMLElement | null {
  const list = Array.from(document.querySelectorAll('div.submit, .submit, a.submit, button.submit')) as HTMLElement[];
  return list.find((e) => /提交|交卷/.test((e.textContent || '').trim())) ?? null;
}

/** 弹出层文字（layui / 页面自绘） */
export function examDialogText(): string {
  const nodes = Array.from(
    document.querySelectorAll('.layui-layer, .layui-layer-content, .Popup, .popup-zz, .alert'),
  ) as HTMLElement[];
  return nodes
    .filter((e) => (e.offsetParent !== null || e.getClientRects().length > 0) && (e.textContent || '').trim().length > 0)
    .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
    .join(' | ')
    .slice(0, 400);
}

/** 在弹出层里点指定文案的按钮 */
export async function clickExamDialogButton(labels: string[], timeoutMs = 8000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const nodes = Array.from(
      document.querySelectorAll('.layui-layer a, .layui-layer button, .layui-layer span, .Popup a, .Popup span, .Popup button, .success-sure'),
    ) as HTMLElement[];
    const hit = nodes.find((e) => {
      const t = (e.textContent || '').trim();
      return labels.includes(t) && (e.offsetParent !== null || e.getClientRects().length > 0);
    });
    if (hit) {
      hit.click();
      return (hit.textContent || '').trim();
    }
    await sleep(200);
  }
  return '';
}

export interface ExamSubmitResult {
  ok: boolean;
  message: string;
}

/**
 * 交卷：点「提交」→ 读弹窗 → 只有弹窗**不含**未完成/未作答字样才点确定，再处理第二层确认。
 * 绝不为了「强行提交」而点掉校验提示。
 */
export async function submitExamPage(): Promise<ExamSubmitResult> {
  const btn = examSubmitButton();
  if (!btn) return { ok: false, message: '页面上没找到「提交」按钮' };

  const before = examDialogText();
  btn.click();
  await sleep(1200);

  let dlg = examDialogText();
  if (!dlg || dlg === before) {
    await sleep(1500);
    dlg = examDialogText();
  }
  log(`提交弹窗：${dlg || '（没看到弹窗）'}`);

  if (/未作答|未完成|还有\s*\d+\s*(个)?(空|题)|请完成/.test(dlg)) {
    return { ok: false, message: `站点拒绝了提交：${dlg.slice(0, 120)}` };
  }

  // 第一层：确认（确定/是/提交）
  const first = await clickExamDialogButton(['确定', '确认', '是', '提交'], 6000);
  if (first) log(`点了弹窗按钮：${first}`);
  await sleep(1000);

  // 第二层：真正交卷确认
  const dlg2 = examDialogText();
  if (/交卷|提交后|不能再|确认/.test(dlg2)) {
    log(`二次确认：${dlg2.slice(0, 120)}`);
    const second = await clickExamDialogButton(['确定', '确认', '交卷'], 6000);
    if (second) log(`点了二次确认：${second}`);
  }

  await sleep(1500);
  const after = examDialogText();
  const left = /提交成功|交卷成功|已交卷|考试结束|查看解析|成绩/.test(after) || !examSubmitButton();
  if (left) return { ok: true, message: after.slice(0, 120) || '已提交' };
  return { ok: false, message: after ? `结果未知：${after.slice(0, 120)}` : '点完提交后页面没有明显反馈（可能已提交）' };
}
