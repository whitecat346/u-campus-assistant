// 题目解析与作答（实测选择器，见 docs/PAGE-MAP.md §4.1）。
// 原则：**只驱动 UI，不伪造接口**。点 radio / 填 textarea 后由页面自身生成提交体，
// 因此无需构造 state / qid / version 等内部字段（这些字段实测存在但由前端维护）。

export interface Option {
  caption: string;
  /** 已去标签的选项文字 */
  label: string;
}

export interface Question {
  index: number;
  stem: string;
  options: Option[];
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 从截获的内容数据读取题目（优先，文本最干净） */
export function questionsFromContent(content: unknown): Question[] {
  const c = content as { questions?: Array<{ content?: { html?: string }; options?: Array<{ caption?: string; content?: { html?: string } }> }> };
  const qs = c?.questions ?? [];
  return qs.map((q, i) => ({
    index: i,
    stem: stripHtml(q.content?.html).replace(/^\d+\.\s*/, ''),
    options: (q.options ?? []).map((o) => ({ caption: String(o.caption ?? '').trim(), label: stripHtml(o.content?.html) })),
  }));
}

/** 内容里的听力原文（实测随内容下发，见 PAGE-MAP §4.2） */
export function transcriptFromContent(content: unknown): string {
  const c = content as { content?: Array<{ audio?: { script?: { html?: string } } }> };
  const parts = (c?.content ?? []).map((m) => stripHtml(m?.audio?.script?.html)).filter(Boolean);
  return parts.join('\n\n');
}

export function audioUrlFromContent(content: unknown): string | null {
  const c = content as { content?: Array<{ audio?: { audio?: { url?: string } } }> };
  for (const m of c?.content ?? []) {
    const u = m?.audio?.audio?.url;
    if (u) return u.split('#')[0];
  }
  return null;
}

/* ------------------------------- DOM 侧 ------------------------------- */

/** 页面上的单选组：name → input 列表（实测 name 形如 single-1 … single-10） */
export function radioGroups(): Map<string, HTMLInputElement[]> {
  const map = new Map<string, HTMLInputElement[]>();
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=radio]'));
  for (const inp of inputs) {
    const arr = map.get(inp.name) ?? [];
    arr.push(inp);
    map.set(inp.name, arr);
  }
  return new Map([...map.entries()].sort((a, b) => groupOrder(a[0]) - groupOrder(b[0])));
}

function groupOrder(name: string): number {
  const m = name.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/** 是否有客观选择题可填 */
export function hasObjectiveQuestions(): boolean {
  return radioGroups().size > 0;
}

/**
 * 按题目序号填答案。answers 的 key 是题目序号（0 基）。
 * 返回实际点中的题数。
 */
export function applyChoices(answers: Record<number, string>, stepDelayMs = 200): number {
  const groups = [...radioGroups().values()];
  let n = 0;
  groups.forEach((inputs, i) => {
    const want = answers[i];
    if (!want) return;
    const target = inputs.find((x) => x.value.toUpperCase() === String(want).toUpperCase());
    if (!target) return;
    window.setTimeout(() => {
      target.click();
    }, i * stepDelayMs);
    n += 1;
  });
  return n;
}

export function checkedAnswers(): Record<number, string> {
  const groups = [...radioGroups().values()];
  const out: Record<number, string> = {};
  groups.forEach((inputs, i) => {
    const hit = inputs.find((x) => x.checked);
    if (hit) out[i] = hit.value;
  });
  return out;
}

/* ------------------------------ 题型识别 ------------------------------ */

export type TaskKind = 'listening' | 'speaking' | 'writing' | 'reading' | 'unknown';

/**
 * 识别当前 group 的任务类型。判据来自实测：
 *  * 录音组件 button.record（+ .play/.replay）→ 说
 *  * textarea / contenteditable 文本域 → 写（简答）
 *  * 单选 radio → 听/客观
 *  * 只有正文无题 → 阅读材料
 */
export function detectTaskKind(): TaskKind {
  const record = document.querySelector('button.record, [class*="record--btn"], [class*="readaloud"] button');
  const text = document.querySelector('textarea, [contenteditable="true"], input[type=text]');
  const radios = radioGroups().size;
  const audio = document.querySelector('audio');
  if (record) return 'speaking';
  if (radios > 0) return 'listening';
  if (text) return 'writing';
  if (audio) return 'listening';
  if (document.body.innerText.trim().length > 200) return 'reading';
  return 'unknown';
}

/** 页面是否还有可点击的「提交」并且可用 */
export function submitButton(): HTMLButtonElement | null {
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return btns.find((b) => (b.innerText || '').trim() === '提交' && !b.disabled) ?? null;
}

/** 页面上的口语题提示（说类的题干，用于生成短稿） */
export function speakingPromptText(): string {
  const el = document.querySelector('[class*="individualpresentation"], [class*="oral"], [class*="roleplay"]');
  const box = (el as HTMLElement | null)?.innerText?.trim();
  const body = document.body.innerText.trim();
  return (box && box.length > 20 ? box : body).slice(0, 3000);
}

/* ---------------------------- 文本输入（写作/简答） ---------------------------- */

export function textInputs(): Array<HTMLTextAreaElement | HTMLElement> {
  const areas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'));
  const edits = Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]'));
  return [...areas, ...edits];
}

/** 用「原生 setter + input 事件」写入，React 受控组件才会更新 state */
export function fillTextArea(el: HTMLTextAreaElement | HTMLElement, value: string): boolean {
  try {
    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === value;
    }
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    return true;
  } catch {
    return false;
  }
}

/** 从内容里抽取写作题的要求文本 */
export function writingPromptFromContent(content: unknown): string {
  const c = content as { questions?: Array<{ content?: { html?: string } }>; prompt?: string };
  if (typeof c?.prompt === 'string' && c.prompt.trim()) return stripHtml(c.prompt);
  const qs = (c?.questions ?? []).map((q) => stripHtml(q.content?.html)).filter(Boolean);
  if (qs.length) return qs.join('\n');
  return '';
}
