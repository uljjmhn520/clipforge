import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { composeVideo, ComposeInputClip } from "@/lib/modules/composer/composer";
import { join } from "path";
import { existsSync, rmSync, mkdirSync } from "fs";
import { execSync } from "child_process";

describe("FFmpeg 硬件视频合成与字幕烧录测试", () => {
  const testDir = join(process.cwd(), "data", "test_composer");
  const clip1Path = join(testDir, "clip1.mp4");
  const clip2Path = join(testDir, "clip2.mp4");
  const audioPath = join(testDir, "audio.wav");
  const outPath = join(testDir, "final_test.mp4");

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // 生成两个测试视频 (2秒)
    execSync(`ffmpeg -y -f lavfi -i color=c=blue:s=720x1280:d=2:r=30 -c:v libx264 -pix_fmt yuv420p "${clip1Path}"`, { stdio: "ignore" });
    execSync(`ffmpeg -y -f lavfi -i color=c=red:s=720x1280:d=2:r=30 -c:v libx264 -pix_fmt yuv420p "${clip2Path}"`, { stdio: "ignore" });

    // 生成一段 4 秒测试音频
    execSync(`ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=4" "${audioPath}"`, { stdio: "ignore" });
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("能够将多镜头、配音、字幕及 AIGC 角标成功合成 9:16 成片", async () => {
    const clips: ComposeInputClip[] = [
      {
        videoPath: clip1Path,
        durationSec: 2,
        narrationAudioPath: audioPath,
        captionCards: [{ text: "镜头1：清凉一夏", startTime: 0, endTime: 1.8 }],
      },
      {
        videoPath: clip2Path,
        durationSec: 2,
        captionCards: [{ text: "镜头2：只要9.9包邮", startTime: 0, endTime: 1.8 }],
      },
    ];

    const res = await composeVideo({
      clips,
      outputPath: outPath,
      aigcBadge: true,
    });

    expect(existsSync(res.outputPath)).toBe(true);

    // 检查成片时长 (两段 2 秒拼接，总时长约为 4 秒)
    const probe = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${res.outputPath}"`).toString().trim();
    const duration = parseFloat(probe);
    expect(duration).toBeGreaterThanOrEqual(3.8);
    expect(duration).toBeLessThanOrEqual(4.2);
  }, 20000); // 20s 超时
});
