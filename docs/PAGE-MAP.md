# PAGE-MAP — U校园 页面与接口实测地图（M1 勘察结果）

> 采集时间：2026-11-26 19:20–19:45（Asia/Shanghai）。账号：示例用户（openId `<OPENID>`），学校 school_id `<SCHOOL_ID>`。
> 本文只记录**实测到的事实**（DOM 选择器、接口、字段）。未验证的一律标注「待验证」，不臆造。

## 0. 拓扑：三个不同的站点

| 站点 | 角色 | 说明 |
|---|---|---|
| `https://u.unipus.cn` | 学生门户 / 课程目录（旧 jQuery + React 混装） | 登录态、`/user/data/getToken`（发 token）、`user/student/mycourse/courseCatalog` 目录页 |
| `https://sso.unipus.cn` | 统一登录 | `/sso/login?service=https%3A%2F%2Fu.unipus.cn%2Fuser%2Fcomm%2Flogin%3Fschool_id%3D`；字段 `input[name=username]`、`input[name=password]`、`input[name=rememberMe]`、`input#mfa-code`（动态码，默认隐藏） |
| `https://ucontent.unipus.cn` | **学习/答题 SPA**（React + CSS Modules） | `/_pc_default/pc.html?cid=<classId>&appid=5&schId=<schoolId>#/<courseId>/courseware/<unit>/<node>/<group>/<child>/p_<n>` |
| `https://ucontent.cdn.unipus.cn`、`http://course.media.unipus.cn` | 静态资源 CDN | 音频 mp3（`.../resource/audio/<sha>_96k.mp3#duration=73.5&t=.mp3`） |

**关键**：用户脚本要同时匹配 `*.unipus.cn`（现有 vite 配置已覆盖），核心逻辑主要跑在 `ucontent.unipus.cn` 的 hash 路由上。

## 1. 登录与身份

- 未登录时门户页右上为 `div#SignIn`（登录）与 `div#register`，点击 `#SignIn` 跳 sso 登录页。
- 登录成功后落到 `https://u.unipus.cn/user/student?school_id=<SCHOOL_ID>`。
- 相关 cookie（`ucontent.unipus.cn` / `u.unipus.cn`）：`jwt`、`sessionid`、`csrftoken`、`ucamUserId`、`ucamUserToken`、`ucontent`、`SSOExpireTime`、`hostUrl`、`stu_return_from_content`。
- **答题接口鉴权 token**：`GET https://u.unipus.cn/user/data/getToken?_=<ts>` → `{"openId":"…","token":"<JWT>"}`；该 token 作为请求头 `x-annotator-auth-token` 使用。
  - 在 `ucontent.unipus.cn` 上它已缓存在 **`localStorage.jwtToke`**（纯字符串），响应无效时回落到 `getToken`。
- `GET https://ucontent.unipus.cn/auth/api/user`（同源，带 cookie）→ `{ssoExpireTime,user_id,anonymous_id,open_id,session_id,user,email}`，**不含 token**。

## 2. 课程目录页（`u.unipus.cn/user/student/mycourse/courseCatalog`）

URL 形如：
```
/user/student/mycourse/courseCatalog?courseId=1625&school_id=<SCHOOL_ID>&eccId=<ECC_ID>&classId=<CLASS_ID>&coursetype=0
```
- 入口在门户页 `div.class-content > div.course-content > div.my_course_item[tutorialid]`，其内部 `span.hideurl` 存着上面这条 URL（即「不需要猜 URL」）。
- 目录页是 React 渲染：`li.group.courseware` 为每个小节，内部结构：
  - **必修标记**：`div.requiredArea > div.requiredStyle > i.icon-bixiu`（存在即必修）
  - **完成标记**：`span.catalogIcon.studentStyle > i.icon-yiwancheng-`（存在即已完成）
  - 点击进入：`span.name > a[title="4-4 Listen to understand"]`
