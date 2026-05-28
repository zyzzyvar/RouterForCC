/**
 * 极简迁移运行器：按文件名顺序执行 .sql；schema_version 表记录已应用的版本。
 *
 * 新增迁移：在 migrations/ 下加 002_xxx.sql、003_xxx.sql 即可。
 */
import type { Database } from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MigrationFile {
  version: number;
  filename: string;
  fullPath: string;
}

function listMigrations(): MigrationFile[] {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".sql"));
  return files
    .map((f): MigrationFile | null => {
      const m = /^(\d+)_/.exec(f);
      if (!m) return null;
      const versionStr = m[1];
      if (!versionStr) return null;
      return { version: parseInt(versionStr, 10), filename: f, fullPath: join(__dirname, f) };
    })
    .filter((x): x is MigrationFile => x !== null)
    .sort((a, b) => a.version - b.version);
}

export function runMigrations(db: Database): void {
  // 确保 schema_version 表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map((r) => (r as { version: number }).version),
  );

  for (const mig of listMigrations()) {
    if (applied.has(mig.version)) continue;
    const sql = readFileSync(mig.fullPath, "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        mig.version,
        new Date().toISOString(),
      );
    });
    tx();
  }
}
