import { describe, it, expect } from "vitest";
import { synthesizeSpeech, EDGE_TTS_VOICES } from "../src/lib/modules/audio/edge-tts";
import * as path from "path";
import * as fs from "fs";

describe("Edge-TTS 电商高保真配音模块测试", () => {
  it("1. 能够导出官方推荐预设音色库", () => {
    expect(EDGE_TTS_VOICES.length).toBeGreaterThanOrEqual(4);
    const xiaoxiao = EDGE_TTS_VOICES.find((v) => v.id === "zh-CN-XiaoxiaoNeural");
    expect(xiaoxiao).toBeDefined();
    expect(xiaoxiao?.name).toContain("晓晓");
  });

  it("2. 能够以 +15% 紧凑电商语速成功合成 MP3 音频与 VTT 字幕时间戳", async () => {
    const outAudio = path.join(process.cwd(), "temp/test_edge_tts.mp3");
    const outVtt = path.join(process.cwd(), "temp/test_edge_tts.vtt");

    const res = await synthesizeSpeech({
      text: "早上好，今天为大家推荐这款高性价比的爆款好物！",
      outputAudioPath: outAudio,
      outputVttPath: outVtt,
      voice: "zh-CN-XiaoxiaoNeural",
      rate: "+15%",
    });

    expect(res.durationSec).toBeGreaterThan(0);
    expect(fs.existsSync(outAudio)).toBe(true);
    expect(fs.statSync(outAudio).size).toBeGreaterThan(1000);
    expect(res.vttPath).toBeDefined();

    // 清理
    if (fs.existsSync(outAudio)) fs.unlinkSync(outAudio);
    if (fs.existsSync(outVtt)) fs.unlinkSync(outVtt);
  });
});
