# U校园助手（油猴脚本）

TypeScript + Vite + vite-plugin-monkey 的 Tampermonkey 脚本，自动完成 U校园（`u.unipus.cn` / `uschool.unipus.cn`）课程作业。
听力题语音识别走本机 `server/`（SenseVoice）；「说」类题只生成短稿给用户自己念，脚本不碰麦克风。

完整设计与冻结决策见 [../docs/DESIGN.md](../docs/DESIGN.md)。

## 状态

M0 骨架（设计冻结 + 仓库初始化）。题目解析/提交流程待页面勘察后实现，代码里所有 `TODO(勘察)` 都对应设计文档 §9 的已知未知项。

## 开发

```bash
npm install          # 或 pnpm install
npm run dev          # 起 dev server，按提示把 .user.js 装进 Tampermonkey
npm run build        # 产出 dist/u-campus-assistant.user.js
npm run typecheck
```

安装前需在 `edge://extensions` 打开「开发者模式」（Tampermonkey MV3 的 `userScripts` 权限要求）。

> 注意：本机 shell 里 HTTPS 只能走 Node（Schannel `SEC_E_NO_CREDENTIALS`），npm 需把 cache 指到工作区内：
> `export npm_config_cache=G:/u_camput_script/.cache/npm`

## 目录

```
src/
  main.tsx            挂载：Shadow DOM + React 根
  gm.d.ts             GM_* API 声明
  core/settings.ts    设置模型与 GM 持久化（10 项设置）
  core/llm.ts         OpenAI 兼容 LLM 客户端
  core/asr.ts         SenseVoice 客户端（URL 直连 + Blob 上传双通道）
  core/log.ts         内存日志环形缓冲
  page/detect.ts      页面识别（路由白名单待勘察补全）
  engine/machine.ts   作答状态机骨架（暂停/急停/随机间隔）
  ui/Panel.tsx        悬浮面板（可拖动、Esc 关闭、位置记忆）
  ui/styles.ts        Shadow DOM 样式
```

## 安全默认值

- 提交策略默认 **只填不交**（dry-run）。
- 测试/考试默认 **关闭**，需在面板手动打开，且仍会二次确认。
- 口语题永不自动提交。
