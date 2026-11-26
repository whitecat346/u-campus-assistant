import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monkey from 'vite-plugin-monkey';

// 设计见 ../docs/DESIGN.md，勿在此处臆想页面选择器。
export default defineConfig({
  plugins: [
    react(),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        name: 'U校园助手',
        namespace: 'local.u-campus.assistant',
        version: '0.1.0',
        description: '自动完成 U校园 课程作业（听力用 SenseVoice 识别，口语只出稿）',
        author: 'local',
        icon: 'https://u.unipus.cn/favicon.ico',
        match: ['*://*.unipus.cn/*'],
        'run-at': 'document-idle',
        connect: ['127.0.0.1:8000', '127.0.0.1:11434', '*'],
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
