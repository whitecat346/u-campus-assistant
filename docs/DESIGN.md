# U校园自动学习系统 — 冻结设计（v1）

> 状态：**设计已冻结（2026-11-26）**。经 4 轮 grill 访谈确认，未列出的实现细节一律不得臆想，需勘察页面或再次提问。
> 产物：`userscript/`（油猴脚本仓库）+ `server/`（语音识别服务端仓库）。

## 1. 目标

用 TypeScript + Tampermonkey 脚本自动完成 U校园（`https://u.unipus.cn` → `uschool.unipus.cn` 等子域）课程作业，并由本机服务端用 SenseVoice 做听力题语音识别。用户只需在 Edge 里手动登录一次，其余自动化。

**用户原始需求（m00001）**
- 自动完成课程，默认只做必修，设置页可切「含非必修」。
- 听、说两类只做「听」，「说」跳过。
- 听的部分用 SenseVoice 语音识别（需指导用户部署服务端）。
- 「说」是自由演说：脚本生成一段简短文字帮用户自己念，**脚本不碰麦克风、永不提交口语**。
- 只在答题页面启用「开始作答」，其他页面只显示设置页。
- 悬浮按钮 + 可拖动悬浮面板，Esc 关闭。

## 2. 冻结决策（不可再议）

| # | 决策 | 说明 |
|---|---|---|
| 1 | 浏览器协作 = **chrome-devtools-mcp 接管 Edge 主 profile** | Edge 158.0.4370.33；Tampermonkey Beta 5.6.6242 (MV3, id `fcmfnpggmnlmfebfghbfnillijihnkoh`) 已装 |
| 2 | 两个独立 git 仓库，本地无远端 | `userscript/`、`server/` 各自 `git init` |
| 3 | 构建链 = Vite + vite-plugin-monkey 8.1.1（peer: vite ^8） | 产物 `.user.js` |
| 4 | 题型范围 = 全部题型自动（选择/填空/听写/听力选择/阅读/翻译/写作/口语评分） | 口语只出稿不提交 |
| 5 | 答案来源 = 先勘察页面是否内置答案，抓不到再接 LLM | LLM 接口可配 |
| 6 | 提交策略 = 默认 **自动提交听力/填空/写作**（2026-11-26 改：u4 dry-run 零失败后用户决定切自动）；说类永远只出稿、永不提交 | |
| 7 | 服务端 = 本机 uv + Python 3.12 + FastAPI + SenseVoiceSmall，仅监听 `127.0.0.1` | 回环可被 HTTPS 页调用，规避混合内容 |
| 8 | LLM = **默认云端，通用 OpenAI 兼容接口**（baseURL / model / key 填设置页） | 脚本直连，不经服务端；本机 Ollama 作为可选项保留 |
| 9 | 写作/翻译/口语短稿统一由 LLM 生成 | 写作 120–180 词，口语短稿 60–90 秒 |
| 10 | 口语：只生成短稿给用户自己读，脚本永不提交口语 | |
| 11 | 测试/考试：**默认关闭**，面板手动打开；打开后二次确认 + 同一测试只自动跑一次 + 置信度低不提交 | 消除了「全题型自动」与「口语不自动」的矛盾 |
| 12 | 听力：静音 + 后台按真实时长播完，不伪造进度 | |
| 13 | 节奏：随机 3–8 秒间隔、点击微延迟、输入模拟打字，单段运行 ≤ 2 小时 | |
| 14 | 批量 = 自动遍历全部（必修）课程，进度存 GM 存储，可中断续跑 | |
| 15 | 面板 UI = **React + Shadow DOM**（样式与老 jQuery 页面隔离） | |
| 16 | 设置项 = 全 10 项保留 | 见 §7 |

## 3. 架构

```
Edge (主 profile, 已登录 U校园, Tampermonkey)
 ├── userscript (TS → .user.js)          ← DSH 通过 chrome-devtools-mcp 驱动勘察/调试
 │    ├── 页面适配层 page/*            (路由识别、DOM 选择器、题型分派)
 │    ├── 作答引擎 engine/*            (状态机、答题循环、提交策略、断点续跑)
 │    ├── 能力层 core/*                (settings, llm, asr, audio, rate-limit, log)
 │    └── UI 层 ui/*                   (React 悬浮按钮 / 面板，Shadow DOM)
 ├── 127.0.0.1:8000  ASR 服务端 (server/, uv + FastAPI + SenseVoiceSmall)
 └── 云端 OpenAI 兼容 LLM (脚本直接 HTTPS 调用)
```

数据流：
1. **听力题**：优先拿到音频 URL → POST 给 `server` 的 `/asr/url` 由服务端下载解码；失败回退浏览器侧抓取音频（WebAudio/MediaRecorder）→ POST `/asr` 上传。
2. **写作/翻译/口语稿**：脚本 → LLM `chat/completions` → 文本填入（写作/翻译）或展示（口语稿）。
3. **进度**：`GM_setValue('uc.course.progress', ...)` 记录「课程 → 单元 → 题号」与已完成标记。

## 4. 页面与运行模型

- 注入匹配：`*://*.unipus.cn/*`（含 `u.unipus.cn`、`uschool.unipus.cn`、`*.unipus.cn`）。
- **答题页判定**：URL 命中答题路由白名单（待勘察确定，如 `.../homework/*`、`.../test/*`、`.../unit/*`）且存在答题容器节点。判定不成立时面板只渲染「设置」页，隐藏「开始作答」。
- 悬浮按钮常驻右下角；面板可拖动、位置记忆、Esc 关闭、点击遮罩关闭。
- 急停：面板内「暂停/停止」按钮立即中断答题循环，状态机回到 idle。

