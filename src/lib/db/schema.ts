import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// 项目表
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  productName: text("product_name"),
  productCategory: text("product_category"),
  productDescription: text("product_description"),
  productPrice: text("product_price"),
  productImages: text("product_images", { mode: "json" }).$type<string[]>().default([]),
  sellingPoints: text("selling_points", { mode: "json" }).$type<string[]>().default([]),
  status: text("status", {
    enum: ["draft", "scripting", "grid_reviewing", "grid_approved", "cloud_queued", "cloud_running", "composing", "completed"]
  }).notNull().default("draft"),
  selectedGeminiModel: text("selected_gemini_model").default("gemini-3.8-flash"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 分镜与剧本表
export interface Shot {
  id: number;                // 1-based index (1~9)
  type: "hook" | "pain_point" | "product_reveal" | "demo" | "social_proof" | "cta";
  description: string;       // 视觉画面与动作描述
  voiceover: string;         // 配音文案
  durationSec: number;       // 预估时长 (秒)
  keyframePath?: string;     // 裁切后的 9:16 关键帧本地路径
  isCustomReplaced?: boolean;// 是否被人为手动单独替换
  status: "pending" | "approved" | "rendering" | "done";
  videoPath?: string;        // 生成的视频文件路径
}

export const scripts = sqliteTable("scripts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title"),
  shots: text("shots", { mode: "json" }).$type<Shot[]>().default([]),
  judgeReport: text("judge_report", { mode: "json" }), // 五判官审查与重写报告
  gridImagePath: text("grid_image_path"),              // 3x3 九宫格整图路径
  externalPrompt: text("external_prompt"),             // 适配 Google Flow / Midjourney 的提示词
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 云端任务状态表 (高可靠状态机 & 锁机制)
export const cloudTasks = sqliteTable("cloud_tasks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  shotId: integer("shot_id").notNull(),
  sessionName: text("session_name").notNull(),
  state: text("state", {
    enum: ["waiting_for_cloud", "submitted_to_inbox", "generating", "done_in_drive", "failed"]
  }).notNull().default("waiting_for_cloud"),
  isLocked: integer("is_locked", { mode: "boolean" }).notNull().default(false), // 🔒 云端运行期间前端加锁
  driveOutputPath: text("drive_output_path"),
  localVideoPath: text("local_video_path"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// 成片合成记录表
export const compositions = sqliteTable("compositions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  outputPath: text("output_path").notNull(),
  coverPath: text("cover_path"),
  durationSec: integer("duration_sec"),
  fileSizeMb: text("file_size_mb"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});