- 课程结构接口（ucontent）：`GET /course/api/course/{courseId}/default/` → `{code, course: "<JSON 字符串>", version, publish_version, k, config}`
  - `JSON.parse(course)` → `{units:[{name,url,is_test,image,caption,role,children:[{name,url,question_num,suggestedDuration,role,children:[{name,url,ref-out,tab_type,question_num,base,role}]}]}]}`
  - 实测本课程：10 个 unit（`u1`…`u8`、`u9`=Midterm、`u10`=Final），每 unit 10 个 node，node 下挂 1–4 个 group（group 才是真正可作答单位）。

## 3. 进度 / 必修 / 截止时间 —— 权威来源（已验证）

```http
GET https://ucontent.unipus.cn/course/api/v2/course_progress/{courseId}/{unit|openId}/default/
Headers: appid: 5
         uni-client-ver: 12040
         x-annotator-auth-token: <token>
Credentials: include
```
响应 `rt` 结构：
```jsonc
{
  "rt": {
    "leafs": {                       // key = groupId，如 "u4g258"
      "u4g258": {
        "duration": 0,
        "state": { "pass": 0|1|2, "pass2": 0|1|2, "perm": 1 },
        "strategies": { "end_time": 1792857599|null, "min_score_pct": 0, "required": true, "start_time": null, "statistic_mode_out": false },
        "tab_type": "task" | "text"
      }
    },
    "micros": { "u4/u4g256": { "state": {...}, "strategies": {...} } },   // key = nodeId
    "open_id": "…", "publish_version": "73826", "tutorialId": "…", "unit_id": "u4"
  },
  "flag": "{\"lastSubmit\":1793943739,\"sdk\":1}"   // 顶层字段，字符串
}
```
- `strategies.required === true` → **必修**（唯一可信判据）
- `state.pass > 0` → **已完成**；`0` → 未完成（`pass` 出现过 1 和 2，语义待验证，判断用 `>0`）
- `strategies.end_time`（unix 秒）→ **截止时间**；`null` = 无截止
- `tab_type`: `"task"` = 需作答，`"text"` = 纯阅读

### 实测课程现状（2026-11-26）
| unit | 必修总数 | 未完成必修 | 截止 |
|---|---|---|---|
| u1 | 20 | 0 | 2026-10-24（已过，提交不计分）|
| u2 | 20 | 0 | 2026-10-25（已过）|
| u3 | 20 | 0 | 无 |
| **u4–u8** | 各 20 | **各 20** | 无 |
| **u9 (Test 1 Midterm)** | 6 | **6** | 无 |
| **u10 (Test 2 Final)** | 6 | **6** | 无 |

→ 当前可做：**u4–u8 共 100 个 + 两个测试 12 个 = 112 个必修任务**。
> 进入页面时若该单元截止时间已过，页头显示 `p.taskTipStyle--warningheadertext-*`：「学习截止时间已过，你可以继续学习，但本次提交得分不计入学习成绩」，以及「本单元学习时间：YYYY-MM-DD截止 / 是否必修：必修|非必修」。

## 4. 答题页（`ucontent.unipus.cn/_pc_default/pc.html…#/…`）

hash 段：`/<courseId>/courseware/<unit>/<node>/<group>/<child>/p_<page>`，例如
`#/course-v1:Unipus+CELS_2nd_1+202309/courseware/u4/u4g256/u4g257/u4g258/p_1`

### 4.1 DOM（CSS Modules，class 带 5 位哈希后缀 → **必须用前缀选择器**）
| 目标 | 选择器 |
|---|---|
| 题干容器 | `div[class*="questions--question-"]` |
| 单选题选项 | `input[type=radio][name="single-<n>"][value="A|B|C|D"]`，文案在 `label .single-choice--content-*` |
| 选项列表 | `ul[class*="single-choice--options"]` |
| 提交按钮 | `button[class*="submit-bar-pc--btn"]`（文案「提交」，页面加载即存在且可用） |
| 提交条 | `div[class*="submit-bar-pc--container"]`、`div[class*="submitContainer"]` |
| 音频播放器 | `audio` 元素 + `button[class*="audio--aplayer-play"]`、`-stop-`、`-mute-` |
| 听力原文开关 | `button[class*="audio-material--btn"]`（「Words & Tips」「Scripts」；**Scripts 提交前 disabled**） |
| 必修角标 | `span[class*="taskTipStyle--required"]`（文本「必修」）|
| 截止警告 | `p[class*="taskTipStyle--warningheadertext"]` |
| 录音组件 | `button.record`（+ `.play` / `.replay`）——**「说」类任务的可靠 DOM 特征** |
| 返回目录 | `a.topTab`（文本「目录」）|
| 弹窗按钮 | `button.dialogCloseButton`、`button.okButton`（「确定」）|

