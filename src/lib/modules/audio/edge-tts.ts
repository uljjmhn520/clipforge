import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

export interface EdgeTtsVoice {
  id: string;
  name: string;
  gender: "female" | "male";
  description: string;
}

export const EDGE_TTS_VOICES: EdgeTtsVoice[] = [
  {
    id: "zh-CN-XiaoxiaoNeural",
    name: "晓晓 (热情带货女声 - 推荐)",
    gender: "female",
    description: "富有亲和力与感染力，电商带货与好物推荐官方默认首选",
  },
  {
    id: "zh-CN-YunxiNeural",
    name: "云希 (阳光自然男声)",
    gender: "male",
    description: "音色阳光清爽、自然流畅，适合生活好物与科技数码解说",
  },
  {
    id: "zh-CN-YunjianNeural",
    name: "云健 (专业影视解说男声)",
    gender: "male",
    description: "磁性沉稳、叙事感极强，适合剧情带货与品质大牌宣讲",
  },
  {
    id: "zh-CN-XiaoyiNeural",
    name: "晓伊 (活泼灵动女声)",
    gender: "female",
    description: "年轻活泼、语调明快，适合快节奏平价爆款短视频",
  },
];

export interface EdgeTtsOptions {
  text: string;
  outputAudioPath: string;
  outputVttPath?: string;
  voice?: string;
  rate?: string; // 默认 "+15%" 紧凑电商节奏
  pitch?: string; // 默认 "+0Hz"
}

export interface EdgeTtsResult {
  audioPath: string;
  vttPath?: string;
  durationSec: number;
  voice: string;
  rate: string;
}

function getEdgeTtsBinary(): string {
  const venvBin = path.join(process.cwd(), ".venv/bin/edge-tts");
  if (fs.existsSync(venvBin)) {
    return venvBin;
  }
  return "edge-tts";
}

/**
 * 微软 Edge-TTS 零成本高保真电商语音合成
 */
export async function synthesizeSpeech(options: EdgeTtsOptions): Promise<EdgeTtsResult> {
  const {
    text,
    outputAudioPath,
    outputVttPath,
    voice = "zh-CN-XiaoxiaoNeural",
    rate = "+15%",
    pitch = "+0Hz",
  } = options;

  if (!text || !text.trim()) {
    throw new Error("合成台词不能为空！");
  }

  // 确保输出目录存在
  const audioDir = path.dirname(outputAudioPath);
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  const vttTarget = outputVttPath || outputAudioPath.replace(/\.[^/.]+$/, ".vtt");
  const bin = getEdgeTtsBinary();

  return new Promise((resolve, reject) => {
    const args = [
      "--voice",
      voice,
      "--rate",
      rate,
      "--pitch",
      pitch,
      "--text",
      text,
      "--write-media",
      outputAudioPath,
      "--write-subtitles",
      vttTarget,
    ];

    console.log(`[EDGE-TTS] 正在合成语音: voice=${voice}, rate=${rate}, text="${text.slice(0, 30)}..."`);
    const runner = spawn(bin, args);

    let stderr = "";
    runner.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    runner.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputAudioPath)) {
        // 解析 VTT 文件获取准确总时长
        let durationSec = 4.0;
        if (fs.existsSync(vttTarget)) {
          try {
            const vttContent = fs.readFileSync(vttTarget, "utf-8");
            const timeMatches = [...vttContent.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g)];
            if (timeMatches.length >= 2) {
              const last = timeMatches[timeMatches.length - 1];
              const h = parseInt(last[1], 10);
              const m = parseInt(last[2], 10);
              const s = parseInt(last[3], 10);
              const ms = parseInt(last[4], 10);
              durationSec = +(h * 3600 + m * 60 + s + ms / 1000).toFixed(2);
            }
          } catch (e) {
            // 忽略时间戳解析错误
          }
        }

        console.log(`[EDGE-TTS] 语音合成成功! 文件: ${outputAudioPath}, 时长: ${durationSec}s`);
        resolve({
          audioPath: outputAudioPath,
          vttPath: fs.existsSync(vttTarget) ? vttTarget : undefined,
          durationSec,
          voice,
          rate,
        });
      } else {
        reject(new Error(`Edge-TTS 合成失败 (退出码 ${code}): ${stderr}`));
      }
    });

    runner.on("error", (err) => {
      reject(new Error(`无法启动 Edge-TTS 进程: ${err.message}`));
    });
  });
}
