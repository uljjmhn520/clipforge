import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scripts, compositions, cloudTasks } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
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

    // 2. 否则返回所有项目的列表概览（包含进度阶段）
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

        // 计算当前步骤 (1~5)
        let step = 1; // 1: 商品基本信息
        let stepLabel = "草稿待生成";
        if (p.status === "completed") {
          step = 5;
          stepLabel = "已成片";
        } else if (p.status === "cloud_running" || p.status === "composing") {
          step = 4;
          stepLabel = "云端渲染中 (只读锁定)";
        } else if (p.status === "grid_approved" || p.status === "cloud_queued") {
          step = 4;
          stepLabel = "九宫格已审核通过，待合成";
        } else if (p.status === "grid_reviewing") {
          step = 3;
          stepLabel = "待人工审核九宫格";
        } else if (p.status === "scripting" || (s && s.shots && s.shots.length > 0)) {
          step = 2;
          stepLabel = "分镜剧本已生成";
        }

        return {
          id: p.id,
          name: p.name,
          productName: p.productName,
          productCategory: p.productCategory,
          productPrice: p.productPrice,
          status: p.status,
          step,
          stepLabel,
          shotsCount: s?.shots?.length || 0,
          externalPrompt: s?.externalPrompt || null,
          videoUrl: c?.outputPath ? `/outputs/${p.id}/final_video.mp4` : null,
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
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("id");

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    // 级联清理本地生成的文件与目录
    const projectDir = path.join(process.cwd(), "public", "outputs", projectId);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }

    // 级联清理数据库记录
    await db.delete(compositions).where(eq(compositions.projectId, projectId));
    await db.delete(cloudTasks).where(eq(cloudTasks.projectId, projectId));
    await db.delete(scripts).where(eq(scripts.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));

    return NextResponse.json({ success: true, message: `项目 ${projectId} 及其关联资源已成功彻底删除` });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
