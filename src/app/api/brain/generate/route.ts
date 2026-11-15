import { NextResponse } from "next/server";
import { generateAndJudgeScript } from "@/lib/modules/brain/script-generator";
import { exportExternalGridPrompt } from "@/lib/modules/brain/prompt-exporter";
import { taskManager } from "@/lib/modules/state-machine/task-manager";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { productName, category, description, price, imagesBase64, model } = body;

    if (!productName || !description) {
      return NextResponse.json({ error: "商品名称和核心卖点描述不能为空！" }, { status: 400 });
    }

    // 1. 创建数据库项目草稿
    const project = await taskManager.createProject({
      name: `${productName}带货视频`,
      productName,
      productCategory: category,
      productDescription: description,
      productPrice: price,
      productImages: imagesBase64 || [],
    });

    // 2. 调用 Gemini 生成带货分镜并执行五判官对抗审核
    const scriptDraft = await generateAndJudgeScript({
      productName,
      category,
      description,
      price,
      imagesBase64,
      model,
    });

    // 3. 生成针对 Google Flow / Midjourney 的提示词
    const googleFlowPrompt = exportExternalGridPrompt(scriptDraft.shots, productName, "google-flow");
    const midjourneyPrompt = exportExternalGridPrompt(scriptDraft.shots, productName, "midjourney");

    // 4. 更新持久化数据库
    const script = await taskManager.updateProjectScript(project.id, {
      title: scriptDraft.title,
      shots: scriptDraft.shots,
      judgeReport: scriptDraft.judgeReport,
      externalPrompt: googleFlowPrompt,
    });

    return NextResponse.json({
      projectId: project.id,
      scriptId: script.id,
      title: scriptDraft.title,
      sellingPoints: scriptDraft.sellingPoints,
      shots: scriptDraft.shots,
      judgeReport: scriptDraft.judgeReport,
      prompts: {
        googleFlow: googleFlowPrompt,
        midjourney: midjourneyPrompt,
      },
    });
  } catch (error: any) {
    console.error("[API-BRAIN-GENERATE] 错误:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
