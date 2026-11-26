// 入口：必须尽早安装 JSON.parse 钩子（抓解密后的内容），再把 UI 挂到 Shadow DOM。
import { installCapture } from './page/capture';

// ① 先装抓取钩子（document-start 生效，必须早于页面自身的解密解析）
installCapture();

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { Panel } from './ui/Panel';
import { PANEL_CSS } from './ui/styles';
import { detectPage, onPageChange, type PageKind } from './page/detect';
import { log } from './core/log';
import { resumeBatchIfNeeded } from './engine/batch';

const HOST_ID = 'uc-assistant-host';

function App() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PageKind>(detectPage);

  useEffect(() => onPageChange(setPage), []);

  // 需求：只在答题页面启用「开始作答」，其他页面只显示设置页
  const settingsOnly = page !== 'answering';

  return (
    <>
      <button className="uc-launcher" title="U校园助手" style={{ opacity: 0.92 }} onClick={() => setOpen((v) => !v)}>
        U
      </button>
      {open && <Panel settingsOnly={settingsOnly} onClose={() => setOpen(false)} />}
    </>
  );
}

function mount() {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  // 运行时标识：DEV 面板/MCP 自检可据此确认装的是哪个构建
  host.dataset.ucVersion = __UC_VERSION__;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
  const root = document.createElement('div');
  shadow.appendChild(root);
  document.documentElement.appendChild(host);
  createRoot(root).render(<App />);
  log(`已注入 ${location.href} (v${__UC_VERSION__})`);

  // 批量被打断（页面被弹回目录页/刷新）后自动续跑
  window.setTimeout(() => {
    void resumeBatchIfNeeded().catch((e) => log(`自动续跑失败：${(e as Error).message}`));
  }, 2500);
}

// document-start 时 body 可能还不存在 → 等 DOM 就绪再挂 UI
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
