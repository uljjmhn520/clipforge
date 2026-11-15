/**
 * 语音与字幕时间戳对齐器
 * 提取单字/词级时间戳，构建短视频快速字幕卡 (Caption Cards)
 */

export interface WordTimestamp {
  word: string;
  startSec: number;
  endSec: number;
}

export interface CaptionCard {
  text: string;
  startTime: number;
  endTime: number;
}

/**
 * 将整句台词拆分为自然的短字幕卡（平均 0.6~1.2 秒一张卡），防止长句糊满屏幕
 * 电商 copy 规则：标点符号处切分，价格（如 ¥99.9）和小数点严禁拆开！
 */
export function splitIntoCaptionCards(
  text: string,
  startSec: number,
  endSec: number
): CaptionCard[] {
  const clean = text.trim();
  if (!clean) return [];

  // 标点符号分句（保留数字小数点和价格逗号不切断）
  const phrases: string[] = [];
  const chars = Array.from(clean);
  let cur = "";

  for (let i = 0; i < chars.length; i++) {
    cur += chars[i];
    const ch = chars[i];
    const prev = chars[i - 1];
    const next = chars[i + 1];

    // 如果是数字中间的点或逗号，绝不切断 (¥1,299 或 9.9)
    const isNumberDelimiter = (ch === "." || ch === ",") && /\d/.test(prev ?? "") && /\d/.test(next ?? "");

    if (!isNumberDelimiter && /[。！？；，、!?,;]/.test(ch)) {
      if (cur.trim()) {
        phrases.push(cur.trim());
        cur = "";
      }
    }
  }

  if (cur.trim()) {
    phrases.push(cur.trim());
  }

  // 若没有标点，按每 6~8 个字切成一段
  const finalPhrases = phrases.length > 0 ? phrases : chunkString(clean, 7);
  const totalDuration = Math.max(endSec - startSec, 0.5);
  const totalLength = finalPhrases.reduce((sum, p) => sum + p.length, 0);

  // 按每张卡文字长度权重分配起止时间
  let currentStart = startSec;
  return finalPhrases.map((phrase, idx) => {
    const fraction = phrase.length / totalLength;
    const cardDuration = totalDuration * fraction;
    const s = currentStart;
    const e = idx === finalPhrases.length - 1 ? endSec : currentStart + cardDuration;
    currentStart = e;

    return {
      text: phrase,
      startTime: Number(s.toFixed(2)),
      endTime: Number(e.toFixed(2)),
    };
  });
}

function chunkString(str: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}
