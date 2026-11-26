import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monkey from 'vite-plugin-monkey';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// 设计见 ../docs/DESIGN.md，勿在此处臆想页面选择器。
export default defineConfig({
  define: {
    // 供运行时自检（面板/日志里核对装的是不是最新构建）
    __UC_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        name: 'U校园助手',
        namespace: 'https://github.com/whitecat346/u-campus-assistant',
        version: pkg.version,
        description: '自动完成 U校园 课程作业（听力判题作答，口语只出稿不提交）',
        author: 'whitecat346',
        icon: 'https://u.unipus.cn/favicon.ico',
        match: ['*://*.unipus.cn/*'],
        'run-at': 'document-start',
        homepageURL: 'https://github.com/whitecat346/u-campus-assistant',
        supportURL: 'https://github.com/whitecat346/u-campus-assistant/issues',
        // 更新通道：GitHub raw 在部分网络下不可达（TLS 超时），本地联调期改指本机静态服务器（.cache/tools/serve.mjs 50937）。
        // 发布到 GitHub 后再把这两行换回 https://raw.githubusercontent.com/whitecat346/u-campus-assistant/main/dist/u-campus-assistant.user.js
        updateURL: 'http://127.0.0.1:50937/u-campus-assistant.user.js',
        downloadURL: 'http://127.0.0.1:50937/u-campus-assistant.user.js',
        connect: ['127.0.0.1:8000', '127.0.0.1:11434', '127.0.0.1:50937', '*'],
        grant: ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_xmlhttpRequest', 'unsafeWindow'],
        // 服务端与本机 LLM 走 127.0.0.1；跨域音频下载走 GM_xmlhttpRequest
      },
      build: {
        fileName: 'u-campus-assistant.user.js',
        autoGrant: false,
      },
    }),
  ],
  build: {
    minify: false,
    sourcemap: 'inline',
  },
});