- 单选按钮可用 `el.click()` 触发 React onChange（实测：点击后 `checked` 变为 true）。
- 工具条按钮（`确定`/`X`）在页面加载时就已存在于 DOM（弹窗模板），需按可见性判断。

### 4.2 解密后的内容（已用 `JSON.parse` 钩子截获，`content.0.audio.script` 内含听力原文）
内容接口返回 **加密载荷**：`GET /course/api/v3/content/{courseId}/{groupId}/default/` → `{"code":0,"content":"unipus.<hex>…"}`，前端解密后 `JSON.parse` 得到：
```jsonc
{ "questions:questions": {
    "direction": { "title": "Directions:", "directionContent": { "html": "…", "resources": [] }, "pcVisiable": 1 },
    "content": [ {                        // 材料块
        "html": null,
        "audio": { "audio": { "url": "http://course.media.unipus.cn/…_96k.mp3#duration=73.5&t=.mp3", "url_aac": "", "duration": 73.5 },
                   "parts": [ { "words": { "name": "Word bank", "WordList": [ {"word":"<p>interaction</p>","audio":"…","explanations":[…] } ] } } ],
                   "script": { "html": "<p>People with social anxiety seem to benefit …</p>" } },   // ★ 听力原文全文
        "video": null, "highlight": null } ],
    "questions": [ { "content": {"html":"<p>1. What is the main idea…?</p>"},
                     "options": [ {"caption":"A","content":{"html":"<p>…</p>"}}, … ],
                     "answers": [],            // ★ 实测为空数组：**接口不下发正确答案**
                     "analysis": {"html":"","resources":null} } ],   // 解析也为空
    "category": "singlechoice", "score": 1, "analysis": { "html": "", "resources": null } } }
```
**结论（关键）**
1. 正确答案**不在**下发数据里（`answers: []`、`analysis` 为空）→ 必须自己判题（LLM），符合 DESIGN 决策 5 的兜底分支。
2. 但**听力原文 `audio.script.html` 是随内容下发的**（实测 u4g258 拿到整段 transcript）。
3. 音频直链 `http(s)://course.media.unipus.cn/…mp3` 与 `ucontent.cdn.unipus.cn` 均可取（待验证是否需要 cookie，见 §7）。

## 5. 任务类型清单（112 个未完成必修任务的 `group.base` 实测分布）

