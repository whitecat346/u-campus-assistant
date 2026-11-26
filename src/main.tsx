import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { Panel } from './ui/Panel';
import { PANEL_CSS } from './ui/styles';
import { detectPage, onPageChange, type PageKind } from './page/detect';
import { log } from './core/log';

const HOST_ID = 'uc-assistant-host';

function App() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PageKind>(detectPage);

  useEffect(() => onPageChange(setPage), []);

  // 需求：只在答题页面启用「开始作答」，其他页面只显示设置页
  const settingsOnly = page !== 'answering' && page !== 'exam';

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
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
  const root = document.createElement('div');
  shadow.appendChild(root);
  document.documentElement.appendChild(host);
  createRoot(root).render(<App />);
  log(`已注入 ${location.href}`);
}

mount();
