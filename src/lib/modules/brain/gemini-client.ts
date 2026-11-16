import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";

let cachedModels: string[] = [];
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 缓存 1 分钟

/**
 * 确保在各种运行环境 (Next.js / Vitest / CLI) 下均能可靠加载 .env
 */
function ensureEnvLoaded() {
  if (process.env.GEMINI_API_KEY) return;
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          let val = match[2] || "";
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          if (!process.env[match[1]]) {
            process.env[match[1]] = val;
          }
        }
      }
    }
  } catch (e) {}
}

/**
 * 获取 GoogleGenAI 客户端实例
 */
export function getGeminiClient(): GoogleGenAI {
  ensureEnvLoaded();
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

    // 排序：将 3.5-flash 排在最前，其次为 3.5-flash-lite / 3.6-flash
    models.sort((a, b) => {
      if (a === "gemini-3.5-flash") return -1;
      if (b === "gemini-3.5-flash") return 1;
      if (a.includes("3.5-flash") && !b.includes("3.5-flash")) return -1;
      if (!a.includes("3.5-flash") && b.includes("3.5-flash")) return 1;
      if (a.includes("flash") && !b.includes("flash")) return -1;
      if (!a.includes("flash") && b.includes("flash")) return 1;
      return a.localeCompare(b);
    });

    cachedModels = models;
    lastFetchTime = now;
    return cachedModels;
  } catch (error) {
    console.warn("[GEMINI] 动态获取模型列表失败，使用安全兜底列表:", error);
    // 兜底常用稳定模型
    return ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"];
  }
}

/**
 * 获取默认推荐模型 (优先读取环境变量，默认锁定稳定的 gemini-3.5-flash)
 */
export function getDefaultGeminiModel(): string {
  return process.env.DEFAULT_GEMINI_MODEL || "gemini-3.5-flash";
}

/**
 * 解析有效可用的模型名称
 */
export function resolveWorkingModel(model?: string): string {
  return model || getDefaultGeminiModel();
}
