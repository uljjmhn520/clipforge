import { NextResponse } from "next/server";
import { slice3x3GridImage } from "@/lib/modules/storyboard/slicer";
import { taskManager } from "@/lib/modules/state-machine/task-manager";
import { join } from "path";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "fs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
    }

    const slicesDir = join(process.cwd(), "public", "uploads", projectId, "slices");
    if (!existsSync(slicesDir)) {
      return NextResponse.json({ frames: [] });
    }

    const files = readdirSync(slicesDir)
      .filter((f) => f.endsWith(".png"))
      .sort();

    const frames = files.map((file, idx) => {
      const filePath = join(slicesDir, file);
      const buf = readFileSync(filePath);
      return {
        index: idx + 1,
        url: `data:image/png;base64,${buf.toString("base64")}`,
        filePath,
      };
    });

    return NextResponse.json({ frames });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    let { projectId, imageBase64 } = body;

    if (!imageBase64) {
      return NextResponse.json({ error: "缺少 imageBase64 参数" }, { status: 400 });
    }

    // 若未传入 projectId，自动创建草稿项目，避免报错
    if (!projectId) {
      const proj = await taskManager.createProject({
        name: "九宫格导入项目",
        productName: "导入商品",
        productDescription: "手动上传九宫格生成",
      });
      projectId = proj.id;
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

    // 格式化为前端可直接展示的 base64 与 URL，确保绝不发生 404 图片显示错误
    const frames = slices.map((s) => {
      const sliceBuf = readFileSync(s.filePath);
      const dataUri = `data:image/png;base64,${sliceBuf.toString("base64")}`;
      return {
        index: s.index,
        url: dataUri,
        filePath: s.filePath,
      };
    });

    return NextResponse.json({
      success: true,
      projectId,
      gridImageUrl: `data:image/png;base64,${cleanBase64}`,
      frames,
    });
  } catch (error: any) {
    console.error("[API-STORYBOARD-SLICE] 切片异常:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
