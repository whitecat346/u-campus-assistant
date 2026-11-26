// 抓取「解密后的内容」。
// 实测结论（docs/PAGE-MAP.md §4.2）：/course/api/v3/content/... 返回 `unipus.<hex>`，
// 由页面自身解密后再 JSON.parse。
// 关键工程约束：Tampermonkey 声明了 @grant → 脚本运行在**隔离世界**（isolated world），
// 直接改本世界 JSON.parse **影响不到页面**。因此这里把钩子代码注入页面世界（<script>），
// 页面侧把截获结果以 CustomEvent(detail 为 JSON 字符串) 发回隔离世界。
// 必须在 document-start 执行（vite.config 的 run-at: document-start）。

export interface CapturedContent {
  keys: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  at: number;
}

const CAP: CapturedContent[] = [];
const MAX = 30;
let installed = false;

// 关键：先抓住「未被污染的」JSON.parse。
// 实测教训：Tampermonkey 的沙箱里 JSON 与页面同源（同一个函数对象），
// 若这里用 JSON.parse 解析 detail，会再次触发我们注入的页面钩子 → 无限递归
// （Uncaught RangeError: Maximum call stack size exceeded）。
const nativeParse: typeof JSON.parse = JSON.parse.bind(JSON);

const HOOK_SOURCE = `(() => {
  if (window.__ucHookInstalled) return;
  window.__ucHookInstalled = true;
  var orig = JSON.parse;
  window.__ucCap = [];
  var lastJson = '', lastAt = 0;
  function isContent(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    var ks = Object.keys(o);
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      if (k === 'questions:questions') return true;
      // 其它题目型内容：实测还有 questions:scoopquestions（听录音补全句子）
      if (k.indexOf('questions:') === 0) return true;
      if (/individualpresentation|discussion|readaloud|shortanswer|roleplay|purecontent|presentation/i.test(k)) return true;
    }
    return false;
  }
  JSON.parse = function (text, reviver) {
    var out = orig.call(JSON, text, reviver);
    try {
      if (isContent(out)) {
        var payload = JSON.stringify(out);
        // 去重：同一份内容在 1s 内不重复派发，彻底切断任何形式的回环
        var now = Date.now();
        if (payload === lastJson && now - lastAt < 1000) return out;
        lastJson = payload;
        lastAt = now;
        window.__ucCap.push({ keys: Object.keys(out), json: payload, at: now });
        if (window.__ucCap.length > 30) window.__ucCap.shift();
        document.dispatchEvent(new CustomEvent('uc:content', { detail: payload }));
      }
    } catch (e) { }
    return out;
  };
})();`;

export function installCapture(): void {
  if (installed) return;
  installed = true;

  // ① 隔离世界侧：接收页面世界的事件
  document.addEventListener('uc:content', (ev) => {
    const detail = (ev as CustomEvent<string>).detail;
    if (typeof detail !== 'string') return;
    try {
      const value = nativeParse(detail);
      if (CAP.length >= MAX) CAP.shift();
      CAP.push({ keys: Object.keys(value ?? {}), value, at: Date.now() });
    } catch {
      /* ignore */
    }
  });

  // ② 页面世界侧：注入钩子
  const inject = () => {
    const s = document.createElement('script');
    s.textContent = HOOK_SOURCE;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  };
  inject();
  // 有些站点会在 DOMContentLoaded 前替换 JSON.parse，再补一次（幂等）
  document.addEventListener('DOMContentLoaded', inject, { once: true });
}

/** 最近一次截获的「题目型」内容（questions:* 结构，如 questions:questions / questions:scoopquestions） */
export function latestQuestionsContent<T = Record<string, unknown>>(): T | null {
  for (let i = CAP.length - 1; i >= 0; i--) {
    const v = CAP[i].value as Record<string, unknown>;
    if (!v || typeof v !== 'object') continue;
    const k = Object.keys(v).find((x) => x.indexOf('questions:') === 0);
    if (k) return v[k] as T;
  }
  return null;
}

export function latestAnyContent(): CapturedContent | null {
  return CAP.length ? CAP[CAP.length - 1] : null;
}

/** 最近一次截获内容的键名（用来判定题型：speaking/writing 的键各不相同） */
export function latestKeys(): string[] {
  const last = CAP[CAP.length - 1];
  return last ? last.keys : [];
}

export function captureCount(): number {
  return CAP.length;
}

export function clearCapture(): void {
  CAP.length = 0;
}

/** 等待「新的」截获（批量模式翻页后判断新内容是否已到） */
export async function waitForNewCapture(from: number, timeoutMs = 25000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (CAP.some((c) => c.at >= from)) return true;
    await new Promise((r) => window.setTimeout(r, 250));
  }
  return false;
}

/** 等待题目内容出现（页面切题/刷新后会重新下发；只读数据，不改页面） */
export async function waitForQuestions(timeoutMs = 20000, from = Date.now()): Promise<Record<string, unknown> | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const fresh = CAP.length > 0 && CAP[CAP.length - 1].at >= from;
    const v = latestQuestionsContent();
    if (v && fresh) return v;
    await new Promise((r) => window.setTimeout(r, 300));
  }
  return latestQuestionsContent();
}
