// 提交动作（实测流程，见 docs/PAGE-MAP.md §8）。
// 实测：点「提交（button[class*="submit-bar-pc--btn"]）」后先弹信息框（本单元学习时间/是否必修 → 「确定」），
// 再弹确认框（"小U只记录你第一次答题的得分 / 确认要提交吗？" → 「确认」/「取消」）。
// 注意：提交后接口返回的内容里**才**包含正确答案与得分（实测 answers: ["C"] 等）。
import { log } from '../core/log';

function visibleButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !!(b.offsetWidth || b.offsetHeight));
}

function findButton(label: string): HTMLButtonElement | null {
  return visibleButtons().find((b) => (b.innerText || '').trim() === label) ?? null;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** 当前可见的弹窗文字（拼一起，便于确认走到了哪一层） */
function dialogText(): string {
  const boxes = Array.from(document.querySelectorAll<HTMLElement>('[class*="dialog"], [class*="Dialog"]')).filter(
    (d) => !!d.offsetParent && (d.innerText || '').trim().length > 0,
  );
  return boxes
    .map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 4)
    .join(' | ')
    .slice(0, 200);
}

/** 页面上的提示气泡（提交失败/未完成时站点会给一句） */
function hintText(): string {
  const els = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(
    (d) => d.children.length === 0 && !!d.offsetParent && (d.textContent || '').trim(),
  );
  const hit = els
    .map((d) => (d.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => /未填|请完成|完成后再|不能为空|未作答|作答后再|稍后重试/.test(t) && t.length < 100);
  return hit[0] ?? '';
}

/** 轮询等按钮出现 */
async function waitButton(label: string, timeoutMs: number): Promise<HTMLButtonElement | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const b = findButton(label);
    if (b) return b;
    await sleep(200);
  } while (Date.now() < deadline);
  return null;
}

export interface SubmitOutcome {
  submitted: boolean;
  /** 页面提示/得分气泡文字（若有） */
  message?: string;
}

/**
 * 点击提交并走完确认弹窗。
 * @param accept 是否真的确认（dry-run 时传 false，只点开再取消，用于校验 UI 可用性）
 */
export async function submitCurrentGroup(accept = true): Promise<SubmitOutcome> {
  const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.innerText || '').trim() === '提交' && !b.disabled && !!(b.offsetWidth || b.offsetHeight),
  );
  if (!submit) return { submitted: false, message: '未找到可用的「提交」按钮' };

  submit.click();
  let sawConfirm = false;

  // 第一层：信息框「确定」
  const ok = await waitButton('确定', 6000);
  if (ok) {
    ok.click();
    await sleep(500);
  }

  // 第二层：确认框「确认」/「取消」——只有站点认为作答完整时才会出现
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const yes = findButton('确认');
    const no = findButton('取消');
    if (yes || no) {
      sawConfirm = true;
      if (accept && yes) {
        yes.click();
        await sleep(1500);
      } else if (no) {
        no.click();
        await sleep(300);
      }
      break;
    }
    await sleep(200);
  }

  const text = document.body.innerText;
  const m = text.match(/(本次得分[：:]?\s*[\d.]+[^\n]{0,20}|提交成功[^\n]{0,20}|小U[^\n]{0,30})/);
  const message = (m ? m[1].trim() : '') || hintText() || dialogText() || undefined;

  if (!sawConfirm) {
    log(`提交未走到确认框（${message ?? '页面无提示'}）`);
    return { submitted: false, message: message ?? '未出现确认弹窗（站点可能认为还有题未完成）' };
  }
  if (accept) log(`已提交：${message ?? '（无提示）'}`);
  return { submitted: accept, message };
}

/** 读取提交后才出现的「正确答案 / 解析」区域（用于回填校验，不参与作答） */
export function readPostSubmitAnswers(): string[] {
  const groups = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=radio]'));
  const byName = new Map<string, HTMLInputElement[]>();
  for (const r of groups) {
    const arr = byName.get(r.name) ?? [];
    arr.push(r);
    byName.set(r.name, arr);
  }
  const out: string[] = [];
  for (const arr of byName.values()) {
    const right = arr.find((x) => /right|correct|rightAnswer/i.test(x.className) || /right|correct/i.test(x.parentElement?.className ?? ''));
    out.push(right?.value ?? '');
  }
  return out;
}
