import { useEffect, useRef, useState } from 'react';
import { getSettings, saveSettings, resetSettings, type Settings } from '../core/settings';
import { canStartAnswering, detectPage, onPageChange } from '../page/detect';
import { getStatus, onStatus, startEngine, pause, resume, stop, type EngineStatus } from '../engine/machine';
import { startBatch } from '../engine/batch';
import { onLog, snapshot, type LogLine } from '../core/log';
import { cachedUnits } from '../core/api';

type Tab = 'run' | 'settings' | 'log';

interface Props {
  onClose: () => void;
  /** 非答题页面：只允许设置页 */
  settingsOnly?: boolean;
}

export function Panel({ onClose, settingsOnly = false }: Props) {
  const [tab, setTab] = useState<Tab>(settingsOnly ? 'settings' : 'run');
  const [settings, setSettings] = useState<Settings>(getSettings);
  const [status, setStatus] = useState<EngineStatus>(getStatus);
  const [lines, setLines] = useState<LogLine[]>(snapshot);
  const [copied, setCopied] = useState('');
  const [units, setUnits] = useState(cachedUnits);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const s = getSettings().ui;
    return {
      x: s.x ?? Math.max(12, window.innerWidth - 460),
      y: s.y ?? Math.max(12, window.innerHeight - 560),
    };
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => onStatus(setStatus), []);
  useEffect(() => onLog(setLines), []);
  // 打开设置页时刷新单元清单（批量跑过一次后才有真实单元名）
  useEffect(() => {
    if (tab === 'settings') setUnits(cachedUnits());
  }, [tab]);

  // Esc 关闭（需求：Esc 快捷键关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // 拖动（需求：面板可拖动 + 位置记忆）
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const x = Math.min(Math.max(0, e.clientX - dragRef.current.dx), window.innerWidth - 80);
      const y = Math.min(Math.max(0, e.clientY - dragRef.current.dy), window.innerHeight - 40);
      setPos({ x, y });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      saveSettings({ ui: { ...getSettings().ui, x: pos.x, y: pos.y } });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pos.x, pos.y]);

  // 修复：原来用 useMemo(..., []) 只在挂载时算一次，SPA 内部切题/切页后「当前页面」与按钮可用性不会更新
  const [page, setPage] = useState(detectPage);
  useEffect(() => onPageChange(setPage), []);
  const canAnswer = !settingsOnly && canStartAnswering(page);
  const running = status.state !== 'idle' && status.state !== 'stopped' && status.state !== 'failed';

  const runBatch = () => {
    void startBatch().catch((e: Error) => {
      setLines(snapshot());
      console.warn('[U校园助手] 批量失败', e);
    });
  };

  const patch = (p: Partial<Settings>) => setSettings(saveSettings(p));

  return (
    <div className="uc-panel" style={{ left: pos.x, top: pos.y, opacity: settings.ui.opacity }}>
      <div
        className="uc-head"
        onMouseDown={(e) => {
          dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
      >
        <span className="uc-title">
          U校园助手 <span className="uc-ver">v{__UC_VERSION__}</span>
        </span>
        <button className="uc-btn" style={{ flex: 'none', padding: '2px 8px' }} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="uc-tabs">
        {!settingsOnly && (
          <button className={`uc-tab ${tab === 'run' ? 'active' : ''}`} onClick={() => setTab('run')}>
            作答
          </button>
        )}
        <button className={`uc-tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          设置
        </button>
        <button className={`uc-tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>
          日志
        </button>
      </div>

      {tab === 'run' && (
        <>
          <div className="uc-body">
            <div className="uc-row">
              <label>当前页面</label>
              <span className="uc-hint">{page}</span>
            </div>
            <div className="uc-row">
              <label>引擎状态</label>
              <span className="uc-hint">{status.state}</span>
            </div>
            <div className="uc-row">
              <label>已作答 / 跳过</label>
              <span className="uc-hint">
                {status.filled ?? 0} / {status.skipped ?? 0}
              </span>
            </div>
            <div className="uc-row">
              <label>提交策略</label>
              <span className="uc-hint">{settings.submitMode === 'dryRun' ? '只填不交（dry-run）' : '自动提交（说类只出稿，永不提交）'}</span>
            </div>
            {status.batch && (
              <>
                <div className="uc-row">
                  <label>整课进度</label>
                  <span className="uc-hint">
                    {status.batch.done} / {status.batch.total}
                  </span>
                </div>
                {status.batch.current && (
                  <div className="uc-row">
                    <label>当前</label>
                    <span className="uc-hint">{status.batch.current}</span>
                  </div>
                )}
              </>
            )}
            {status.kind && (
              <div className="uc-row">
                <label>题型</label>
                <span className="uc-hint">{status.kind === 'speaking' ? '说（只出稿）' : status.kind === 'listening' ? '听/客观题' : status.kind === 'cloze' ? '听/填空' : status.kind}</span>
              </div>
            )}
            {status.script && (
              <div className="uc-script-box">
                <div className="uc-script-head">
                  <span>说类短稿（自己读，脚本不会提交口语）</span>
                  <span className="uc-hint">{status.script.trim().split(/\s+/).length} 词</span>
                </div>
                <div className="uc-script">{status.script}</div>
                <div className="uc-script-actions">
                  <button
                    className="uc-btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(status.script ?? '');
                      setCopied('script');
                      window.setTimeout(() => setCopied(''), 1200);
                    }}
                  >
                    {copied === 'script' ? '已复制' : '复制短稿'}
                  </button>
                  <button
                    className="uc-btn"
                    onClick={() => {
                      const el = document.createElement('textarea');
                      el.value = status.script ?? '';
                      document.body.appendChild(el);
                      el.select();
                      document.execCommand('copy');
                      el.remove();
                      setCopied('script');
                      window.setTimeout(() => setCopied(''), 1200);
                    }}
                    title="剪贴板 API 被拒时用这个"
                  >
                    复制（兼容）
                  </button>
                </div>
              </div>
            )}
            {status.scripts && status.scripts.length > 0 && (
              <div className="uc-script-box">
                <div className="uc-script-head">
                  <span>说类短稿（共 {status.scripts.length} 条，自己读、自己交）</span>
                </div>
                <div className="uc-script-list">
                  {status.scripts.map((s, i) => (
                    <div className="uc-script-item" key={`${s.group}-${i}`}>
                      <div className="uc-script-name">
                        #{i + 1} {s.name}
                      </div>
                      <div className="uc-script">{s.text}</div>
                    </div>
                  ))}
                </div>
                <div className="uc-script-actions">
                  <button
                    className="uc-btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        (status.scripts ?? []).map((s, i) => `#${i + 1} ${s.name}\n${s.text}`).join('\n\n'),
                      );
                      setCopied('all');
                      window.setTimeout(() => setCopied(''), 1200);
                    }}
                  >
                    {copied === 'all' ? '已复制' : '复制全部短稿'}
                  </button>
                </div>
              </div>
            )}
            {!canAnswer && <div className="uc-hint" style={{ marginTop: 8 }}>当前不是答题页面，「开始作答」已禁用。</div>}
            {status.lastError && <div className="uc-hint" style={{ color: '#d4380d' }}>错误：{status.lastError}</div>}
          </div>
          <div className="uc-btns">
            {!running ? (
              <>
                <button className="uc-btn primary" disabled={!canAnswer} onClick={() => void startEngine()}>
                  开始作答
                </button>
                <button className="uc-btn" disabled={!canAnswer} onClick={runBatch} title="遍历整门课未完成项">
                  整课批量
                </button>
              </>
            ) : (
              <>
                <button className="uc-btn" onClick={() => (status.state === 'paused' ? resume() : pause())}>
                  {status.state === 'paused' ? '继续' : '暂停'}
                </button>
                <button className="uc-btn danger" onClick={stop}>
                  急停
                </button>
              </>
            )}
          </div>
        </>
      )}

      {tab === 'settings' && (
        <div className="uc-body">
          <div className="uc-row">
            <label>范围</label>
            <select className="uc-select" value={settings.scope} onChange={(e) => patch({ scope: e.target.value as Settings['scope'] })}>
              <option value="required">仅必修</option>
              <option value="all">含非必修</option>
            </select>
          </div>
          <div className="uc-row">
            <label>提交</label>
            <select
              className="uc-select"
              value={settings.submitMode}
              onChange={(e) => patch({ submitMode: e.target.value as Settings['submitMode'] })}
            >
              <option value="dryRun">只填不交</option>
              <option value="auto">自动提交</option>
            </select>
          </div>
          <div className="uc-row">
            <label>本轮只跑</label>
            <select
              className="uc-select"
              value={settings.batch.unit}
              onChange={(e) => patch({ batch: { ...settings.batch, unit: e.target.value } })}
            >
              <option value="">全部单元</option>
              {units.map((u) => (
                <option key={u.unit} value={u.unit}>
                  {u.unit} · {u.name}
                </option>
              ))}
              {settings.batch.unit && !units.some((u) => u.unit === settings.batch.unit) && (
                <option value={settings.batch.unit}>{settings.batch.unit}（上次用的单元）</option>
              )}
            </select>
          </div>
          <div className="uc-row">
            <label>本轮最多</label>
            <select
              className="uc-select"
              value={String(settings.batch.limit)}
              onChange={(e) => patch({ batch: { ...settings.batch, limit: Number(e.target.value) || 0 } })}
            >
              <option value="0">不限条数</option>
              <option value="1">1 条（试跑）</option>
              <option value="5">5 条</option>
              <option value="10">10 条</option>
              <option value="20">20 条</option>
              <option value="30">30 条</option>
              {![0, 1, 5, 10, 20, 30].includes(settings.batch.limit) && (
                <option value={String(settings.batch.limit)}>{settings.batch.limit} 条</option>
              )}
            </select>
          </div>
          <div className="uc-hint" style={{ marginBottom: 6 }}>
            「整课批量」只做未完成的必修项（说类只出稿、不提交，测试/考试默认跳过）。上面两项只用来给这一轮限范围：先选一个单元、跑 5 条看看，确认没问题再切回「全部单元 / 不限条数」。
          </div>
          <div className="uc-row">
            <label>间隔(秒)</label>
            <input
              className="uc-input"
              type="number"
              min={0}
              value={Math.round(settings.delayMinMs / 1000)}
              onChange={(e) => patch({ delayMinMs: Number(e.target.value) * 1000 })}
            />
            <input
              className="uc-input"
              type="number"
              min={0}
              value={Math.round(settings.delayMaxMs / 1000)}
              onChange={(e) => patch({ delayMaxMs: Number(e.target.value) * 1000 })}
            />
          </div>
          <div className="uc-row">
            <label>等题目(毫秒)</label>
            <input
              className="uc-input"
              type="number"
              min={500}
              step={500}
              title="听力页常常先出播放器、后出选项；给选项多少时间渲染出来"
              value={settings.wait.questionsMs}
              onChange={(e) => patch({ wait: { ...settings.wait, questionsMs: Number(e.target.value) || 3000 } })}
            />
          </div>
          <div className="uc-row">
            <label>LLM 地址</label>
            <input
              className="uc-input"
              placeholder="https://api.example.com/v1"
              value={settings.llm.baseURL}
              onChange={(e) => patch({ llm: { ...settings.llm, baseURL: e.target.value } })}
            />
          </div>
          <div className="uc-row">
            <label>模型 / Key</label>
            <input
              className="uc-input"
              placeholder="model"
              value={settings.llm.model}
              onChange={(e) => patch({ llm: { ...settings.llm, model: e.target.value } })}
            />
            <input
              className="uc-input"
              type="password"
              placeholder="apiKey"
              value={settings.llm.apiKey}
              onChange={(e) => patch({ llm: { ...settings.llm, apiKey: e.target.value } })}
            />
          </div>
          <div className="uc-row">
            <label>ASR 地址</label>
            <input
              className="uc-input"
              value={settings.asr.baseURL}
              onChange={(e) => patch({ asr: { ...settings.asr, baseURL: e.target.value } })}
            />
          </div>
          <div className="uc-row">
            <label>听力静音</label>
            <input
              type="checkbox"
              checked={settings.listening.mute}
              onChange={(e) => patch({ listening: { ...settings.listening, mute: e.target.checked } })}
            />
          </div>
          <div className="uc-row">
            <label>自动做测试/考试</label>
            <input type="checkbox" checked={settings.exams} onChange={(e) => patch({ exams: e.target.checked })} />
          </div>
          <div className="uc-row">
            <label>口语短稿(秒)</label>
            <input
              className="uc-input"
              type="number"
              min={30}
              max={180}
              value={settings.speaking.targetSec}
              onChange={(e) => patch({ speaking: { targetSec: Number(e.target.value) } })}
            />
          </div>
          <div className="uc-row">
            <label>面板透明度</label>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.05}
              value={settings.ui.opacity}
              onChange={(e) => patch({ ui: { ...settings.ui, opacity: Number(e.target.value) } })}
            />
          </div>
          <div className="uc-btns" style={{ padding: '8px 0 0', border: 'none' }}>
            <button className="uc-btn" onClick={() => setSettings(resetSettings())}>
              恢复默认
            </button>
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div className="uc-body">
          <div className="uc-log">
            {lines.length === 0
              ? '暂无日志'
              : lines
                  .slice()
                  .reverse()
                  .map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.msg}`)
                  .join('\n')}
          </div>
        </div>
      )}
    </div>
  );
}
