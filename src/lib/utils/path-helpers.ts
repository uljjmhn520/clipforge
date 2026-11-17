import fs from "fs";
import path from "path";

/**
 * 统一路径处理规范：将任意物理路径或混合路径转为 Web 相对根路径 (/outputs/... 或 /uploads/...)
 * 彻底消除服务器端物理绝对路径暴露
 */
export function normalizeWebPath(filePath?: string | null): string | null {
  if (!filePath) return null;

  const trimmed = filePath.trim();
  if (!trimmed) return null;

  // 1. 如果包含 /public/outputs/，提取 /outputs/...
  if (trimmed.includes("/public/outputs/")) {
    return "/outputs/" + trimmed.split("/public/outputs/")[1];
  }

  // 2. 如果包含 /public/uploads/，提取 /uploads/...
  if (trimmed.includes("/public/uploads/")) {
    return "/uploads/" + trimmed.split("/public/uploads/")[1];
  }

  // 3. 如果包含 /outputs/ 且以服务端物理路径开头
  if (trimmed.includes("/outputs/")) {
    return "/outputs/" + trimmed.split("/outputs/")[1];
  }

  // 4. 如果包含 /uploads/ 且以服务端物理路径开头
  if (trimmed.includes("/uploads/")) {
    return "/uploads/" + trimmed.split("/uploads/")[1];
  }

  // 5. 若已是标准的以 / 开头的路径，直接返回
  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  return `/${trimmed}`;
}

/**
 * 将 Web 相对根路径 (/outputs/... 或 /uploads/...) 转回本地物理文件系统路径
 */
export function toLocalDiskPath(filePath?: string | null): string {
  if (!filePath) return "";
  const trimmed = filePath.trim();
  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
    return trimmed;
  }
  const clean = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const inPublic = path.join(process.cwd(), "public", clean);
  if (fs.existsSync(inPublic)) {
    return inPublic;
  }
  return path.join(process.cwd(), clean);
}