| `base` 模板 | 数量 | 组件类型（group JSON） | 归类 | 处理策略 |
|---|---|---|---|---|
| `objectivesimple_pc` | 56 | `Questions` + `FooterPanel/SubmitBar` | 听/客观题 | 自动作答 + 提交 |
| `objectivesimple_scoop_pc` | 13 | 同上（含 scoop 变体） | 听/客观题 | 自动作答 + 提交 |
| `sentencerecord_pc` | 12 | `ReadAloud` / record | **说（跟读）** | 跳过（出短稿仅供参考）|
| `magic_6160293_1691129012959_341` | 10 | `IndividualPresentationPc` / `individualpresentation-course` | **说（个人陈述）** | 出短稿，不提交 |
| `discussion_pc` | 4 | `DiscussionPC` / `discussion` | 讨论（待验证输入形态） | 待验证 |
| `shortAnswer_multi_pc` | 3 | `Questions` + `shortanswer` + `WritingTransform` | 写作/简答（文字） | LLM 生成文本 + 提交 |
| `magic_19_1683792003539_643` | 2 | `IndividualPresentationPc` | **说（个人陈述）** | 出短稿，不提交 |
| `purecontent_pc` | 2 | `purecontent`（无题） | 阅读/视听材料 | 打开并停留即可 |
| `shortanswer_oral_presentation_pc` | 2 | `PCOralPresentation` + `shortanswer` | **说（口头陈述）** | 出短稿，不提交 |
| `presentation_question_pc` | 4 | `IndividualPresentationPc`（Test 1/2 的 Task 1–4） | **说（口语测试）** | 出短稿，不提交 |
| `roleplay_pc_old` | 2 | `RolePlay` + `RoleChoose`（Test Task 5） | **说（角色扮演）** | 出短稿，不提交 |
| `?`（`u9g683`,`u10g684`） | 2 | 接口返回 `{"code":1,"group":""}` | 未发布/需单独看 | 待验证 |

## 6. 其它同源接口（实测可用或待验证）

| 接口 | 说明 | 状态 |
|---|---|---|
| `GET /course/api/course/{courseId}/default/` | 课程结构（`course` 为 JSON 字符串） | ✅ 200 |
| `GET /course/api/v2/course_progress/{courseId}/{unit}/{openId}/default/` | 单元进度 | ✅ 200（需 token 头）|
| `GET /course/api/pc/group/{courseId}/{groupId}/default/` | 小节结构（`group` 为 JSON 字符串，含 `base`） | ✅ 200（需 token 头）|
| `GET /course/api/v3/content/{courseId}/{groupId}/default/` | 加密内容 `unipus.<hex>` | ✅ 200（需 token 头）|
| `GET /course/api/v3/clio/sig`、`/course/api/v3/clio/rate` | 解密相关（`k` 字段为空） | 观察到，未深挖 |
| `GET /course/api/pc/summary/…`、`/api/mobile/user_module/…` | 前端另有调用 | 需要 app 的 5 个头，暂不需要 |
| `GET /ucampus/course/api/homeworkList/{courseId}/{classId}` | 作业列表 | 观察到 |
| `GET /user/data/getToken` | 发 annotator token（u.unipus.cn 同源） | ✅ 200 |

**CORS 实测（重要）**
- 从 `u.unipus.cn` 页面 `fetch` ucontent 接口：**被 CORS 拦**（未认证路径无 `Access-Control-Allow-Credentials`）。
- 从 `ucontent.unipus.cn` 页面 `fetch` u.unipus.cn 的 `getToken`：**被 CORS 拦**（无 ACAO）。
- 同源 `fetch`（ucontent → ucontent）+ `x-annotator-auth-token` 头：**通**。
- 认证后的 ucontent 响应头含 `access-control-allow-origin: https://u.unipus.cn`、`allow-credentials: true`、`allow-headers: authorization,x-annotator-auth-token,uni-client-ver,u-app-id,u-openid,u-platform,u-school,x-csrftoken,content-type,appid`。
- → 跨站调用用 **`GM_xmlhttpRequest`**（已有 grant）绕开 CORS；同源直接 `fetch`。

## 7. 待验证（下一步）

1. ~~音频是否需要 cookie~~ → **已实测：不需要**。`GET https://ucontent.cdn.unipus.cn/edx/…_96k.mp3` 直接返回 `206 Partial Content`、`content-type: audio/mpeg`（无任何 cookie）。→ 服务端 `/asr/url` 可以直下。
2. 提交按钮点击后的确认弹窗与提交请求形态 → **已实测，见 §8**。
3. **提交后才下发正确答案**（`answers: ["C"]` 等）→ 已实测，见 §9。
4. `discussion_pc` 的实际输入形态（文本？录音？发帖？）→ 仍是待验证。
5. 测试页（`u9`/`u10`）是否有「开始测试」按钮/计时器/一次性提交 → 仍是待验证；`can_enter` 接口存在（`/course/api/can_enter/{…}`，返回 `{endTime,expired,required,startTime}`）但参数顺序未确认。
6. 是否要求音频「播放完成」才算学习时长（`state.duration` 恒为 0，暂未见门槛）→ 仍是待验证。

