/**
 * TaskSpec CRUD + 状态机操作。
 */
import type { Database } from "better-sqlite3";
import { TaskSpecSchema, type TaskSpec, type TaskStatus } from "../core/types.js";

export class TaskStore {
  constructor(private db: Database) {}

  create(spec: TaskSpec): TaskSpec {
    const parsed = TaskSpecSchema.parse(spec);
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, parent_task_id, caller_id, caller_session_id, idempotency_key,
                            status, raw_description, spec_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.task_id,
        parsed.parent_task_id,
        parsed.caller_id,
        parsed.caller_session_id,
        parsed.idempotency_key,
        parsed.status,
        parsed.raw_description,
        JSON.stringify(parsed),
        parsed.created_at,
        parsed.updated_at,
      );
    return parsed;
  }

  get(task_id: string): TaskSpec {
    const t = this.tryGet(task_id);
    if (!t) throw new Error(`Task not found: ${task_id}`);
    return t;
  }

  tryGet(task_id: string): TaskSpec | null {
    const row = this.db
      .prepare(`SELECT spec_json FROM tasks WHERE task_id=?`)
      .get(task_id) as { spec_json: string } | undefined;
    if (!row) return null;
    return TaskSpecSchema.parse(JSON.parse(row.spec_json));
  }

  findByIdempotency(caller_id: string, key: string): TaskSpec | null {
    const row = this.db
      .prepare(`SELECT spec_json FROM tasks WHERE caller_id=? AND idempotency_key=?`)
      .get(caller_id, key) as { spec_json: string } | undefined;
    if (!row) return null;
    return TaskSpecSchema.parse(JSON.parse(row.spec_json));
  }

  /** 整体替换；用于 analyzed 填好、status 转换等 */
  update(spec: TaskSpec): TaskSpec {
    const parsed = TaskSpecSchema.parse({
      ...spec,
      updated_at: new Date().toISOString(),
    });
    this.db
      .prepare(`UPDATE tasks SET status=?, spec_json=?, updated_at=? WHERE task_id=?`)
      .run(parsed.status, JSON.stringify(parsed), parsed.updated_at, parsed.task_id);
    return parsed;
  }

  setStatus(task_id: string, status: TaskStatus): TaskSpec {
    const t = this.get(task_id);
    return this.update({ ...t, status });
  }

  list(filter?: { status?: TaskStatus; caller_id?: string; limit?: number }): TaskSpec[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      wheres.push("status=?");
      params.push(filter.status);
    }
    if (filter?.caller_id) {
      wheres.push("caller_id=?");
      params.push(filter.caller_id);
    }
    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = filter?.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT spec_json FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Array<{ spec_json: string }>;
    return rows.map((r) => TaskSpecSchema.parse(JSON.parse(r.spec_json)));
  }
}
