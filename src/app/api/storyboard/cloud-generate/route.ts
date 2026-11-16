import { NextResponse } from "next/server";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, sessionName } = body;

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    const task = await taskManager.submitGridImageToCloudQueue(projectId, sessionName);

    return NextResponse.json({
      success: true,
      taskId: task.id,
      message: "MiniMax-H3-Image 九宫格生成任务已下发至云端队列！Colab 就绪后将自动生成并切片。",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
