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

/* 实测坑：courseId 里含 `+` 与 `:`，**不能用 encodeURIComponent**。
   编码成 %2B 后服务端返回 {"code":2,"course":""}；原始字符串才正确。 */
export async function fetchCourseTree(courseId: string): Promise<CourseTree> {
  const r = await apiGet<{ code: number; course: string }>(`/course/api/course/${courseId}/default/`);
  if (!r.course) throw new ApiError('课程树为空（可能未登录或 courseId 错误）', 200, JSON.stringify(r).slice(0, 200));
  return JSON.parse(r.course) as CourseTree;
}

export interface LeafState {
  duration?: number;
  state?: { pass?: number; pass2?: number; perm?: number };
  strategies?: { end_time?: number | null; start_time?: number | null; required?: boolean; min_score_pct?: number };
  tab_type?: string;
}

/** 真实路径（抓包确认）：/course/api/v2/course_progress/{courseId}/{unit}/{openId}/default/ */
export async function fetchProgress(courseId: string, unit: string, openId: string): Promise<Record<string, LeafState>> {
  const r = await apiGet<{ rt?: { leafs?: Record<string, LeafState> } }>(
    `/course/api/v2/course_progress/${courseId}/${unit}/${openId}/default/`,
  );
  return r.rt?.leafs ?? {};
}

/** 不带 unit 的整课进度：/course_progress/{courseId}/{openId}/default/ */
export async function fetchAllProgress(courseId: string, openId: string): Promise<Record<string, LeafState>> {
  const r = await apiGet<{ rt?: { leafs?: Record<string, LeafState> } }>(`/course/api/v2/course_progress/${courseId}/${openId}/default/`);
  return r.rt?.leafs ?? {};
}

let cachedOpenId = '';

/** open_id：从 /auth/api/user 读（也可从 token payload 解出来） */
export async function getOpenId(): Promise<string> {
  if (cachedOpenId) return cachedOpenId;
  try {
    const t = getToken();
    const payload = t.split('.')[1];
    if (payload) {
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { open_id?: string };
      if (json.open_id) {
        cachedOpenId = json.open_id;
        return cachedOpenId;
      }
    }
  } catch {
    /* fallthrough */
  }
  const r = await apiGet<{ open_id?: string }>('/auth/api/user');
  cachedOpenId = r.open_id ?? '';
  return cachedOpenId;
}

export interface GroupMeta {
  name?: string;
  base?: string;
  contents?: Record<string, unknown>;
}

export async function fetchGroupMeta(courseId: string, groupId: string): Promise<GroupMeta | null> {
  const r = await apiGet<{ code: number; group: string }>(`/course/api/pc/group/${courseId}/${groupId}/default/`);
  if (!r.group) return null;
  return JSON.parse(r.group) as GroupMeta;
}

/** 把课程树摊平成「可作答单元」列表：unit → node → node → group(base) */
export interface CourseItem {
  unit: string;
  unitName: string;
  node: string;
  nodeName: string;
  path: string[];
  group: string;
  base: string;
  tabType: string;
  name: string;
}

export function flattenCourse(tree: CourseTree): CourseItem[] {
  const out: CourseItem[] = [];
  const walk = (unit: string, unitName: string, path: string[], nodeNames: string[], node: CourseNode, isUnit = false): void => {
    const kids = node.children ?? [];
    if (!isUnit && (node.base || !kids.length)) {
      // 终点：group（有 base）或没有子节点的节点
      if (path.length >= 3) {
        out.push({
          unit,
          unitName,
          node: path[0] ?? unit,
          nodeName: nodeNames[0] ?? '',
          path: [...path],
          group: node.url,
          base: node.base ?? '',
          tabType: node.tab_type ?? '',
          name: node.name,
        });
      }
      return;
    }
    const nextPath = isUnit ? path : [...path, node.url];
    const nextNames = isUnit ? nodeNames : [...nodeNames, node.name];
    for (const k of kids) walk(unit, unitName, nextPath, nextNames, k);
  };
  for (const unit of tree.units ?? []) {
    // 单元 → 其每个子节点走一遍（unit 自身不进 path）
    for (const child of unit.children ?? []) {
      walk(unit.url, unit.name, [], [], child);
    }
  }
  return out;
}

/** 由 CourseItem 生成 hash（unit/node/node/group → 实测就是这四段） */
export function itemToRoute(item: CourseItem, courseId: string): AnswerPageRoute {
  const seg = item.path.slice(0, 3);
  return {
    courseId,
    unit: item.unit,
    node: seg[0] ?? item.unit,
    group: seg[1] ?? item.group,
    child: seg[2] ?? item.group,
    page: 'p_1',
  };
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
