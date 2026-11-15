import { NextResponse } from "next/server";
import { colabClient } from "@/lib/modules/colab-rpc/client";

export async function GET() {
  const status = colabClient.getStatus();
  return NextResponse.json({
    sessionName: process.env.COLAB_SESSION_NAME || "clipforge_helloworld1234",
    ...status,
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action, minutes } = body;

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