## 8. 提交契约（2026-11-26 真实提交实测，任务 `u4g251` 4-3 Activity 1）

**端点**
```http
POST https://ucontent.unipus.cn/course/api/v3/submit/{courseId}/{groupId}/
Headers: appid: 5
         uni-client-ver: 12040
         x-annotator-auth-token: <token>
         x-csrftoken: <cookie csrftoken>
         content-type: application/json
Credentials: include（same-origin）
```
**请求体（真实抓包，长度 3616 字节）**
```jsonc
{
  "enable_mistake": false,
  "version": "default",
  "record_version": "1795692990",
  "state": "{\"version\":\"1795692990\",\"p_1\":{\"c_1_1\":{\"student_answers\":{\"0\":\"A\",…,\"9\":\"A\"}}},\"__EXTEND_DATA__\":{\"__SUMMARY__\":{\"answerList\":{\"0\":{\"student_answer\":\"A\",\"isDone\":true,\"version\":\"v2\",\"rule\":\"eq\"},…}}}}",
  "specific_scores": [null,null,…],
  "answers": {
    "0": { "student_answer":"A","isDone":true,"version":"v2","rule":"eq",
           "user_answer": { "qid":"652c804ffd6fd1e485a7787a","rule":"eq",
                            "answer":{"index":0,"answer":"A","version":"v2"},
                            "content":"","id":"652c804ffd6fd1e485a7787a-0","offset":0 } }
  }
}
```
**响应**：`{"msg":"","code":0,"data":{"content":{"code":0,"content":"unipus.<hex>…"}}}`

**重要工程结论**：`state` / `answers` / `qid` / `record_version` 都是前端从**自己的对话状态**拼出来的，且 `record_version` 与页面 POST `/api/mobile/user_module/{courseId}/{groupId}-{ts}/` 的 ts 同源。→ 脚本**不要伪造这个 body**，正确做法是「像人一样点 radio + 点提交」，让前端自己生成。已按此实现（`userscript/src/page/submit.ts`）。

**提交时的附带请求（前端自动发）**
- `POST /api/mobile/user_module/{courseId}/{groupId}-review-version/`
- `POST /api/mobile/user_module/{courseId}/{groupId}-{记录时间戳}/`
- `POST /api/mobile/user_module/{courseId}/{groupId}-first-version/`

**弹窗顺序（实测）**
1. 点「提交」→ 信息框：「本单元学习时间：无限制 / 是否必修：必修」+「确定」
2. 再弹确认框：「小U只记录你第一次答题的得分 / 确认要提交吗？」+「确认」/「取消」

## 9. 答案可得性（决定性结论）

| 途径 | 结果 |
|---|---|
| 内容接口 `v3/content` | `answers: []`、`analysis: {html:""}` —— **提交前没有答案** |
| 提交响应 `v3/submit` | 返回的是**同结构的加密内容**，解密后 `answers: ["C"]` 等 —— **提交后才给正确答案**（实测 10 题答案 `C,C,B,B,A,C,C,A,C,C`） |
| `/ucampus/course/api/answerRecommend/list?courseId&groupId&classId&studentSsoId` | 对 6 个 group 全部返回 `{"code":0,"data":[],"success":true}` —— **没有众包答案可用** |

→ 结论：**客观题必须靠 LLM 判题**（写题靠 LLM 生成）。提交后拿到的正确答案只能用于「回看/自校准」，不能用于本次作答（"小U只记录你第一次答题的得分"，同一 group 重复提交不改善成绩）。

## 10. 数据获取架构决策（本轮定稿）

内容接口是加密的（`unipus.<hex>`，密钥在页面 JS 里，`k` 字段为空）。**不逆推密钥**，改为：

