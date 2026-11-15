import { getGeminiClient, getDefaultGeminiModel } from "./gemini-client";
import { sanitizeAdText, scanAdCompliance } from "./compliance";
import type { Shot } from "@/lib/db/schema";

export interface ScriptGenerationParams {
  productName: string;
  category?: string;
  description: string;
  price?: string;
  imagesBase64?: string[]; // 商品图片 Base64 数组
  model?: string;
}

export interface JudgeVerdict {
  judge: "pace" | "voice" | "idea" | "structure" | "visual";
  issue: string;
  suggestion: string;
}

export interface ScriptDraft {
  title: string;
  sellingPoints: string[];
  shots: Shot[];
  judgeReport?: {
    verdicts: JudgeVerdict[];
    summary: string;
  };
}

/**
 * 构建生成分镜脚本的 System Prompt
 */
function buildScriptPrompt(params: ScriptGenerationParams): string {
  return `你是一位身经百战的顶级短视频电商编导与爆款脚本专家。
你的目标是把商品转化为一条高转化、高留存、自然真实的 30 秒 9:16 竖屏带货短视频脚本。

【商品信息】
- 商品名称: ${params.productName}
- 商品品类: ${params.category || "通用日用百货"}
- 价格: ${params.price || "特惠价"}
- 核心卖点与痛点: ${params.description}

【硬性编导规则】
1. 镜头数量：严格生成 4 到 6 个分镜，总时长控制在 25~35 秒之间；
2. 镜头类型必须按顺序覆盖：
   - shot 1 (hook): 黄金前3秒！绝对禁止“大家好/今天给大家推荐”，必须从生活对话中间或惊人反差切入；
   - shot 2 (pain_point): 用户真实生活痛点具象化；
   - shot 3 (product_reveal): 商品实体高光亮相（说明包装、质感）；
   - shot 4 (demo): 主播或模特真实上手使用演示（撕开/挤出/喝下/按压等具体动词）；
   - shot 5 (cta / social_proof): 软紧迫感转化引导，呼吁点击左下角下单。
3. 画面描述 (description) 铁律：
   - 必须是“这一秒画面里谁在具体做什么”，严禁写“展示高端质感”等抽象虚词，必须是可见动作！
4. 配音文案 (voiceover) 铁律：
   - 严禁播音腔与书面金句，必须像闺蜜/朋友面对面聊天；
   - 语速与秒数严格挂钩：中文正常语速为 3.5 字/秒。

请严格输出合法的 JSON 格式（不要包含任何 markdown 代码块包裹之外的多余闲聊）：
{
  "title": "爆款视频标题",
  "sellingPoints": ["提炼卖点1", "提炼卖点2", "提炼卖点3"],
  "shots": [
    {
      "id": 1,
      "type": "hook",
      "description": "具体画面动作描述",
      "voiceover": "口语化配音台词",
      "durationSec": 5,
      "status": "pending"
    }
  ]
}`;
}

/**
 * 五判官质检与等长重写 Prompt
 */
function buildJudgePrompt(script: ScriptDraft): string {
  return `你是五位苛刻的毒舌短视频质检判官：
1. 节奏官 (Pace)：抓前3秒跳出率，杜绝慢热；
2. 口语官 (Voice)：抓书面语、解说腔，改写为真实脱口而出；
3. 创意官 (Idea)：抓老套陈词滥调；
4. 结构官 (Structure)：抓中段续命点与转化逻辑；
5. 画面官 (Visual)：抓假大空的抽象画面，强制改写为具体微动作。

请对以下脚本进行对抗式审查：
${JSON.stringify(script, null, 2)}

请执行两件事：
1. 列出发现的致命硬伤；
2. 给出重写后的 shots 列表（台词必须保持字数等长，不可丢失价格与数字事实）。

以 JSON 格式返回：
{
  "verdicts": [
    { "judge": "voice", "issue": "原句太书面", "suggestion": "改写为生活对话" }
  ],
  "rewrittenShots": [ ...等长改写后的完整 shots 列表... ],
  "summary": "质检总体评价"
}`;
}

/**
 * 调用 Gemini 生成初始分镜脚本并执行判官质检
 */
export async function generateAndJudgeScript(params: ScriptGenerationParams): Promise<ScriptDraft> {
  const ai = getGeminiClient();
  const modelName = params.model || getDefaultGeminiModel();

  // 1. 初稿生成
  const prompt = buildScriptPrompt(params);
  const contents: any[] = [{ text: prompt }];

  if (params.imagesBase64 && params.imagesBase64.length > 0) {
    for (const img of params.imagesBase64) {
      contents.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: img.replace(/^data:image\/\w+;base64,/, ""),
        },
      });
    }
  }

  const res = await ai.models.generateContent({
    model: modelName,
    contents,
  });

  const responseText = res.text || "";
  let jsonStr = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
  let draft: ScriptDraft;

  try {
    draft = JSON.parse(jsonStr);
  } catch (e) {
    // 粗粒度正则提取
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini 返回的分镜脚本无法解析为 JSON: " + responseText);
    draft = JSON.parse(match[0]);
  }

  // 2. 广告法违禁词静态扫描与清洗
  for (const shot of draft.shots) {
    const { cleanText } = sanitizeAdText(shot.voiceover);
    shot.voiceover = cleanText;
  }

  // 3. 执行五判官对抗审核与重写
  try {
    const judgePrompt = buildJudgePrompt(draft);
    const judgeRes = await ai.models.generateContent({
      model: modelName,
      contents: [{ text: judgePrompt }],
    });
    const judgeText = (judgeRes.text || "").replace(/```json/g, "").replace(/```/g, "").trim();
    const judgeJson = JSON.parse(judgeText);

    if (judgeJson.rewrittenShots && Array.isArray(judgeJson.rewrittenShots)) {
      draft.shots = judgeJson.rewrittenShots;
    }
    draft.judgeReport = {
      verdicts: judgeJson.verdicts || [],
      summary: judgeJson.summary || "质检完成",
    };
  } catch (err) {
    console.warn("[JUDGE] 五判官重写执行异常，保留合规初稿:", err);
  }

  return draft;
}
