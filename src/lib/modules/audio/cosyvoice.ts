import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface SynthesizeOptions {
  text: string;
  voice?: string;
  speed?: number;
  outputDir?: string;
  filename?: string;
}

export interface SynthesizeResult {
  audioPath: string;
  durationSec: number;
}

/**
 * 获取音频文件的物理实际时长 (秒)
 */
async function getAudioDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? null : duration;
  } catch {
    return null;
  }
}

/**
 * 使用 Edge-TTS 高性能无损配音 (隔离运行，无需全局依赖)
 */
async function synthesizeWithEdgeTTS(
  text: string,
  outputPath: string,
  voice?: string
): Promise<SynthesizeResult | null> {
  const uvPath = "/home/debian/.local/bin/uv";
  const selectedVoice = voice || process.env.EDGETTS_VOICE || "zh-CN-YunxiNeural";

  try {
    console.log(`[TTS-EDGE] 正在通过 Edge-TTS 生成主播配音 (音色: ${selectedVoice})...`);
    await execFileAsync(uvPath, [
      "run",
      "--with",
      "edge-tts",
      "edge-tts",
      "--voice",
      selectedVoice,
      "--text",
      text,
      "--write-media",
      outputPath,
    ]);

    if (existsSync(outputPath)) {
      const realDuration = await getAudioDuration(outputPath);
      const estDuration = realDuration || Math.max(1, Math.round(text.length / 3.5));
      console.log(`[TTS-EDGE] 配音生成成功: ${outputPath} (时长: ${estDuration}s)`);
      return {
        audioPath: outputPath,
        durationSec: estDuration,
      };
    }
  } catch (err: any) {
    console.warn(`[TTS-EDGE] Edge-TTS 执行异常: ${err.message}`);
  }
  return null;
}

/**
 * 商业合规配音 (支持 Edge-TTS / CosyVoice 2 / 本地伴生服务)
 */
export async function synthesizeVoice(options: SynthesizeOptions): Promise<SynthesizeResult> {
  const cleanText = options.text.trim();
  if (!cleanText) {
    throw new Error("配音文本为空！");
  }

  const outputDir = options.outputDir || join(process.cwd(), "data", "audio");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filename = options.filename || `tts_${Date.now()}.mp3`;
  const outputPath = join(outputDir, filename);

  const provider = process.env.TTS_PROVIDER || "edge-tts";

  // 1. 若配置为 edge-tts 或默认模式，优先使用高质量 Edge-TTS
  if (provider === "edge-tts" || provider === "default" || !process.env.COSYVOICE_API_KEY) {
    const edgeRes = await synthesizeWithEdgeTTS(cleanText, outputPath, options.voice);
    if (edgeRes) {
      return edgeRes;
    }
  }

  const isLocal =
    provider === "local" ||
    (process.env.COSYVOICE_BASE_URL || "").includes("127.0.0.1") ||
    (process.env.COSYVOICE_BASE_URL || "").includes("localhost");
  const baseUrl = (
    isLocal
      ? process.env.LOCAL_TTS_BASE_URL || process.env.COSYVOICE_BASE_URL || "http://127.0.0.1:8080/v1"
      : process.env.COSYVOICE_BASE_URL || "https://api.siliconflow.cn/v1"
  ).replace(/\/$/, "");

  const apiKey = process.env.COSYVOICE_API_KEY || (isLocal ? "local_token" : "");
  const model = isLocal ? "local-tts" : "FunAudioLLM/CosyVoice2-0.5B";
  const voice =
    options.voice ||
    process.env.COSYVOICE_DEFAULT_VOICE ||
    (isLocal ? "default" : "FunAudioLLM/CosyVoice2-0.5B:alex");

  // 2. 尝试走标准 HTTP 协议 (CosyVoice 或本地伴生服务)
  if (apiKey || isLocal) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: cleanText,
          voice,
          response_format: "mp3",
          speed: options.speed || 1.0,
        }),
      });

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        writeFileSync(outputPath, buffer);

        const realDuration = await getAudioDuration(outputPath);
        const estDuration = realDuration || Math.max(1, Math.round(cleanText.length / 3.5));
        return {
          audioPath: outputPath,
          durationSec: estDuration,
        };
      }
    } catch (err: any) {
      console.warn(`[TTS-API] 伴生服务连接异常: ${err.message}`);
    }
  }

  // 3. 兜底回退尝试 Edge-TTS
  const edgeFallback = await synthesizeWithEdgeTTS(cleanText, outputPath, options.voice);
  if (edgeFallback) {
    return edgeFallback;
  }

  // 4. 终极轻量静音占位兜底
  console.warn("[TTS] 各配音通道均不可用，生成离线静音占位音频推进链路...");
  const charCount = cleanText.length;
  const estDuration = Math.max(1, Math.round(charCount / 3.5));
  generateSilentWav(outputPath, estDuration);
  return {
    audioPath: outputPath,
    durationSec: estDuration,
  };
}

/**
 * 生成轻量占位 WAV 音频
 */
function generateSilentWav(filePath: string, durationSec: number): void {
  const sampleRate = 44100;
  const numChannels = 1;
  const bytesPerSample = 2;
  const totalSamples = sampleRate * durationSec;
  const dataSize = totalSamples * numChannels * bytesPerSample;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  writeFileSync(filePath, buffer);
}
