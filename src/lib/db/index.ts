import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import { initDatabaseSchema } from "./migrate";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const dbPath = process.env.DATABASE_URL || "./data/clipforge.db";
const dir = join(process.cwd(), "data");

if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

export const sqlite = new Database(dbPath);

// 自动初始化建表，确保零配置启动
initDatabaseSchema(sqlite);

export const db = drizzle(sqlite, { schema });
