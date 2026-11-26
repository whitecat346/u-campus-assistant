# U校园助手（油猴脚本）

用 TypeScript 写的 Tampermonkey 脚本，自动完成 **U校园**（`u.unipus.cn` / `ucontent.unipus.cn`）《大学英语听说》类课程的学习任务：听力题判题并作答、填空题按原文补全、写作题生成短文、「说」类题只生成稿子交给你自己念。

> 听力语音识别可选接本机 [u-campus-asr](../u-campus-asr)（SenseVoice）服务；**课程页面本身会下发听力原文时优先用原文**，只有原文缺失才回退到 ASR。

---

## 它做什么

| 题型 | 内容键名 / base | 脚本行为 |
| --- | --- | --- |
| 听力单选 | `questions:questions` + `objectivesimple_course` | LLM 读原文判题 → 依次点选 → 按「提交策略」提交 |
| 听力填空（scoop/cloze） | `questions:scoopquestions` + `objectivesimple_scoop_course` | 按原文逐空补词（1–4 词）→ 提交 |
| 写作 / 简答 | `short_answer` 一类 | 生成短文（Essay 120–180 词）写入文本框 |
| 说：跟读 / 个人陈述 / 讨论 / 角色扮演 | `sentencerecord` / `magic_*` / `discussion` / `roleplay` | **只生成短稿**，不录音、不点提交 —— 由你自己念、自己交 |
| 纯阅读页 | `purecontent` | 跳过 |

批量时只做**未完成的必修项**（可在设置里放开非必修），跳过已过截止的单元；测试/考试默认跳过，需在设置里显式打开。

## 它不做什么

- 不碰麦克风，不提交任何口语题；
- 不代填账号密码，遇到登录页/验证码就停下等你；
- 不伪造音频播放进度（听力题不强制播完，只按题目内容作答）；
- 不猜页面结构：所有选择器都是在真实页面上抓包核对过的（见 [`docs/PAGE-MAP.md`](docs/PAGE-MAP.md)）。

---

## 安装

1. 浏览器装 Tampermonkey（在 Edge 上装的是 **MV3 Beta**，需要在 `edge://extensions` 打开「开发者模式」才能用 `userScripts` 权限）。
2. 点这个链接装脚本（jsDelivr CDN，国内可达；GitHub 直链 `raw.githubusercontent.com` 在部分网络下 DNS 不通）：

   ```
   https://cdn.jsdelivr.net/gh/whitecat346/u-campus-assistant@v0.7.3/dist/u-campus-assistant.user.js

   > 链接里的 @v版本号 请对照 [Tags](https://github.com/whitecat346/u-campus-assistant/tags) 换成最新版；@main 的 CDN 缓存会滞后，不建议用。
   ```

   或者把仓库里的 `dist/u-campus-assistant.user.js` 下载下来拖进浏览器窗口，Tampermonkey 会弹出安装页。
   脚本的 `@updateURL` 同样指向这个 CDN，之后在 Tampermonkey 里点「检查更新」就能升级。
3. 打开 `u.unipus.cn`，右下角出现紫色悬浮球 `U` 即注入成功；点开面板，标题上会带版本号（如 `v0.6.8`），可据此确认装的是哪一版。

## 首次配置

点悬浮球 → **设置**：

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| 范围 | 仅必修 | 也可选「含非必修」 |
| 提交 | 自动提交 | 想先看效果就切「只填不交」 |
| 本轮只跑 | 全部单元 | 给「整课批量」限范围，下拉来自课程树 |
| 本轮最多 | 不限条数 | 先跑 5 条试水 |
| 间隔(秒) | 3 / 8 | 每次答题之间的随机等待 |
| 等题目(毫秒) | 3000 | 页面渲染慢就调大 |
| LLM 地址 | 空 | OpenAI 兼容接口，如 `https://api.deepseek.com` |
| 模型 / Key | 空 | 模型名 + API Key（本地存 GM 存储，不写进代码） |
| ASR 地址 | `http://127.0.0.1:8000` | 自建 SenseVoice 服务；不部署也不影响（会退化成只用题干推断） |
| 听力静音 | 开 | 播放器静音 |
| 自动做测试/考试 | 关 | 打开前想清楚：只记录第一次提交的得分 |
| 口语短稿(秒) | 75 | 生成稿子对应的朗读时长 |
| 面板透明度 | 可调 | |

> ⚠️ 这套 API Key 存在浏览器本地扩展存储里。用公用电脑时用完记得清空。

## 使用

1. 在课程目录页点进任意一个小节（只有答题页才会出「开始作答」按钮）。
2. 面板三个标签页：**作答** / **设置** / **日志**。
   - 「开始作答」：只做当前这一题；
   - 「整课批量」：按课程树逐个打开未完成的必修项，队列与下标存进 GM 存储，**页面被弹回目录页也会自动续跑**；
   - 「暂停 / 继续 / 急停」随时可用；
   - 拖标题栏可移动面板，位置会记住；`Esc` 关闭。
3. 「说」类题：跑完会显示短稿（可一键复制），你自己念完点页面上的提交。脚本永远不会替你交口语题。
4. 每道题的过程都在「日志」里，包括判题置信度、哪几题没答、是否提交。

## 工作原理（为什么要页面世界钩子）

