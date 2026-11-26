// 书面作答（写作 / 多小题简答）的统一入口。
// 泛化要求（用户 2026-11-26）：题型会变，别把「一个输入框」写死。
//  * 内容里有多小题（questions[]）+ 页面上有多个输入框 → 逐框生成、逐框写入；
//  * 单输入框 → 沿用整段作文（essay）。
import { log } from '../core/log';
import {
  directionFromContent,
  fillTextArea,
  pickShortAnswerContent,
  shortAnswerItems,
  textInputs,
} from '../page/questions';
import { draftShortAnswers, draftSpeakingScript } from './judge';

export interface WritingFillResult {
  /** 实际写入成功的输入框数量 */
  filled: number;
  /** 生成出来的正文（按输入框顺序） */
  texts: string[];
  /** multi = 逐小题；single = 整段作文 */
  mode: 'multi' | 'single';
}

export async function fillWriting(content: unknown, fallbackPrompt: string, targetSec: number): Promise<WritingFillResult> {
  const inputs = textInputs();
  // 同页可能下发多帧内容 → 优先挑与输入框数量一致的那一帧（u6g630 实测：2 空 + 2 小题）
  const picked = pickShortAnswerContent();
  const src = picked ?? content;
  const items = src ? shortAnswerItems(src) : [];

  if (inputs.length >= 2 && items.length >= 2) {
    log(`多小题书面作答：${items.length} 小题 / ${inputs.length} 个输入框，逐题生成`);
    const hasText = items.some((it) => it.reference.length >= 20 || it.label.length >= 8);
    if (!hasText) log('多小题简答：页面没给文字线索（只有图片），只能按题目要求造句，质量可能下降');
    const texts = await draftShortAnswers({ direction: directionFromContent(src), items });
    let filled = 0;
    for (let i = 0; i < inputs.length; i++) {
      // 小题比输入框少时，用最后一条兜底，避免留空（留空会被站点判「未完成」）
      const text = texts[i] ?? texts[texts.length - 1] ?? '';
      if (!text) continue;
      if (await fillTextArea(inputs[i], text)) filled += 1;
      else log(`第 ${i + 1} 个输入框写入失败`);
    }
    return { filled, texts, mode: 'multi' };
  }

  const text = await draftSpeakingScript(fallbackPrompt, targetSec, 'essay');
  const target = inputs[0];
  const ok = target ? await fillTextArea(target, text) : false;
  return { filled: ok ? 1 : 0, texts: [text], mode: 'single' };
}
