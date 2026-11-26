// Shadow DOM 内样式（与 U校园 老 jQuery 页面完全隔离，决策 15）
export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Microsoft YaHei", system-ui, sans-serif; }
.uc-launcher {
  position: fixed; right: 24px; bottom: 24px; z-index: 2147483000;
  width: 52px; height: 52px; border-radius: 50%; border: none;
  background: linear-gradient(135deg, #4f7cff, #7a5cff); color: #fff;
  font-size: 20px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.28);
}
.uc-panel {
  position: fixed; z-index: 2147483001; width: 420px; max-height: 72vh;
  display: flex; flex-direction: column; color: #1c2233;
  background: rgba(255,255,255,.98); border: 1px solid rgba(0,0,0,.08);
  border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.28); overflow: hidden;
}
.uc-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  background: linear-gradient(135deg,#4f7cff,#7a5cff); color: #fff; cursor: move;
  user-select: none;
}
.uc-title { font-size: 14px; font-weight: 600; flex: 1; }
.uc-tabs { display: flex; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid #eef1f7; }
.uc-tab {
  padding: 6px 12px; font-size: 13px; border: none; background: transparent;
  color: #5b6478; border-bottom: 2px solid transparent; cursor: pointer;
}
.uc-tab.active { color: #3b5bff; border-bottom-color: #3b5bff; font-weight: 600; }
.uc-body { padding: 12px; overflow: auto; font-size: 13px; line-height: 1.6; }
.uc-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; }
.uc-row label { color: #333c50; }
.uc-hint { color: #8a93a6; font-size: 12px; }
.uc-input, .uc-select {
  padding: 5px 8px; font-size: 13px; border: 1px solid #d8dde8; border-radius: 6px;
  background: #fff; color: #1c2233; min-width: 0; flex: 1;
}
.uc-btns { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #eef1f7; }
.uc-btn {
  flex: 1; padding: 8px 10px; font-size: 13px; border-radius: 8px; cursor: pointer;
  border: 1px solid #d8dde8; background: #fff; color: #333c50;
}
.uc-btn.primary { background: #3b5bff; border-color: #3b5bff; color: #fff; font-weight: 600; }
.uc-btn.danger { background: #fff1f0; border-color: #ffc9c4; color: #d4380d; }
.uc-btn:disabled { opacity: .45; cursor: not-allowed; }
.uc-log { font-family: Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; color: #55607a; }
`;
