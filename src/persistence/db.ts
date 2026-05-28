/**
 * SQLite 连接管理。
 * 用 better-sqlite3：同步 API、性能好、零额外进程。
 */
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { runMigrations } from "./migrations/runner.js";

export interface DbConfig {
  filepath: string;          // SQLite 文件绝对路径，或 ":memory:"
}

function expandPath(p: string): string {
  if (p === ":memory:") return p;
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

let _db: DB | null = null;

export function openDatabase(config: DbConfig): DB {
  const filepath = expandPath(config.filepath);

  if (filepath !== ":memory:") {
    const dir = dirname(filepath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new Database(filepath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  runMigrations(db);

  return db;
}

/**
 * 单例：服务进程内共享一个 DB 连接。
 * 测试可以用 openDatabase 直接拿独立连接。
 */
export function getDb(config?: DbConfig): DB {
  if (_db) return _db;
  if (!config) throw new Error("getDb: must supply config on first call");
  _db = openDatabase(config);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