答题页的内容是加密下发的：`GET /course/api/v3/content/{courseId}/{groupId}/default/` 返回 `{"content":"unipus.<hex>"}`，页面自己解密后交给 React。脚本无法复刻这套解密，所以在 **document-start** 阶段往**页面世界**注入一段内联脚本，钩住 `JSON.parse` —— 页面解密时必然经过它，我们把解析结果通过 `CustomEvent('uc:content')` 发回隔离世界。

隔离世界这边负责：读课程树与进度（`/course/api/course/…`、`/course/api/v2/course_progress/…`）、调 LLM 判题、点选/填词、点提交并处理两层确认弹窗。

鉴权：`localStorage.jwtToke` 就是 `x-annotator-auth-token` 的值，配合 `appid: 5`、`uni-client-ver: 12040` 使用；跨站请求一律走 `GM_xmlhttpRequest` 绕开 CORS。

关键接口、DOM 选择器、题目内容结构、提交请求体全部记录在 [`docs/PAGE-MAP.md`](docs/PAGE-MAP.md)；设计决策与取舍见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 目录

```
src/
  main.tsx            入口：注入钩子 → Shadow DOM → React
  core/api.ts         课程树 / 进度 / token / 路由解析
  core/llm.ts         OpenAI 兼容客户端（GM_xmlhttpRequest，思考模型降级重试）
  core/asr.ts         SenseVoice 客户端（URL 直传 / 录音上传双通道）
  core/settings.ts    GM 存储的设置项与迁移
  page/capture.ts     页面世界 JSON.parse 钩子 + 事件桥
  page/questions.ts   题干/选项/填空 DOM 读写、题型判定
  page/submit.ts      提交按钮与两层确认
  page/detect.ts      页面类型判定（portal / catalog / answering）
  engine/judge.ts     判题与短稿提示词
  engine/machine.ts   单题状态机
  engine/batch.ts     整课批量：规划、断点续跑、安全阀
  ui/                 React 面板（Shadow DOM，可拖动，Esc 关闭）
```

## 开发

```bash
npm install
npm run dev        # 起 dev server，按提示把 .user.js 装进 Tampermonkey
npm run build      # 产出 dist/u-campus-assistant.user.js
npm run typecheck
```

本地更新通道（开发时更快、不依赖 CDN）：`node ../.cache/tools/serve.mjs 50937` 把 `dist/` 挂到 `http://127.0.0.1:50937`，然后临时把 `vite.config.ts` 里的 `updateURL`/`downloadURL` 改成 `http://127.0.0.1:50937/u-campus-assistant.user.js` 再 build。

发布新版本：`npm version <x.y.z>` → `npm run build` → commit → `git push` → 打 tag → 清 CDN 缓存：

```
node -e "fetch('https://purge.jsdelivr.net/gh/whitecat346/u-campus-assistant@v0.7.3/dist/u-campus-assistant.user.js').then(r=>r.text()).then(console.log)"
```

## 常见问题

- **`LLM 未返回正文（finish=length）`**：用的是思考型模型（响应里带 `reasoning_content`），思考把 `max_tokens` 吃光了。脚本会依次尝试「关思考重试 → 加大预算」，仍失败就换模型（例如同厂的非思考版本）或把预算调高。
- **`等待 N 秒仍未拿到题目`**：该小节的内容不由 `JSON.parse` 下发（少见），或页面渲染慢 —— 调大「等题目(毫秒)」。
- **判题置信度低 / 有空题时不提交**：这是故意的安全阀，只记录第一次得分的规则下，宁可留给你手动做。
- **得分只记录第一次提交**：U校园前端弹窗原文如此，脚本无法改善已提交的分数。
- **`ASR 失败`**：本机 `u-campus-asr` 没起，或没装模型；不影响听力判题（只是少了 ASR 兜底）。

## 更新记录

- **0.7.3** — 多小题书面题按「题目要求」选作答形态：词云造句 / 句子改错（听原文定位错误、只改错处）/ 通用兜底；改错题把听力原文与页面自带参考答案一起喂给模型；模型失败时回填页面参考答案，避免留空被判未完成。
- **0.7.2** — 更新地址从 jsDelivr 的 `@main` 改为按版本固化的 `@v<版本>` tag 路径（`@main` 的 CDN 缓存实测滞后多个版本，导致 Tampermonkey 永远看不到更新）。
- **0.7.1** — 「一小题一个输入框」的书面题：逐框生成逐框写入，兼容多图多框；答案对齐页面自带示例。
- **0.7.0** — 「选合适表达补全对话」题型：按内容题数与页面单选组数对齐取帧，把左栏对话正文作为判题上下文。
- **0.6.11** — 考试页识别改用 DOM 兜底（考试是嵌在课程页里的跨域 iframe，`window.open` 后 `location.href` 仍可能是 `about:blank`）。
- **0.6.10 / 0.6.9** — 考试（作业与测试系统）支持：多段材料 × 多题、录音里念题干、按段 ASR → 判题 → 按展示顺序 A/B/C/D 点选。
- **0.6.6 / 0.6.7** — 填空提交修复：老版 React 受控输入只认真实编辑路径（`execCommand('insertText')`），只派发 `input` 事件时站点 state 收不到值。
- **0.6.0** — 听力题默认自动提交；口语短稿分形态（演讲/朗读/对话/作文）；面板逐题刷新。

## 免责声明

本项目仅用于**个人学习效率**与浏览器自动化技术研究。使用者需自行承担：账号风险（自动化行为可能违反平台用户协议）、成绩后果、以及所在学校/课程的学术诚信要求。请勿用于代替真实学习、请勿分发他人账号使用。
