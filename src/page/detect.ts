// 页面识别（docs/DESIGN.md §4 + §9 已知未知 1）。
// 路由白名单必须勘察真实站点后补全；此处只做「保守判定」：识别不出就当普通页面，
// 面板只显示设置，绝不显示「开始作答」。

export type PageKind = 'unknown' | 'portal' | 'course-home' | 'answering' | 'exam';

/** 待勘察确认后填入。例：/homework/、/test/、/unit/ */
const ANSWERING_PATTERNS: RegExp[] = [];

export function detectPage(url: string = location.href): PageKind {
  const u = url.toLowerCase();
  if (!/\.unipus\.cn/.test(new URL(u).hostname)) return 'unknown';
  if (ANSWERING_PATTERNS.some((re) => re.test(u))) return 'answering';
  if (/uschool\.unipus\.cn/.test(u)) return 'course-home';
  return 'portal';
}

/** 答题容器的存在性校验——路由命中但 DOM 不对时仍视为不可作答 */
export function hasAnswerRoot(): boolean {
  // 待勘察：真实容器选择器
  return false;
}

export function canStartAnswering(kind: PageKind = detectPage()): boolean {
  return kind === 'answering' && (hasAnswerRoot() || ANSWERPAGE_ROUTE_ONLY);
}

/** 勘察前：仅按路由判断（后续 DOM 校验就绪后置 false） */
const ANSWERPAGE_ROUTE_ONLY = true;

/** 监听 SPA 路由变化（老站点多为整页跳转，此钩子用于兼容前端路由） */
export function onPageChange(fn: (kind: PageKind) => void): () => void {
  let last = detectPage();
  const timer = window.setInterval(() => {
    const now = detectPage();
    if (now !== last) {
      last = now;
      fn(now);
    }
  }, 1000);
  return () => window.clearInterval(timer);
}
