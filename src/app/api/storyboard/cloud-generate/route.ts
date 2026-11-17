import { NextResponse } from "next/server";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, sessionName, referenceImages } = body;

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    const task = await taskManager.submitGridImageToCloudQueue(projectId, sessionName, referenceImages);

    return NextResponse.json({
      success: true,
      taskId: task.id,
      message: "MiniMax-H3-Image 九宫格生图任务已生成并存入本地队列！Colab 云端开机握手就绪后将自动消费上传。",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
