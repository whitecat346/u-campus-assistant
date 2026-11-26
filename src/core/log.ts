// 轻量日志：控制台 + 面板内存环形缓冲（不落盘，避免污染存储）
export interface LogLine {
  t: number;
  msg: string;
}

const MAX = 200;
const lines: LogLine[] = [];
const listeners = new Set<(l: LogLine[]) => void>();

export function log(msg: string): void {
  const line = { t: Date.now(), msg };
  lines.push(line);
  if (lines.length > MAX) lines.shift();
  // eslint-disable-next-line no-console
  console.log('[U校园助手]', msg);
  listeners.forEach((fn) => fn(snapshot()));
}

export function snapshot(): LogLine[] {
  return lines.slice();
}

export function onLog(fn: (l: LogLine[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
