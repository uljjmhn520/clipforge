import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

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
 * 商业合规配音 (CosyVoice 2)
 * 优先调用官方商业授权端点 (硅基流动 / 阿里百炼)，亦支持无缝直连本地 T4 伴生推理端点
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

  const provider = process.env.TTS_PROVIDER || "cosyvoice";
  const isLocal = provider === "local" || (process.env.COSYVOICE_BASE_URL || "").includes("127.0.0.1") || (process.env.COSYVOICE_BASE_URL || "").includes("localhost");
  const baseUrl = (isLocal 
    ? (process.env.LOCAL_TTS_BASE_URL || process.env.COSYVOICE_BASE_URL || "http://127.0.0.1:8080/v1") 
    : (process.env.COSYVOICE_BASE_URL || "https://api.siliconflow.cn/v1")
  ).replace(/\/$/, "");

  const apiKey = process.env.COSYVOICE_API_KEY || (isLocal ? "local_token" : "");
  const model = isLocal ? "local-tts" : "FunAudioLLM/CosyVoice2-0.5B";
  const voice = options.voice || process.env.COSYVOICE_DEFAULT_VOICE || (isLocal ? "default" : "FunAudioLLM/CosyVoice2-0.5B:alex");

  // 若非本地服务且未配置 API Key，提供可用的模拟与免阻断降级保障
  if (!apiKey && !isLocal) {
    console.warn("[TTS] 未检测到云端 COSYVOICE_API_KEY，且未启动本地伴生服务，生成合规离线占位静音音频以便端到端链路正常推进...");
    const charCount = cleanText.length;
    const estDuration = Math.max(1, Math.round(charCount / 3.5)); // 按 3.5 字/秒计算时长
    
    // 用内置 Node 写一个极轻量标准 WAV 静音头
    generateSilentWav(outputPath, estDuration);
    return {
      audioPath: outputPath,
      durationSec: estDuration,
    };
  }

  // 走标准 OpenAI /audio/speech 协议 (本地或云端通用)
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

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`TTS 配音请求失败 (${response.status}): ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    writeFileSync(outputPath, buffer);

    const estDuration = Math.max(1, Math.round(cleanText.length / 3.5));
    return {
      audioPath: outputPath,
      durationSec: estDuration,
    };
  } catch (err: any) {
    if (isLocal) {
      console.warn(`[TTS-LOCAL] 本地伴生 TTS 服务 (${baseUrl}) 未响应或未启动: ${err.message}，降级使用静音占位头推进成片测试`);
      const estDuration = Math.max(1, Math.round(cleanText.length / 3.5));
      generateSilentWav(outputPath, estDuration);
      return {
        audioPath: outputPath,
        durationSec: estDuration,
      };
    }
    throw err;
  }
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
