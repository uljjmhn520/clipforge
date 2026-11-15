import { NextResponse } from "next/server";
import { composeVideo, ComposeInputClip } from "@/lib/modules/composer/composer";
import { synthesizeVoice } from "@/lib/modules/audio/cosyvoice";
import { splitIntoCaptionCards } from "@/lib/modules/audio/whisper-aligner";
import { taskManager } from "@/lib/modules/state-machine/task-manager";
import { db } from "@/lib/db";
import { scripts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, aigcBadge = true } = body;

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
    }

    const script = await db.query.scripts.findFirst({
      where: eq(scripts.projectId, projectId),
    });

    if (!script || !script.shots || script.shots.length === 0) {
      return NextResponse.json({ error: "未找到分镜数据" }, { status: 400 });
    }

    const outDir = join(process.cwd(), "public", "outputs", projectId);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const finalMp4Path = join(outDir, "final_video.mp4");
    const audioDir = join(outDir, "audio");

    // 1. 为每个分镜配音并生成字幕卡
    const clips: ComposeInputClip[] = [];
    let totalEstimatedSeconds = 0;

    for (let i = 0; i < script.shots.length; i++) {
      const shot = script.shots[i];
      const shotDuration = shot.durationSec || 5;
      totalEstimatedSeconds += shotDuration;

      // 生成配音
      const ttsRes = await synthesizeVoice({
        text: shot.voiceover,
        outputDir: audioDir,
        filename: `shot_${shot.id}_audio.mp3`,
      });

      // 生成字幕卡
      const cards = splitIntoCaptionCards(shot.voiceover, 0, shotDuration);

      // 视频路径：优先使用生成好的视频，若未就绪则使用关键帧静态图片或占位
      const videoSource = shot.videoPath || shot.keyframePath || join(process.cwd(), "public", "examples", "tissue.png");

      clips.push({
        videoPath: videoSource,
        durationSec: shotDuration,
        narrationAudioPath: ttsRes.audioPath,
        captionCards: cards,
      });
    }

    // 2. 调用 FFmpeg NVENC/libx264 进行终极合成
    const composeResult = await composeVideo({
      clips,
      outputPath: finalMp4Path,
      aigcBadge,
    });

    // 3. 记录成片终态
    await taskManager.completeProject(
      projectId,
      composeResult.outputPath,
      totalEstimatedSeconds,
      "12.5"
    );

    return NextResponse.json({
      success: true,
      videoUrl: `/outputs/${projectId}/final_video.mp4`,
      durationSec: totalEstimatedSeconds,
    });
  } catch (error: any) {
    console.error("[API-COMPOSE-RENDER] 合成失败:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
