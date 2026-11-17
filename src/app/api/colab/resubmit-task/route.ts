import { NextResponse } from "next/server";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId } = body;

    if (!projectId) {
      return NextResponse.json({ error: "缺少 projectId 参数" }, { status: 400 });
    }

    const result = await taskManager.resubmitProjectTasks(projectId);

    return NextResponse.json({
      success: true,
      mode: result.mode,
      message: result.message,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
