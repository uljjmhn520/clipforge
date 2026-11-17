import { NextResponse } from "next/server";
import { colabClient } from "@/lib/modules/colab-rpc/client";
import { localTaskDispatcher } from "@/lib/modules/state-machine/local-dispatcher";

export async function GET() {
  const status = colabClient.getStatus();
  const localPendingCount = localTaskDispatcher.getPendingTasksCount();
  return NextResponse.json({
    ...status,
    localPendingTasksCount: localPendingCount,
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action, minutes } = body;

    if (action === "power_on" || action === "start") {
      const gpu = body.gpu || "L4";
      const result = await colabClient.powerOn(gpu);
      return NextResponse.json(result);
    }

    if (action === "keep_alive") {
      colabClient.sendKeepAlive(minutes || 15);
      return NextResponse.json({ success: true, message: `已成功向 Colab 续命 ${minutes || 15} 分钟！` });
    }

    if (action === "terminate") {
      colabClient.terminateColab();
      return NextResponse.json({ success: true, message: "已向 Colab 发送停机指令，正在释放实例！" });
    }

    if (action === "connect") {
      colabClient.connect();
      return NextResponse.json({ success: true, message: "正在尝试连接 Colab 专属 Session..." });
    }

    return NextResponse.json({ error: "未知操作" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
