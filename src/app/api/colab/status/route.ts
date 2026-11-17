import { NextResponse } from "next/server";
import { colabClient } from "@/lib/modules/colab-rpc/client";
import { localTaskDispatcher } from "@/lib/modules/state-machine/local-dispatcher";
import { db } from "@/lib/db";
import { projects, scripts, cloudTasks } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { normalizeWebPath } from "@/lib/utils/path-helpers";

export async function GET() {
  const status = colabClient.getStatus();
  const localPendingCount = localTaskDispatcher.getPendingTasksCount();

  // 获取最近活跃或被编辑的项目
  let activeProject = null;
  try {
    const recentProjects = await db
      .select()
      .from(projects)
      .orderBy(desc(projects.updatedAt))
      .limit(1);

    if (recentProjects.length > 0) {
      const p = recentProjects[0];
      const scriptRows = await db
        .select()
        .from(scripts)
        .where(eq(scripts.projectId, p.id))
        .limit(1);
      const script = scriptRows[0] || null;

      const projectUploadsDir = path.join(process.cwd(), "public", "uploads", p.id);
      const gridFullExists = fs.existsSync(path.join(projectUploadsDir, "grid_full.png"));

      const shotsData = (script?.shots || []).map((s: any) => {
        let keyframeUrl = normalizeWebPath(s.keyframePath);
        if (!keyframeUrl) {
          const sliceFile = `shot_0${s.id}.png`;
          const slicePath = path.join(projectUploadsDir, "slices", sliceFile);
          if (fs.existsSync(slicePath)) {
            keyframeUrl = `/uploads/${p.id}/slices/${sliceFile}`;
          }
        }

        const videoUrl = normalizeWebPath(s.videoPath);

        return {
          id: s.id,
          type: s.type,
          description: s.description,
          voiceover: s.voiceover,
          durationSec: s.durationSec,
          status: s.status,
          keyframeUrl,
          videoUrl,
        };
      });

      // 收集该项目在 public/uploads 下已落盘的媒体文件
      const completedMedia: Array<{
        name: string;
        url: string;
        type: "image" | "video";
        sizeMb: number;
      }> = [];

      if (gridFullExists) {
        const stat = fs.statSync(path.join(projectUploadsDir, "grid_full.png"));
        completedMedia.push({
          name: "3x3 九宫格母图 (grid_full.png)",
          url: `/uploads/${p.id}/grid_full.png`,
          type: "image",
          sizeMb: Number((stat.size / (1024 * 1024)).toFixed(2)),
        });
      }

      const slicesDir = path.join(projectUploadsDir, "slices");
      if (fs.existsSync(slicesDir)) {
        const sliceFiles = fs.readdirSync(slicesDir).filter((f) => f.endsWith(".png")).sort();
        for (const sf of sliceFiles) {
          const stat = fs.statSync(path.join(slicesDir, sf));
          completedMedia.push({
            name: `分镜切片 (${sf})`,
            url: `/uploads/${p.id}/slices/${sf}`,
            type: "image",
            sizeMb: Number((stat.size / (1024 * 1024)).toFixed(2)),
          });
        }
      }

      const videosDir = path.join(projectUploadsDir, "videos");
      if (fs.existsSync(videosDir)) {
        const videoFiles = fs.readdirSync(videosDir).filter((f) => f.endsWith(".mp4")).sort();
        for (const vf of videoFiles) {
          const stat = fs.statSync(path.join(videosDir, vf));
          completedMedia.push({
            name: `分镜视频 (${vf})`,
            url: `/uploads/${p.id}/videos/${vf}`,
            type: "video",
            sizeMb: Number((stat.size / (1024 * 1024)).toFixed(2)),
          });
        }
      }

      activeProject = {
        id: p.id,
        name: p.name,
        productName: p.productName,
        status: p.status,
        shots: shotsData,
        completedMedia,
        gridFullUrl: gridFullExists ? `/uploads/${p.id}/grid_full.png` : null,
      };
    }
  } catch (err) {
    console.warn("Failed to fetch active project details:", err);
  }

  return NextResponse.json({
    ...status,
    localPendingTasksCount: localPendingCount,
    activeProject,
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action, minutes } = body;

    if (action === "power_on" || action === "start") {
      const gpu = body.gpu || "L4";
      const result = await colabClient.powerOn(gpu);
      return NextResponse.json(result);
    }

    if (action === "keep_alive") {
      colabClient.sendKeepAlive(minutes || 15);
      return NextResponse.json({ success: true, message: `已成功向 Colab 续命 ${minutes || 15} 分钟！` });
    }

    if (action === "terminate") {
      colabClient.terminateColab();
      return NextResponse.json({ success: true, message: "已向 Colab 发送停机指令，正在释放实例！" });
    }

    if (action === "connect") {
      colabClient.connect();
      return NextResponse.json({ success: true, message: "正在尝试连接 Colab 专属 Session..." });
    }

    if (action === "dispatch_local") {
      const res = await localTaskDispatcher.triggerDispatch();
      return NextResponse.json({
        success: true,
        message: `已触发本地队列扫描并派发！成功派发: ${res.dispatchedCount} 个任务`,
      });
    }

    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
