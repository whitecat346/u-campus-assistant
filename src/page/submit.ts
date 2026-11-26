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
  await sleep(700);

  // 依次处理：信息框「确定」→ 确认框「确认」/「取消」
  let submitted = false;
  for (let round = 0; round < 4; round++) {
    const ok = findButton('确定');
    if (ok) {
      ok.click();
      await sleep(500);
      continue;
    }
    const yes = findButton('确认');
    const no = findButton('取消');
    if (yes || no) {
      if (accept && yes) {
        yes.click();
        submitted = true;
        await sleep(1200);
      } else if (no) {
        no.click();
        await sleep(300);
      }
      break;
    }
    await sleep(400);
  }

  // 抓取页面反馈（有的题会弹「本次得分」）
  const text = document.body.innerText;
  const m = text.match(/(本次得分[：:]?\s*[\d.]+[^\n]{0,20}|提交成功[^\n]{0,20}|小U[^\n]{0,30})/);
  const message = m ? m[1].trim() : undefined;
  if (submitted) log(`已提交：${message ?? '（无提示）'}`);
  return { submitted, message };
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