- 脚本以 `@run-at document-start` 运行，向**页面世界**注入一段内联 `<script>`，钩住 `window.JSON.parse`，把含 `questions:questions` / `individualpresentation` / `discussion` / `readaloud` / `shortanswer` / `roleplay` / `purecontent` 键的解析结果，用 `document.dispatchEvent(new CustomEvent('uc:content', {detail: JSON.stringify(obj)}))` 发回隔离世界。
- 原因：脚本声明了 `@grant`（要 `GM_xmlhttpRequest` 绕 CORS），Tampermonkey 因此在**隔离世界**运行，直接改本世界 `JSON.parse` 对页面无效。
- 已验证：`ucontent.unipus.cn` 无 CSP meta，内联 `<script>` 注入可执行（实测 `window.__probeRan = true`）；该钩子已两次成功截获解密内容。
- 备选（未采用）：从 webpack 模块里取解密函数——随版本变化易碎。

## 11. 本轮真实提交产生的痕迹（可核对）

- `u4g251`（4-3 Pronunciation Activity 1，10 个单选）已真实提交，答案全选 `A`（按用户指示"分不重要"），因此该题**计 3/10 分**（正确答案见 §9）。
- `u4g258`（4-4 News report 1）**只填了 C/A 两个选项，未提交**（点了「取消」），该 group 状态未变。


## §12 听力填空（cloze）实测补充（2026-11-26，u4g266 Conversation 1-2）

- 内容键名 **`questions:scoopquestions`**（不是 `questions:questions`），形状：
  `{"questions:scoopquestions":{direction,content:[{audio:{audio:{url,duration},parts:[…],script:{html}}}],category,score,questions:[{content:{html:"<p>1)</p>"},options:[],answers:[]}],analysis}}`
  → `questions[]` 只有空位编号，**句子正文不随内容下发**，只存在于 DOM。
- 页面 DOM：整句在 `<p>` 里，空位是 `<span class="_placeHolder_ htmlViewBlank--holder_style-* scoopComponent" data-index="N">` 包着一个 `input[type=text][class*="fill-blank--bc-input"]`。
- 抽句子必须用 `input.closest('p')`；**不能用 `div[class*="question"]`**，那只命中输入框自身外层 div（textContent 为空）。
- 听力原文仍在 `content[0].audio.script.html`；音频直链 `course.media.unipus.cn/...mp3#duration=109.9`，免 cookie 可直下。
- 组接口 base 为 `objectivesimple_scoop_pc`（另有 `objectivesimple_scoop_course`），与 `objectivesimple_*` 同属听力家族。

## 13. 填空为什么"填了但不认"（2026-11-26 实测）

现象：批量/单题填空填好后站点仍报「还有 N 个空未填，请完成后提交」，`引擎状态 failed / 错误：提交未完成`。

对照实验（真机，ucontent pc.html）：

| 写法 | 输入框可见值 | 点「提交」后 |
| --- | --- | --- |
| `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` + `input`/`change` 事件 | 有 | 只弹「本单元学习时间/是否必修 → 确定」，**不弹**「小U只记录你第一次答题的得分 → 确认/取消」，接口未被调用，进度 `pass` 不变 |
| `el.focus()` → `el.select()` → `document.execCommand('insertText', false, v)` → `el.blur()` | 有 | 先弹信息框，再弹确认框 → 点「确认」后 **提交成功**（`u6g446` 非必修实测 `state.pass=1, pass2=1`） |

结论：站点是老版 React，受控输入只认浏览器真实编辑路径（`execCommand('insertText')` 会产生完整的输入事件序列），单纯派发 `input`/`change` 只会改 DOM 值、不进组件 state，于是前端校验认为空。

实现：`src/page/questions.ts` 的 `typeInto()`（focus → 全选 → insertText → blur，失败回退原生 setter），`fillBlanks()`/`fillTextArea()` 改为逐个 `await`（每空间隔 140ms），`src/page/submit.ts` 改为轮询等「确定」与「确认」两级弹窗，并在没走到确认框时回传页面提示原文。
