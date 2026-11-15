import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { slice3x3GridImage, replaceSingleCell } from "@/lib/modules/storyboard/slicer";
import sharp from "sharp";
import { join } from "path";
import { existsSync, rmSync, mkdirSync } from "fs";

describe("九宫格 3x3 几何切片引擎测试", () => {
  const testDir = join(process.cwd(), "data", "test_slice");
  const testGridImage = join(testDir, "test_grid.png");

  beforeAll(async () => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    // 生成一张 2304x4096 (9:16) 的测试九宫格图片
    await sharp({
      create: {
        width: 2304,
        height: 4096,
        channels: 3,
        background: { r: 240, g: 240, b: 240 },
      },
    })
      .png()
      .toFile(testGridImage);
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("应精确输出 9 张符合 9:16 几何等分比例的关键帧切片", async () => {
    const outputDir = join(testDir, "output_frames");
    const slices = await slice3x3GridImage(testGridImage, outputDir);

    expect(slices).toHaveLength(9);

    // 检查第 1 张和第 9 张切片是否存在且尺寸正确
    expect(existsSync(slices[0].filePath)).toBe(true);
    expect(slices[0].width).toBe(Math.floor(2304 / 3)); // 768
    expect(slices[0].height).toBe(Math.floor(4096 / 3)); // 1365

    // 宽高比检验: 768 / 1365 ≈ 0.5626 (9 / 16 = 0.5625)
    const ratio = slices[0].width / slices[0].height;
    expect(ratio).toBeCloseTo(9 / 16, 2);
  });

  it("应支持单格替换功能", async () => {
    const singleReplacePath = join(testDir, "replace_source.png");
    const targetShotPath = join(testDir, "output_frames", "shot_03.png");

    await sharp({
      create: {
        width: 500,
        height: 500,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(singleReplacePath);

    await replaceSingleCell(singleReplacePath, targetShotPath, 768, 1365);
    const meta = await sharp(targetShotPath).metadata();

    expect(meta.width).toBe(768);
    expect(meta.height).toBe(1365);
  });
});
