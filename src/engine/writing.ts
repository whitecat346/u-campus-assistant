// 书面作答（写作 / 多小题简答）的统一入口。
// 泛化要求（用户 2026-11-26）：题型会变，别把「一个输入框」写死，也别把「一种题目要求」写死。
//  * 内容里有多小题（questions[]）+ 页面上有多个输入框 → 逐框生成、逐框写入；
//  * 作答形态由「题目要求」判定（词云造句 / 句子改错 / 其它），再选对应提示词；
//  * 单输入框 → 沿用整段作文（essay）。
import { log } from '../core/log';
import {
  directionFromContent,
  fillTextArea,
  pickShortAnswerContent,
  shortAnswerItems,
  stripLeadingNumber,
  textInputs,
  transcriptFromContent,
} from '../page/questions';
import { draftShortAnswers, draftSpeakingScript, shortAnswerMode } from './judge';

export interface WritingFillResult {
  /** 实际写入成功的输入框数量 */
  filled: number;
  /** 生成出来的正文（按输入框顺序） */
  texts: string[];
  /** multi = 逐小题；single = 整段作文 */
  mode: 'multi' | 'single';
}

const MODE_LABEL: Record<string, string> = {
  wordcloud: '词云造句',
  correct: '句子改错',
  generic: '按题目要求作答',
};

export async function fillWriting(content: unknown, fallbackPrompt: string, targetSec: number): Promise<WritingFillResult> {
  const inputs = textInputs();
  // 同页可能下发多帧内容 → 优先挑与输入框数量一致的那一帧（u6g630 实测：2 空 + 2 小题）
  const picked = pickShortAnswerContent();
  const src = picked ?? content;
  const items = src ? shortAnswerItems(src) : [];

  if (inputs.length >= 2 && items.length >= 2) {
    const direction = directionFromContent(src);
    const mode = shortAnswerMode(direction);
    const transcript = transcriptFromContent(src);
    log(
      `多小题书面作答：${items.length} 小题 / ${inputs.length} 个输入框，形态=${mode}（${MODE_LABEL[mode] ?? mode}）` +
        `${transcript ? `，有听力原文 ${transcript.length} 字` : ''}`,
    );
    const hasText = items.some((it) => it.reference.length >= 20 || it.label.length >= 8);
    if (!hasText) log('多小题简答：页面没给文字线索（只有图片），只能按题目要求造句，质量可能下降');

    let texts: string[] = [];
    try {
      texts = await draftShortAnswers({ direction, items, mode, transcript });
    } catch (err) {
      // 模型失败时，页面自带参考答案仍可用就先填它——留空会被判「未完成」，比空着强
      const fallback = items.map((it) => stripLeadingNumber(it.reference)).filter((t) => t.length >= 10);
      if (fallback.length === items.length) {
        log(`LLM 生成失败（${err instanceof Error ? err.message : String(err)}），改用页面自带参考答案`);
        texts = fallback;
      } else {
        throw err;
      }
    }

    let filled = 0;
    for (let i = 0; i < inputs.length; i++) {
      // 小题比输入框少时用最后一条兜底；比输入框多时只写前 N 条，避免留空
      const text = texts[i] ?? texts[texts.length - 1] ?? '';
      if (!text) continue;
      if (await fillTextArea(inputs[i], stripLeadingNumber(text))) filled += 1;
      else log(`第 ${i + 1} 个输入框写入失败`);
    }
    return { filled, texts, mode: 'multi' };
  }

  const text = await draftSpeakingScript(fallbackPrompt, targetSec, 'essay');
  const target = inputs[0];
  const ok = target ? await fillTextArea(target, text) : false;
  return { filled: ok ? 1 : 0, texts: [text], mode: 'single' };
}
