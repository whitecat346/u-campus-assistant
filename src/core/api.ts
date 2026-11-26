// U校园接口封装（实测定型，见 docs/PAGE-MAP.md §3/§6）。
// 关键事实：
//  * 答题/学习接口都在 ucontent.unipus.cn（与答题页同源）→ 直接 fetch 即可。
//  * 必须带 token 头 x-annotator-auth-token；该 token 就是 localStorage.jwtToke。
//  * 只有 u.unipus.cn 的 /user/data/getToken 是跨站 → 用 GM_xmlhttpRequest（绕 CORS）。

export const CONTENT_ORIGIN = 'https://ucontent.unipus.cn';

/** 与页面同源的 token（实测：登录后由 ucontent 域写入 localStorage.jwtToke） */
export function getToken(): string {
  try {
    return localStorage.getItem('jwtToke') || '';
  } catch {
    return '';
  }
}

/** 兜底：向门户取 token（跨站，GM_xmlhttpRequest） */
export function fetchTokenFromPortal(): Promise<string> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://u.unipus.cn/user/data/getToken?_=${Date.now()}`,
      onload: (res) => {
        try {
          const j = JSON.parse(res.responseText) as { token?: string };
          if (j.token) resolve(j.token);
          else reject(new Error('getToken 未返回 token'));
        } catch (e) {
          reject(e as Error);
        }
      },
      onerror: () => reject(new Error('getToken 请求失败（跨站）')),
      ontimeout: () => reject(new Error('getToken 超时')),
    });
  });
}

export async function ensureToken(): Promise<string> {
  const t = getToken();
  if (t) return t;
  return fetchTokenFromPortal();
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function apiHeaders(): Promise<Record<string, string>> {
  const token = await ensureToken();
  return {
    appid: '5',
    'uni-client-ver': '12040',
    'x-annotator-auth-token': token,
    'x-csrftoken': csrf(),
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(CONTENT_ORIGIN + path, {
    method: 'GET',
    credentials: 'include',
    headers: await apiHeaders(),
  });
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status}`, res.status, (await res.text()).slice(0, 300));
  return (await res.json()) as T;
}

/* ------------------------------- 数据结构 ------------------------------- */

export interface CourseNode {
  name: string;
  url: string;
  role?: string;
  base?: string;
  tab_type?: string;
  question_num?: number | null;
  children?: CourseNode[];
}

export interface CourseUnit extends CourseNode {
  is_test?: number;
}

export interface CourseTree {
  name: string;
  units: CourseUnit[];
}

export async function fetchCourseTree(courseId: string): Promise<CourseTree> {
  const r = await apiGet<{ code: number; course: string }>(`/course/api/course/${encodeURIComponent(courseId)}/default/`);
  return JSON.parse(r.course) as CourseTree;
}

export interface LeafState {
  duration?: number;
  state?: { pass?: number; pass2?: number; perm?: number };
  strategies?: { end_time?: number | null; start_time?: number | null; required?: boolean; min_score_pct?: number };
  tab_type?: string;
}

export async function fetchProgress(courseId: string, unitOrOpenId: string, openId?: string): Promise<Record<string, LeafState>> {
  const unit = openId ? unitOrOpenId : unitOrOpenId;
  const r = await apiGet<{ rt?: { leafs?: Record<string, LeafState> } }>(
    `/course/api/v2/course_progress/${encodeURIComponent(courseId)}/${encodeURIComponent(unit)}/${encodeURIComponent(openId ?? '')}/default/`.replace('//default/', '/default/'),
  );
  return r.rt?.leafs ?? {};
}

/** 进度接口：unit 段传 openId 也可，二者都试（实测两种都能 200） */
export async function fetchProgressSafe(courseId: string, openId: string): Promise<Record<string, LeafState>> {
  const r = await apiGet<{ rt?: { leafs?: Record<string, LeafState> } }>(
    `/course/api/v2/course_progress/${encodeURIComponent(courseId)}/${encodeURIComponent(openId)}/default/`,
  );
  return r.rt?.leafs ?? {};
}

export interface GroupMeta {
  name?: string;
  base?: string;
  contents?: Record<string, unknown>;
}

export async function fetchGroupMeta(courseId: string, groupId: string): Promise<GroupMeta | null> {
  const r = await apiGet<{ code: number; group: string }>(`/course/api/pc/group/${encodeURIComponent(courseId)}/${encodeURIComponent(groupId)}/default/`);
  if (!r.group) return null;
  return JSON.parse(r.group) as GroupMeta;
}

/* --------------------------------- 当前页 -------------------------------- */

export interface AnswerPageRoute {
  courseId: string;
  unit: string;
  node: string;
  group: string;
  child: string;
  page: string;
}

/** 解析 hash： #/<courseId>/courseware/<unit>/<node>/<group>/<child>/p_<n> */
export function parseAnswerRoute(href = location.href): AnswerPageRoute | null {
  const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
  const m = hash.match(/^\/([^/]+)\/courseware\/([^/]+)\/([^/]+)\/([^/?#]+)(?:\/([^/?#]+))?(?:\/(p_\d+))?/);
  if (!m) return null;
  return { courseId: m[1], unit: m[2], node: m[3], group: m[4], child: m[5] || '', page: m[6] || 'p_1' };
}

export function buildAnswerHash(r: AnswerPageRoute): string {
  const tail = r.child ? `/${r.child}` : '';
  return `#/${r.courseId}/courseware/${r.unit}/${r.node}/${r.group}${tail}/${r.page}`;
}

/** 直接在 SPA 内跳转到某个 group（实测：整页 navigate 会被弹回目录，hash 变更可用） */
export function navigateToGroup(r: AnswerPageRoute): void {
  location.hash = buildAnswerHash(r);
}
