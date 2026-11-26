// 页面识别（实测定型，见 docs/PAGE-MAP.md §4）。
// 事实：答题页 = https://ucontent.unipus.cn/_pc_default/pc.html?...#/<courseId>/courseware/<unit>/<node>/<group>/<child>/p_<n>
// 目录页 = u.unipus.cn/user/student/mycourse/courseCatalog；门户 = u.unipus.cn 其它
import { parseAnswerRoute } from '../core/api';

// exam = 作业与测试系统（uexercise.unipus.cn），见 docs/PAGE-MAP.md §14
export type PageKind = 'unknown' | 'portal' | 'catalog' | 'answering' | 'exam';

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

/** 答题容器存在性（路由命中还不够，DOM 也要对） */
export function hasAnswerRoot(): boolean {
  return !!(
    document.querySelector('div[class*="questions--question-"]') ||
    document.querySelector('button[class*="submit-bar-pc--btn"]') ||
    document.querySelector('button.record') ||
    document.querySelector('[class*="individualpresentation"]')
  );
}

export function canStartAnswering(kind: PageKind = detectPage()): boolean {
  return kind === 'answering';
}

/** 监听 SPA 路由变化（hash 路由，popstate + 轮询双保险） */
export function onPageChange(fn: (kind: PageKind) => void): () => void {
  let last = detectPage();
  const fire = () => {
    const now = detectPage();
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
