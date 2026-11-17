import { NextResponse } from "next/server";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, shotId, action = "video" } = body;

    if (!projectId || shotId === undefined) {
      return NextResponse.json({ error: "缺少 projectId 或 shotId" }, { status: 400 });
    }

    if (action === "video") {
      // 触发单分镜增量视频重渲
      await taskManager.submitToCloudQueue(projectId, undefined, Number(shotId));
      return NextResponse.json({
        success: true,
        message: `分镜 ${shotId} 视频重渲任务已成功下发云端队列！可在 Colab 看板查看渲染进度。`,
      });
    }

    return NextResponse.json({ error: "未知的重做操作类型" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
