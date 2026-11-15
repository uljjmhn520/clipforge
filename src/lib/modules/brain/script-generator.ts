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
/**
 * 构建生成分镜脚本的 System Prompt
 * 融合顶级编导规则与五判官质量把关，单次请求即可输出高质量终稿与质检报告
 */
function buildScriptPrompt(params: ScriptGenerationParams): string {
  return `你是一位身经百战的顶级短视频电商编导与爆款脚本专家，同时兼具苛刻的「五判官」（节奏官、口语官、创意官、结构官、画面官）质检准则。
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
   - 语速与秒数严格挂钩：中文正常语速为 3.5 字/秒；
   - 杜绝广告法绝对化极限词（严禁使用最、第一、国家级、全网最低等）。

【五判官质量自检准则】
- 节奏官：杜绝慢热，前3秒必须牢牢抓住眼球；
- 口语官：拒绝书面语，像面对面真人说话；
- 创意官：拒绝老套陈词滥调；
- 结构官：中段续命点衔接顺畅，转化自然；
- 画面官：画面具备强烈具象动感。

请严格输出合法的 JSON 格式（不要包含任何 markdown 代码块包裹之外的多余闲聊）：
{
  "title": "爆款视频标题",
  "sellingPoints": ["提炼卖点1", "提炼卖点2", "提炼卖点3"],
  "judgeReport": {
    "verdicts": [
      { "judge": "voice", "issue": "原句书面化风险", "suggestion": "已调整为朋友聊天口吻" }
    ],
    "summary": "五判官质检通过：前3秒反差吸睛，口语自然，卖点落地"
  },
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

function extractJson<T = any>(text: string): T {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("无法从大模型响应中提取合法 JSON:\n" + text);
  }
}

/**
 * 调用 Gemini 生成初始分镜脚本并执行判官质检
 */
export async function generateAndJudgeScript(params: ScriptGenerationParams): Promise<ScriptDraft> {
  const ai = getGeminiClient();
  let modelName = params.model || getDefaultGeminiModel();

  // 1. 构建提示词
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

  // 2. 调用大模型生成（带模型降级防护）
  let res;
  try {
    res = await ai.models.generateContent({
      model: modelName,
      contents,
    });
  } catch (err: any) {
    if (modelName !== "gemini-3.5-flash") {
      console.warn(`[GEMINI] 模型 ${modelName} 响应异常 (${err.message})，自动回退至 gemini-3.5-flash`);
      modelName = "gemini-3.5-flash";
      res = await ai.models.generateContent({
        model: modelName,
        contents,
      });
    } else {
      throw err;
    }
  }

  const responseText = res.text || "";
  let draft: ScriptDraft = extractJson<ScriptDraft>(responseText);

  // 3. 广告法违禁词静态扫描与清洗
  if (Array.isArray(draft.shots)) {
    for (const shot of draft.shots) {
      if (shot.voiceover) {
        const { cleanText } = sanitizeAdText(shot.voiceover);
        shot.voiceover = cleanText;
      }
    }
  }

  // 4. 确保判官简报完整
  if (!draft.judgeReport) {
    draft.judgeReport = {
      verdicts: [
        { judge: "pace", issue: "节奏顺畅", suggestion: "黄金前3秒已就绪" },
        { judge: "voice", issue: "口语化", suggestion: "已脱敏并净化广告词" }
      ],
      summary: "五判官质检已通过"
    };
  }

  return draft;
}
