import { NextResponse } from "next/server";
import { slice3x3GridImage } from "@/lib/modules/storyboard/slicer";
import { join } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, imageBase64 } = body;

    if (!projectId || !imageBase64) {
      return NextResponse.json({ error: "缺少 projectId 或 imageBase64 参数" }, { status: 400 });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(cleanBase64, "base64");

    const projectDir = join(process.cwd(), "public", "uploads", projectId);
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    const gridImagePath = join(projectDir, "grid_full.png");
    writeFileSync(gridImagePath, buffer);

    const slicesOutputDir = join(projectDir, "slices");
    const slices = await slice3x3GridImage(gridImagePath, slicesOutputDir);

    // 格式化为前端可访问的相对 URL
    const frames = slices.map((s) => ({
      index: s.index,
      url: `/uploads/${projectId}/slices/shot_${String(s.index).padStart(2, "0")}.png`,
    }));

    return NextResponse.json({
      success: true,
      gridImageUrl: `/uploads/${projectId}/grid_full.png`,
      frames,
    });
  } catch (error: any) {
    console.error("[API-STORYBOARD-SLICE] 切片异常:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
