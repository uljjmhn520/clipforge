import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scripts, compositions, cloudTasks } from "@/lib/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import * as path from "path";
import * as fs from "fs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("id");

    // 1. 若传了 id，返回单条项目的完整详细数据（用于载入工作台）
    if (projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });

      if (!project) {
        return NextResponse.json({ error: "项目不存在" }, { status: 404 });
      }

      const script = await db.query.scripts.findFirst({
        where: eq(scripts.projectId, projectId),
      });

      const composition = await db.query.compositions.findFirst({
        where: eq(compositions.projectId, projectId),
      });

      const tasks = await db.query.cloudTasks.findMany({
        where: eq(cloudTasks.projectId, projectId),
      });

      return NextResponse.json({
        project,
        script,
        composition,
        tasks,
      });
    }

    // 2. 否则返回所有项目的列表概览（包含进度阶段与丰富媒体资源）
    const allProjects = await db.query.projects.findMany({
      orderBy: [desc(projects.createdAt)],
    });

    const enrichedList = await Promise.all(
      allProjects.map(async (p) => {
        const s = await db.query.scripts.findFirst({
          where: eq(scripts.projectId, p.id),
        });

        const c = await db.query.compositions.findFirst({
          where: eq(compositions.projectId, p.id),
        });

        const projectTasks = await db.query.cloudTasks.findMany({
          where: eq(cloudTasks.projectId, p.id),
        });

        const waitingTaskCount = projectTasks.filter(
          (t) => t.state === "waiting_for_cloud" || t.state === "submitted_to_inbox"
        ).length;
        const hasWaitingTasks = waitingTaskCount > 0;

        // 计算当前步骤 (1~5)
        let step = 1;
        let stepLabel = "草稿待生成";
        if (p.status === "completed") {
          step = 5;
          stepLabel = "已成片";
        } else if (p.status === "clips_ready") {
          step = 4;
          stepLabel = "分镜视频全部就绪，待本地合成";
        } else if (p.status === "cloud_running" || p.status === "composing") {
          step = 4;
          stepLabel = "云端渲染中 (只读锁定)";
        } else if (p.status === "grid_generating") {
          step = 3;
          stepLabel = "MiniMax-H3 云端生图中";
        } else if (p.status === "grid_approved" || p.status === "cloud_queued") {
          step = 4;
          stepLabel = "九宫格已审核通过，待下发";
        } else if (p.status === "grid_reviewing") {
          step = 3;
          stepLabel = "待人工审核九宫格";
        } else if (p.status === "scripting" || (s && s.shots && s.shots.length > 0)) {
          step = 2;
          stepLabel = "分镜剧本已生成";
        }

        // 探测成片地址
        const finalVideoPath = path.join(process.cwd(), "public", "outputs", p.id, "final_video.mp4");
        const videoUrl = fs.existsSync(finalVideoPath) || c?.outputPath
          ? `/outputs/${p.id}/final_video.mp4`
          : null;

        // 探测九宫格大图
        let gridImageUrl: string | null = null;
        const uploadDir = path.join(process.cwd(), "public", "uploads", p.id);
        if (fs.existsSync(uploadDir)) {
          const files = fs.readdirSync(uploadDir);
          const gridFile = files.find(f => f.startsWith("grid") || f.includes("nine_grid"));
          if (gridFile) {
            gridImageUrl = `/uploads/${p.id}/${gridFile}`;
          }
        }

        // 探测各镜头关键帧切片与分段视频
        const shots = (s?.shots || []).map((shot: any) => {
          let keyframeUrl: string | null = null;
          let clipUrl: string | null = null;

          // 探测切片关键帧
          const sliceNames = [
            `shot_0${shot.id}.png`,
            `shot_${shot.id}.png`,
            `shot_0${shot.id}.jpg`,
            `shot_${shot.id}.jpg`,
          ];
          for (const sName of sliceNames) {
            const sp = path.join(uploadDir, "slices", sName);
            if (fs.existsSync(sp)) {
              keyframeUrl = `/uploads/${p.id}/slices/${sName}`;
              break;
            }
          }

          // 探测分镜视频片段
          const clipDir = path.join(process.cwd(), "public", "outputs", p.id, "clips");
          if (fs.existsSync(clipDir)) {
            const clipFiles = fs.readdirSync(clipDir);
            const matchedClip = clipFiles.find(f => 
              f.includes(`shot_${shot.id}.mp4`) || 
              f.includes(`shot_0${shot.id}.mp4`) ||
              (clipFiles.length === 1 && f.endsWith(".mp4"))
            );
            if (matchedClip) {
              clipUrl = `/outputs/${p.id}/clips/${matchedClip}`;
            }
          }

          return {
            id: shot.id,
            description: shot.description,
            voiceover: shot.voiceover,
            durationSec: shot.durationSec,
            keyframeUrl,
            clipUrl,
            isClipReady: !!clipUrl,
          };
        });

        return {
          id: p.id,
          name: p.name,
          productName: p.productName,
          productCategory: p.productCategory,
          productPrice: p.productPrice,
          status: p.status,
          step,
          stepLabel,
          shotsCount: shots.length,
          shots,
          gridImageUrl,
          hasWaitingTasks,
          waitingTaskCount,
          externalPrompt: s?.externalPrompt || null,
          videoUrl,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        };
      })
    );

    return NextResponse.json({ projects: enrichedList });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    let idsToDelete: string[] = [];

    // 1. 尝试从 URL 参数解析单个 id
    const { searchParams } = new URL(req.url);
    const singleId = searchParams.get("id");
    if (singleId) {
      idsToDelete.push(singleId);
    } else {
      // 2. 尝试从 JSON Body 解析批量 ids
      try {
        const body = await req.json();
        if (body.ids && Array.isArray(body.ids)) {
          idsToDelete = body.ids;
        }
      } catch {
        // 请求体为空时忽略
      }
    }

    if (idsToDelete.length === 0) {
      return NextResponse.json({ error: "缺少待删除的项目 ID (id 或 ids)" }, { status: 400 });
    }

    for (const projectId of idsToDelete) {
      // 级联清理本地磁盘生成的视频产物
      const outputDir = path.join(process.cwd(), "public", "outputs", projectId);
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }

      // 级联清理本地上传的切片与九宫格
      const uploadDir = path.join(process.cwd(), "public", "uploads", projectId);
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    }

    // 级联清理 SQLite 数据库记录
    await db.delete(compositions).where(inArray(compositions.projectId, idsToDelete));
    await db.delete(cloudTasks).where(inArray(cloudTasks.projectId, idsToDelete));
    await db.delete(scripts).where(inArray(scripts.projectId, idsToDelete));
    await db.delete(projects).where(inArray(projects.id, idsToDelete));

    return NextResponse.json({
      success: true,
      deletedCount: idsToDelete.length,
      message: `已成功彻底删除 ${idsToDelete.length} 个视频项目及其关联的所有磁盘文件`,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
