// 由 Tampermonkey 注入的 GM_* API（声明为本项目需要的子集）
declare function GM_getValue<T>(key: string, defaultValue: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_listValues(): string[];
declare function GM_xmlhttpRequest(details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | Blob;
  responseType?: 'text' | 'arraybuffer' | 'blob' | 'json';
  timeout?: number;
  onload?: (resp: { status: number; response: unknown; responseText: string; responseHeaders: string }) => void;
  onerror?: (err: unknown) => void;
  ontimeout?: () => void;
}): { abort(): void };

declare const unsafeWindow: Window & typeof globalThis;
