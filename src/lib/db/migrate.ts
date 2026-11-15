import Database from "better-sqlite3";

export function initDatabaseSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      product_name TEXT,
      product_category TEXT,
      product_description TEXT,
      product_price TEXT,
      product_images TEXT DEFAULT '[]',
      selling_points TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      selected_gemini_model TEXT DEFAULT 'gemini-3.8-flash',
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS scripts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      shots TEXT DEFAULT '[]',
      judge_report TEXT,
      grid_image_path TEXT,
      external_prompt TEXT,
      created_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cloud_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      shot_id INTEGER NOT NULL,
      session_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting_for_cloud',
      is_locked INTEGER NOT NULL DEFAULT 0,
      drive_output_path TEXT,
      local_video_path TEXT,
      error TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS compositions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      output_path TEXT NOT NULL,
      cover_path TEXT,
      duration_sec INTEGER,
      file_size_mb TEXT,
      created_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
}
