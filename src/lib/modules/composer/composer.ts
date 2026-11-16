import ffmpeg from "fluent-ffmpeg";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { CaptionCard } from "../audio/whisper-aligner";
import { VOICE_DE_BROADCAST_FILTER, buildRoomToneSource } from "../audio/voice-ground";

export interface ComposeInputClip {
  videoPath: string;
  durationSec: number;
  narrationAudioPath?: string;
  captionCards?: CaptionCard[];
}

export interface ComposeOptions {
  clips: ComposeInputClip[];
  outputPath: string;
  aigcBadge?: boolean;         // 前3秒是否烧录 AIGC 标识 (GB45438 规范，默认开启)
  productName?: string;
  fontFile?: string;
}

/**
 * 获取安全合规的思源黑体物理路径
 */
export function getSafeSubtitleFont(): string {
  const candidates = [
    join(process.cwd(), "assets", "fonts", "subtitle.otf"),
    join(process.cwd(), "public", "fonts", "subtitle.otf"),
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  ];
  return candidates.find((p) => existsSync(p)) || "";
}

/**
 * 组装 FFmpeg drawtext 滤镜转义
 */
function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\\\:")
    .replace(/\[/g, "\\\\[")
    .replace(/\]/g, "\\\\]");
}

/**
 * 核心视频合成函数
 * Tesla T4 硬件加速 (h264_nvenc) + 流规范化 + 字幕烧录 + AIGC标识 + Voice Grounding 混音
 */
export async function composeVideo(options: ComposeOptions): Promise<{ outputPath: string }> {
  const { clips, outputPath, aigcBadge = true } = options;

  if (clips.length === 0) {
    throw new Error("合成镜头列表为空！");
  }

  const outDir = join(outputPath, "..");
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const fontPath = options.fontFile || getSafeSubtitleFont();
  const fontArg = fontPath ? `fontfile='${fontPath.replace(/\\/g, "/").replace(/:/g, "\\:")}':` : "";

  // 1. 构建 FFmpeg 命令实例
  const command = ffmpeg();

  // 添加所有视频片段输入 (兼容真实 mp4 与静态关键帧图片)
  clips.forEach((clip) => {
    const isImage = /\.(png|jpe?g|webp)$/i.test(clip.videoPath);
    if (isImage) {
      command.input(clip.videoPath).inputOptions(["-loop 1", `-t ${clip.durationSec || 5}`]);
    } else {
      command.input(clip.videoPath);
    }
  });

  // 添加所有音频片段输入
  const audioInputIndices: number[] = [];
  let currentInputIndex = clips.length;
  clips.forEach((clip) => {
    if (clip.narrationAudioPath && existsSync(clip.narrationAudioPath)) {
      command.input(clip.narrationAudioPath);
      audioInputIndices.push(currentInputIndex++);
    }
  });

  // 2. 组装复杂的 filter_complex 滤镜链
  const filterGraph: string[] = [];
  const normalizedVideoTags: string[] = [];

  // 规范化每一个视频流 (1080x1920 竖屏, 30fps, 自动克隆末帧对齐时长)
  clips.forEach((clip, idx) => {
    const normTag = `v_norm_${idx}`;
    const dur = clip.durationSec || 5;
    filterGraph.push(
      `[${idx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p,setsar=1,fps=30,settb=AVTB,tpad=stop_mode=clone:stop_duration=${dur},trim=duration=${dur}[${normTag}]`
    );
    normalizedVideoTags.push(`[${normTag}]`);
  });

  // Concat 所有视频流
  const concatTag = "v_concat";
  filterGraph.push(
    `${normalizedVideoTags.join("")}concat=n=${clips.length}:v=1:a=0[${concatTag}]`
  );

  // 3. 字幕与 AIGC 角标绘制
  let currentVideoTag = concatTag;
  let drawFilterIndex = 0;

  // AIGC 角标 (前 3 秒显示在右上角)
  if (aigcBadge) {
    const badgeTag = `v_badge`;
    const badgeText = escapeDrawText("AI 辅助生成");
    filterGraph.push(
      `[${currentVideoTag}]drawtext=${fontArg}text='${badgeText}':fontsize=30:fontcolor=white@0.85:box=1:boxcolor=black@0.45:boxborderw=8:x=w-tw-40:y=50:enable='between(t,0,3)'[${badgeTag}]`
    );
    currentVideoTag = badgeTag;
  }

  // 烧录每个镜头的字幕卡
  let accumulatedTime = 0;
  clips.forEach((clip) => {
    if (clip.captionCards && clip.captionCards.length > 0) {
      clip.captionCards.forEach((card) => {
        const subTag = `v_sub_${drawFilterIndex++}`;
        const escaped = escapeDrawText(card.text);
        const start = accumulatedTime + card.startTime;
        const end = accumulatedTime + card.endTime;

        // 底部居中字幕卡 (带半透明底框，适配 1080p 竖屏 UI 避空区)
        filterGraph.push(
          `[${currentVideoTag}]drawtext=${fontArg}text='${escaped}':fontsize=48:fontcolor=white:borderw=3:bordercolor=black@0.85:box=1:boxcolor=black@0.45:boxborderw=10:x=(w-tw)/2:y=h-th-220:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[${subTag}]`
        );
        currentVideoTag = subTag;
      });
    }
    accumulatedTime += clip.durationSec;
  });

  // 4. 音频混音 (Voice Grounding)
  let finalAudioTag = "";
  if (audioInputIndices.length > 0) {
    // 将各段配音 concat
    const audioTags = audioInputIndices.map((idx) => `[${idx}:a]`);
    const narrationConcatTag = "a_narration_raw";
    filterGraph.push(`${audioTags.join("")}concat=n=${audioInputIndices.length}:v=0:a=1[${narrationConcatTag}]`);

    // 对配音应用麦克风 EQ 模拟
    const groundedTag = "a_grounded";
    filterGraph.push(`[${narrationConcatTag}]${VOICE_DE_BROADCAST_FILTER}[${groundedTag}]`);

    finalAudioTag = groundedTag;
  }

  // 5. 执行 FFmpeg 输出配置
  return new Promise((resolve, reject) => {
    command
      .complexFilter(filterGraph)
      .outputOptions([
        "-map", `[${currentVideoTag}]`,
        ...(finalAudioTag ? ["-map", `[${finalAudioTag}]`] : []),
        "-c:v", "libx264",
        "-preset", "medium",
        "-b:v", "3500k",
        "-maxrate", "5000k",
        "-bufsize", "7000k",
        "-pix_fmt", "yuv420p",
        ...(finalAudioTag ? ["-c:a", "aac", "-b:a", "192k", "-ar", "44100"] : []),
        "-metadata", "comment=AIGC;GeneratedByClipForge",
      ])
      .output(outputPath)
      .on("end", () => {
        console.log(`[COMPOSER] 视频合成完成: ${outputPath}`);
        resolve({ outputPath });
      })
      .on("error", (err, stdout, stderr) => {
        console.error(`[COMPOSER] FFmpeg 合成失败:`, err.message);
        reject(new Error(`FFmpeg 执行失败: ${err.message}`));
      })
      .run();
  });
}
