import { NextResponse } from "next/server";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, sessionName } = body;

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    await taskManager.submitToCloudQueue(projectId, sessionName);

    return NextResponse.json({
      success: true,
      message: "任务已推入云端队列，前端已进入只读锁定状态！",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