## 5. 作答状态机（引擎）

```
idle → planning(拉课程/单元清单) → unit_open(进入小节)
     → question_loop(识别题型 → 作答或跳过 → 下一题)
     → unit_submit(按提交策略) → next unit
口语题 → 生成短稿 → 展示给用户 → 标记 skipped_manual → 继续下一题
异常 → retry(≤3, 指数退避) → failed(记录并继续)
```

- 断点：每次完成一题写一次进度；重启后从最后未完成题续跑。
- 同一测试只跑一次：`GM_setValue('uc.test.done.<testId>', true)`。
- 置信度：LLM/答案解析给出置信度 < 阈值（默认 0.6）时，该题不提交、留给用户。

## 6. 服务端 API 契约（server v1）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/health` | — | `{status:"ok", model:"SenseVoiceSmall", device:"cuda|cpu"}` |
| POST | `/asr` | multipart `file`（任意音频，服务端 ffmpeg 转 16k 单声道 wav） | `{text, lang, emotion, events, duration_ms}` |
| POST | `/asr/url` | `{url, headers?}` | 同上；失败返回 `{error:{code,message}}` |

- 仅绑定 `127.0.0.1:8000`；CORS 允许 `*`（回环地址，油猴页可直连）。
- 模型：`iic/SenseVoiceSmall`（ModelScope），`trust_remote_code=True`，`vad_model="fsmn-vad"`，`use_itn=True`。识别语言 `auto`，`zh` 优先。
- 失败码：`FETCH_FAILED`、`DECODE_FAILED`、`MODEL_ERROR`。

## 7. 设置项（全 10 项，存 GM 存储）

| # | 键 | 默认 | 说明 |
|---|---|---|---|
| 1 | `scope` | `required` | `required` 只必修 / `all` 含非必修 |
| 2 | `submitMode` | `auto` | `dryRun` 只填不交 / `auto` 自动提交（说类不受影响，永不提交） |
| 3 | `delay` | `3000-8000` | 答题间隔区间（ms） |
| 4 | `llm` | `{baseURL:'', model:'', apiKey:'', enabled:true}` | OpenAI 兼容；空则所有 LLM 题跳过 |
| 5 | `asr` | `{baseURL:'http://127.0.0.1:8000'}` | SenseVoice 服务端 |
| 6 | `listening` | `{mute:true, rate:1}` | 听力静音 + 原速 |
| 7 | `exams` | `false` | 是否自动做测试/考试（默认关） |
| 8 | `speaking` | `{targetSec:75}` | 口语短稿目标时长 |
| 9 | `ui` | `{opacity:0.95, x:null, y:null}` | 面板透明度/位置记忆 |
| 10 | `emergency` | — | 一键暂停/急停（非持久） |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 自动提交不可撤回、计入成绩 | 默认 dry-run；考试默认关；二次确认 |
| 音频 URL 带鉴权/防盗链/blob | 双通道（服务端下载 → 浏览器录制回退） |
| 封号/风控 | 人机节奏、单段 ≤2h、不并发多标签 |
| Python 3.14 装不了 torch | 服务端固定 uv + Python 3.12 |
| shell 里 HTTPS 全崩（Schannel `SEC_E_NO_CREDENTIALS`） | 只用 Node 抓取（`\.cache/tools/fetch.mjs`） |
| MV3 Tampermonkey 需开发者模式 | 安装脚本前在 `edge://extensions` 打开开发者模式 |

## 9. 已知未知（必须勘察，不得臆想）

1. 答题页路由白名单与 DOM 选择器（登录后勘察）。
2. 课程/单元清单接口（是否有 JSON API）。
3. 页面是否内置答案（决定 LLM 依赖度）。
4. 音频资源形态（直链 mp3 / m3u8 / blob）。
5. 提交接口与「单元完成」判定字段。
6. 口语题的麦克风/评分组件是否会被脚本干扰。

## 10. 里程碑

- **M0（本次）**：设计冻结、两个空仓库 + 骨架、MCP 接入配置。
- **M1**：页面勘察（MCP 驱动）→ 产出 `docs/PAGE-MAP.md`。
- **M2**：作答引擎跑通「听力选择题」一类题（dry-run）。
- **M3**：完整题型覆盖 + 提交策略 + 断点续跑。
- **M4**：SenseVoice 部署 + 听力全链路。
- **M5**：风控打磨、文档、发布 `.user.js`。

## 11. MCP 接入（重启会话前必须做）

1. Edge 打开 `edge://inspect` → 左侧「远程调试」→ 勾选「允许远程调试此浏览器实例」（Edge 会写 `DevToolsActivePort`）。
2. DSH profile `<%USERPROFILE%>\.dsh\profiles\desktop\cordis.patch.yml` 追加第二个 `insert` 块（见根 `README.md`）。
3. 重启 DSH 会话；之后所有浏览器操作通过该 MCP 完成。

## 12. 验收（M0）

- [x] 设计文档落盘，决策表含 16 条
- [x] `userscript/` 与 `server/` 各自 `git init` 且有首次提交
- [ ] MCP 配置写入 profile 并重启（等用户执行）

