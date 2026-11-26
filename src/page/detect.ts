// 页面识别（实测定型，见 docs/PAGE-MAP.md §4）。
// 事实：答题页 = https://ucontent.unipus.cn/_pc_default/pc.html?...#/<courseId>/courseware/<unit>/<node>/<group>/<child>/p_<n>
// 目录页 = u.unipus.cn/user/student/mycourse/courseCatalog；门户 = u.unipus.cn 其它
import { parseAnswerRoute } from '../core/api';

// exam = 作业与测试系统（uexercise.unipus.cn），见 docs/PAGE-MAP.md §14
export type PageKind = 'unknown' | 'portal' | 'catalog' | 'answering' | 'exam';

/** 考试容器存在性：uexercise 的试题始终以 `.itest-ques-set` 渲染 */
export function hasExamRoot(): boolean {
  return document.querySelectorAll('.itest-ques-set').length > 0;
}

export function detectPage(url: string = location.href): PageKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unknown';
  }
  if (!/(^|\.)unipus\.cn$/.test(u.hostname)) return 'unknown';
  if (u.hostname === 'ucontent.unipus.cn' && u.pathname.includes('/pc.html') && parseAnswerRoute(url)) return 'answering';
  // 考试页：enter_unit_test 落地后整卷渲染在同一页（uexercise 域）
  if (/(^|\.)uexercise\.unipus\.cn$/.test(u.hostname)) return 'exam';
  if (u.hostname === 'u.unipus.cn' && /\/student\/mycourse\/courseCatalog/.test(u.pathname)) return 'catalog';
  return 'portal';
}

/**
 * 结合 DOM 的页面判定。
 * 实测坑（2026-11-26）：课程页点「开始做题」→ 考试在**新窗口/内嵌层**里打开，
 * 有的是 `window.open` 后 document.write（`location.href` 仍是 about:blank），
 * 只按 URL 判断会把考试页当 unknown → 面板只剩设置。所以 DOM 命中直接认。
 */
export function detectPageWithDom(url: string = location.href): PageKind {
  const byUrl = detectPage(url);
  if (byUrl === 'exam' || byUrl === 'answering') return byUrl;
  if (hasExamRoot()) return 'exam';
  if (hasAnswerRoot()) return 'answering';
  return byUrl;
}

/** 答题容器存在性（路由命中还不够，DOM 也要对） */
export function hasAnswerRoot(): boolean {
  return !!(
    document.querySelector('div[class*="questions--question-"]') ||
    document.querySelector('button[class*="submit-bar-pc--btn"]') ||
    document.querySelector('button.record') ||
    document.querySelector('[class*="individualpresentation"]')
  );
}

export function canStartAnswering(kind: PageKind = detectPageWithDom()): boolean {
  return kind === 'answering' || kind === 'exam';
}

/** 监听 SPA 路由变化（hash 路由，popstate + 轮询双保险）；DOM 变化也靠轮询兜住 */
export function onPageChange(fn: (kind: PageKind) => void): () => void {
  let last = detectPageWithDom();
  const fire = () => {
    const now = detectPageWithDom();
    if (now !== last) {
      last = now;
      fn(now);
    }
  };
  window.addEventListener('hashchange', fire);
  window.addEventListener('popstate', fire);
  const timer = window.setInterval(fire, 1000);
  return () => {
    window.removeEventListener('hashchange', fire);
    window.removeEventListener('popstate', fire);
    window.clearInterval(timer);
  };
}
