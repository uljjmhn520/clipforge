import { describe, it, expect } from "vitest";
import { scanAdCompliance, sanitizeAdText } from "@/lib/modules/brain/compliance";

describe("广告法极限词前置静态审查测试", () => {
  it("能够精准捕获绝对化极限词", () => {
    const dirty = "这款冷萃咖啡液是全网最低价，国家级第一品牌，效果独家！";
    const violations = scanAdCompliance(dirty);

    expect(violations.length).toBeGreaterThanOrEqual(3);
    const words = violations.map((v) => v.word);
    expect(words).toContain("全网最低");
    expect(words).toContain("国家级");
  });

  it("能够自动净化脱敏并替换为温和合规词", () => {
    const dirty = "全网最低、保证百分之百包瘦，错过等一年！";
    const { cleanText, replacedCount } = sanitizeAdText(dirty);

    expect(replacedCount).toBeGreaterThanOrEqual(3);
    expect(cleanText).not.toContain("全网最低");
    expect(cleanText).not.toContain("包瘦");
    expect(cleanText).not.toContain("百分之百");
    expect(cleanText).toContain("性价比出众");
  });
});
