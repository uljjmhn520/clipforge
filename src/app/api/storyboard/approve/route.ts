import { NextResponse } from "next/server";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId } = body;

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    await taskManager.approveGrid(projectId);

    return NextResponse.json({
      success: true,
      message: "九宫格关键帧已人工审核通过，已解锁云端视频生成权限！",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
