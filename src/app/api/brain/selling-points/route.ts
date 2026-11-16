import { NextResponse } from "next/server";
import { getGeminiClient, resolveWorkingModel } from "@/lib/modules/brain/gemini-client";

export async function POST(req: Request) {
  try {
    const { productName, model } = await req.json();

    if (!productName || !productName.trim()) {
      return NextResponse.json({ error: "商品名称不能为空" }, { status: 400 });
    }

    const ai = getGeminiClient();
    const targetModel = resolveWorkingModel(model);

    const prompt = `你是一位拥有 10 年丰富操盘经验的中国电商带货与短视频爆款文案专家。
针对用户提供的商品名称：“${productName}”，请进行商业化提炼与分析：
1. 确定最契合的电商二级品类（如：冲调饮品、美妆个护、数码家电、居家日用、休闲零食等）；
2. 给出合理的电商促销价格建议（如：¥29.9、¥39.9、¥19.9 等）；
3. 提炼 3 个最具竞争力的核心卖点（突出质感、功效、方便性、原料或性价比）；
4. 提炼 3 个用户痛点场景（如下班疲惫、早起赶时间、预算有限、传统产品繁琐等）；
5. 综合以上提炼，编写一段 80~120 字的爆款带货描述文案（口语化、接地气、有代入感）。

请严格只返回以下 JSON 格式，绝不要包含 markdown 代码块包裹或其他多余字符：
{
  "category": "冲调饮品",
  "suggestedPrice": "¥29.9",
  "sellingPoints": ["0脂0糖", "3秒冷水速溶", "媲美现磨口感"],
  "painPoints": ["早八脑子昏沉", "每天买大牌咖啡太贵", "普通速溶发酸发苦"],
  "description": "0脂0糖低卡，3秒即溶，还原现磨美式浓郁风味！熬夜早八打工人续命神器，算下来一杯只要一块多，省钱又提神！"
}`;

    const response = await ai.models.generateContent({
      model: targetModel,
      contents: prompt,
      config: {
        temperature: 0.7,
        responseMimeType: "application/json",
      },
    });

    const text = response.text ? response.text.trim() : "";
    let cleanJson = text;
    if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.replace(/^```[a-z]*\n/, "").replace(/\n```$/, "");
    }
    const result = JSON.parse(cleanJson);

    return NextResponse.json(result);
  } catch (error: any) {
    console.warn("[SELLING-POINTS-API] 生成卖点异常，返回兜底策略:", error.message);
    // 智能保底
    return NextResponse.json({
      category: "热卖好物",
      suggestedPrice: "¥39.9",
      sellingPoints: ["精工品质", "高性价比", "即用即享"],
      painPoints: ["传统产品繁琐", "溢价过高", "体验不佳"],
      description: "高品质精工打磨，解决日常繁琐痛点，超高性价比带货爆款好物！",
    });
  }
}
