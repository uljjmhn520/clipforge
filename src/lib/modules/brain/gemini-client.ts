import { GoogleGenAI } from "@google/genai";

let cachedModels: string[] = [];
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 缓存 1 分钟

/**
 * 获取 GoogleGenAI 客户端实例
 */
export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 未配置！请在 .env 中设置 Google AI Studio API Key。");
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * 动态拉取当前 Google 账号可用的模型列表
 * 并自动过滤出可用于文本/多模态生成的模型 (如 gemini-3.8-flash, gemini-2.0-flash 等)
 */
export async function listAvailableGeminiModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedModels.length > 0 && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const ai = getGeminiClient();
    const response = await ai.models.list();
    const models: string[] = [];

    for await (const model of response) {
      const name = model.name?.replace(/^models\//, "") || "";
      if (
        name.includes("gemini") &&
        !name.includes("embedding") &&
        !name.includes("aqa")
      ) {
        models.push(name);
      }
    }

    // 排序：将 3.8 / flash 排在最前
    models.sort((a, b) => {
      if (a.includes("3.8-flash")) return -1;
      if (b.includes("3.8-flash")) return 1;
      if (a.includes("flash") && !b.includes("flash")) return -1;
      if (!a.includes("flash") && b.includes("flash")) return 1;
      return a.localeCompare(b);
    });

    cachedModels = models;
    lastFetchTime = now;
    return cachedModels;
  } catch (error) {
    console.warn("[GEMINI] 动态获取模型列表失败，使用安全兜底列表:", error);
    // 兜底常用模型
    return ["gemini-3.8-flash", "gemini-3.8-pro", "gemini-2.5-flash", "gemini-2.0-flash"];
  }
}

/**
 * 获取默认推荐模型 (优先读取环境变量，默认 gemini-3.8-flash)
 */
export function getDefaultGeminiModel(): string {
  return process.env.DEFAULT_GEMINI_MODEL || "gemini-3.8-flash";
}
