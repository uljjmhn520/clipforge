import { describe, it, expect } from "vitest";
import { splitIntoCaptionCards } from "@/lib/modules/audio/whisper-aligner";

describe("短视频字幕卡智能切分与防断切测试", () => {
  it("应在标点处切分自然短卡", () => {
    const text = "就这玩意儿，把我的星巴克钱包给救了！一口下去透心凉，简直太爽了。";
    const cards = splitIntoCaptionCards(text, 0, 5.0);

    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(cards[0].startTime).toBe(0);
    expect(cards[cards.length - 1].endTime).toBe(5.0);
  });

  it("电商价格千分位与小数点绝不切断", () => {
    const text = "限时立减只要9.9包邮，大礼包也只要¥1,299！真的太香了！";
    const cards = splitIntoCaptionCards(text, 0, 4.0);

    const fullCaptured = cards.map((c) => c.text).join("");
    expect(fullCaptured).toContain("9.9");
    expect(fullCaptured).toContain("¥1,299");

    // 检查任何单张卡内部是否错误切断了 9.9
    for (const card of cards) {
      if (card.text.includes("9")) {
        expect(card.text).not.toBe("9.");
      }
    }
  });
});
