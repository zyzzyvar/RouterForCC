/**
 * 模型注册表 CRUD。
 *
 * 完整 ModelEntry 以 JSON 字符串存到 entry_json 列；少数索引字段单列存放。
 */
import type { Database } from "better-sqlite3";
import {
  ModelEntrySchema,
  type ModelEntry,
  type ModelEntryInput,
  type ModelSummary,
} from "../core/types.js";
import { CalibrationStateSchema } from "../core/schemas.js";

export interface ModelFilter {
  status?: "active" | "deprecated" | "experimental";
  deployment_type?: "hosted" | "local";
  vendor?: string;
}

export class ModelRegistry {
  constructor(private db: Database) {}

  /** 注册新模型；若已存在则抛错 */
  register(input: ModelEntryInput): ModelEntry {
    const now = new Date().toISOString();
    const calibration =
      input.calibration ?? this.buildInitialCalibration(input.capability_scores, now);

    const entry: ModelEntry = ModelEntrySchema.parse({
      ...input,
      registered_at: now,
      last_updated_at: now,
      calibration,
    });

    this.db
      .prepare(
        `INSERT INTO model_entries (id, display_name, vendor, version, status, deployment_type, registered_at, last_updated_at, entry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.display_name,
        entry.vendor,
        entry.version,
        entry.status,
        entry.deployment_type,
        entry.registered_at,
        entry.last_updated_at,
        JSON.stringify(entry),
      );

    return entry;
  }

  /** 整体替换（不是 patch）；用于注册时已有同 id 的覆盖更新 */
  upsert(input: ModelEntryInput): ModelEntry {
    const existing = this.tryGet(input.id);
    const now = new Date().toISOString();

    const calibration =
      input.calibration ?? existing?.calibration ?? this.buildInitialCalibration(input.capability_scores, now);

    const entry: ModelEntry = ModelEntrySchema.parse({
      ...input,
      registered_at: existing?.registered_at ?? now,
      last_updated_at: now,
      calibration,
    });

    this.db
      .prepare(
        `INSERT INTO model_entries (id, display_name, vendor, version, status, deployment_type, registered_at, last_updated_at, entry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           vendor = excluded.vendor,
           version = excluded.version,
           status = excluded.status,
           deployment_type = excluded.deployment_type,
           last_updated_at = excluded.last_updated_at,
           entry_json = excluded.entry_json`,
      )
      .run(
        entry.id,
        entry.display_name,
        entry.vendor,
        entry.version,
        entry.status,
        entry.deployment_type,
        entry.registered_at,
        entry.last_updated_at,
        JSON.stringify(entry),
      );

    return entry;
  }

  /** 部分更新；典型用于改 Layer 3 软标签、status、Layer 2 分数。 */
  patch(id: string, patch: Partial<ModelEntry>): ModelEntry {
    const existing = this.get(id);
    const merged: ModelEntry = ModelEntrySchema.parse({
      ...existing,
      ...patch,
      id: existing.id, // 不允许改 id
      registered_at: existing.registered_at,
      last_updated_at: new Date().toISOString(),
    });

    this.db
      .prepare(
        `UPDATE model_entries
         SET display_name=?, vendor=?, version=?, status=?, deployment_type=?, last_updated_at=?, entry_json=?
         WHERE id=?`,
      )
      .run(
        merged.display_name,
        merged.vendor,
        merged.version,
        merged.status,
        merged.deployment_type,
        merged.last_updated_at,
        JSON.stringify(merged),
        id,
      );

    return merged;
  }

  /** 内部：校准数据写回（calibrator 用） */
  updateCalibration(id: string, calibration: ModelEntry["calibration"]): void {
    const existing = this.get(id);
    const merged: ModelEntry = ModelEntrySchema.parse({
      ...existing,
      calibration: CalibrationStateSchema.parse(calibration),
      last_updated_at: new Date().toISOString(),
    });
    this.db
      .prepare(`UPDATE model_entries SET entry_json=?, last_updated_at=? WHERE id=?`)
      .run(JSON.stringify(merged), merged.last_updated_at, id);
  }

  get(id: string): ModelEntry {
    const entry = this.tryGet(id);
    if (!entry) throw new Error(`ModelEntry not found: ${id}`);
    return entry;
  }

  tryGet(id: string): ModelEntry | null {
    const row = this.db
      .prepare(`SELECT entry_json FROM model_entries WHERE id=?`)
      .get(id) as { entry_json: string } | undefined;
    if (!row) return null;
    return ModelEntrySchema.parse(JSON.parse(row.entry_json));
  }

  list(filter?: ModelFilter): ModelSummary[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      wheres.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.deployment_type) {
      wheres.push("deployment_type = ?");
      params.push(filter.deployment_type);
    }
    if (filter?.vendor) {
      wheres.push("vendor = ?");
      params.push(filter.vendor);
    }
    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT id, display_name, vendor, deployment_type, status FROM model_entries ${where} ORDER BY id`)
      .all(...params) as Array<{
      id: string;
      display_name: string;
      vendor: string;
      deployment_type: "hosted" | "local";
      status: "active" | "deprecated" | "experimental";
    }>;
    return rows;
  }

  /** 路由器调度时获取所有 active 的完整画像 */
  listActiveFull(): ModelEntry[] {
    const rows = this.db
      .prepare(`SELECT entry_json FROM model_entries WHERE status='active'`)
      .all() as Array<{ entry_json: string }>;
    return rows.map((r) => ModelEntrySchema.parse(JSON.parse(r.entry_json)));
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM model_entries WHERE id=?`).run(id);
  }

  // ----------------------------------------------------------------
  // helpers
  // ----------------------------------------------------------------

  private buildInitialCalibration(
    scores: ModelEntry["capability_scores"],
    now: string,
  ): ModelEntry["calibration"] {
    const out: ModelEntry["calibration"] = {};
    for (const [dim, score] of Object.entries(scores)) {
      out[dim as keyof typeof scores] = {
        initial_score: score,
        empirical_score: score,
        current_score: score,
        success_count: 0,
        total_count: 0,
        last_updated: now,
      };
    }
    return out;
  }
}
