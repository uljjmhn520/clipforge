import { NextResponse } from "next/server";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, sessionName, shotId } = body;

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    await taskManager.submitToCloudQueue(projectId, sessionName, shotId);

    const msg = shotId
      ? `分镜 ${shotId} 重绘渲染任务已单独推入云端队列，其他已完成分镜保持不变！`
      : "全部分镜任务已推入云端队列，前端已进入只读锁定状态！";

    return NextResponse.json({
      success: true,
      message: msg,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
