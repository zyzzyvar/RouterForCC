/**
 * ExecutionRecord CRUD（只增不改：执行记录不可变）。
 * 反馈 / 校准应用通过单独的字段更新（见 update*）。
 */
import type { Database } from "better-sqlite3";
import { ExecutionRecordSchema, type ExecutionRecord, type UserFeedback } from "../core/types.js";

export interface ExecutionFilter {
  task_id?: string;
  chosen_model_id?: string;
  validation_passed?: boolean;
  limit?: number;
}

export class ExecutionStore {
  constructor(private db: Database) {}

  insert(record: ExecutionRecord): ExecutionRecord {
    const parsed = ExecutionRecordSchema.parse(record);
    this.db
      .prepare(
        `INSERT INTO execution_records (record_id, task_id, chosen_model_id, validation_passed,
                                        cost_usd, started_at, completed_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.record_id,
        parsed.task_id,
        parsed.decision.chosen_model_id,
        parsed.validation.passed ? 1 : 0,
        parsed.execution.actual_cost.usd,
        parsed.execution.started_at,
        parsed.execution.completed_at,
        JSON.stringify(parsed),
      );
    return parsed;
  }

  get(record_id: string): ExecutionRecord {
    const r = this.tryGet(record_id);
    if (!r) throw new Error(`ExecutionRecord not found: ${record_id}`);
    return r;
  }

  tryGet(record_id: string): ExecutionRecord | null {
    const row = this.db
      .prepare(`SELECT record_json FROM execution_records WHERE record_id=?`)
      .get(record_id) as { record_json: string } | undefined;
    if (!row) return null;
    return ExecutionRecordSchema.parse(JSON.parse(row.record_json));
  }

  list(filter?: ExecutionFilter): ExecutionRecord[] {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (filter?.task_id) {
      wheres.push("task_id=?");
      params.push(filter.task_id);
    }
    if (filter?.chosen_model_id) {
      wheres.push("chosen_model_id=?");
      params.push(filter.chosen_model_id);
    }
    if (filter?.validation_passed !== undefined) {
      wheres.push("validation_passed=?");
      params.push(filter.validation_passed ? 1 : 0);
    }
    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = filter?.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT record_json FROM execution_records ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, limit) as Array<{ record_json: string }>;
    return rows.map((r) => ExecutionRecordSchema.parse(JSON.parse(r.record_json)));
  }

  updateFeedback(record_id: string, feedback: UserFeedback): ExecutionRecord {
    const existing = this.get(record_id);
    const updated: ExecutionRecord = ExecutionRecordSchema.parse({
      ...existing,
      user_feedback: {
        ...feedback,
        timestamp: new Date().toISOString(),
      },
    });
    this.db.prepare(`UPDATE execution_records SET record_json=? WHERE record_id=?`).run(
      JSON.stringify(updated),
      record_id,
    );
    return updated;
  }
}

// ============================================================================
// 挂起态存储
// ============================================================================

import type { Proposal, ApprovalReason } from "../core/types.js";
import { ProposalSchema, ApprovalReasonSchema } from "../core/schemas.js";
import { z } from "zod";

export interface PendingApproval {
  token: string;
  task_id: string;
  proposal: Proposal;
  reasons: ApprovalReason[];
  created_at: string;
  expires_at: string;
  consumed: boolean;
}

export class PendingApprovalStore {
  constructor(private db: Database) {}

  create(args: {
    token: string;
    task_id: string;
    proposal: Proposal;
    reasons: ApprovalReason[];
    ttl_hours: number;
  }): PendingApproval {
    const now = new Date();
    const expires = new Date(now.getTime() + args.ttl_hours * 3600 * 1000);
    const created_at = now.toISOString();
    const expires_at = expires.toISOString();

    this.db
      .prepare(
        `INSERT INTO pending_approvals (token, task_id, proposal_json, approval_reasons_json, created_at, expires_at, consumed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(args.token, args.task_id, JSON.stringify(args.proposal), JSON.stringify(args.reasons), created_at, expires_at);

    return {
      token: args.token,
      task_id: args.task_id,
      proposal: args.proposal,
      reasons: args.reasons,
      created_at,
      expires_at,
      consumed: false,
    };
  }

  get(token: string): PendingApproval | null {
    const row = this.db
      .prepare(
        `SELECT token, task_id, proposal_json, approval_reasons_json, created_at, expires_at, consumed
         FROM pending_approvals WHERE token=?`,
      )
      .get(token) as
      | {
          token: string;
          task_id: string;
          proposal_json: string;
          approval_reasons_json: string;
          created_at: string;
          expires_at: string;
          consumed: number;
        }
      | undefined;
    if (!row) return null;
    return {
      token: row.token,
      task_id: row.task_id,
      proposal: ProposalSchema.parse(JSON.parse(row.proposal_json)),
      reasons: z.array(ApprovalReasonSchema).parse(JSON.parse(row.approval_reasons_json)),
      created_at: row.created_at,
      expires_at: row.expires_at,
      consumed: row.consumed === 1,
    };
  }

  markConsumed(token: string): void {
    this.db.prepare(`UPDATE pending_approvals SET consumed=1 WHERE token=?`).run(token);
  }

  /** 清理过期；返回清理条数 */
  purgeExpired(): number {
    const now = new Date().toISOString();
    const r = this.db.prepare(`DELETE FROM pending_approvals WHERE expires_at < ?`).run(now);
    return r.changes;
  }
}
