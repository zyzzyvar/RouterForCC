/**
 * Pipeline 总装：把 analyze → hardFilter → score → decide →
 *               (approval?) → execute → validate → calibrate 串成一个流。
 *
 * 三种入口：
 *   - runDelegate(input)：从 DelegateInput 开始，幂等检查 → 跑完整流程
 *   - confirmAndExecute(token)：从 pending_approval 恢复，执行后半段
 *   - submitFeedback(record_id, feedback)：写入用户反馈，重新跑校准
 *
 * 这里的 router 不调度模型的 outputs，只交付：
 *   - DelegateResult：包含 status / proposal / approval / 最终结果（如执行了）
 */
import { ulid } from "ulid";
import type {
  DelegateInput,
  DelegateResult,
  ModelEntry,
  TaskSpec,
  Proposal,
  ApprovalDecision,
  UserFeedback,
  ExecutionRecord,
} from "./types.js";
import {
  TaskSpecSchema,
  ExecutionRecordSchema,
} from "./schemas.js";
import { resolveWeights } from "./weights.js";
import { analyze } from "./analyzer.js";
import { decide } from "./decider.js";
import { execute } from "./executor.js";
import { validate } from "./validator.js";
import { calibrate } from "./calibrator.js";

import type { ModelRegistry } from "../registry/store.js";
import type { TaskStore } from "../persistence/tasks.js";
import type {
  ExecutionStore,
  PendingApprovalStore,
} from "../persistence/executions.js";
import type { ProviderRegistry } from "../providers/types.js";
import type { ClaudeClient } from "../claude/client.js";
import type { Logger } from "../logging/logger.js";

export interface PipelineDeps {
  registry: ModelRegistry;
  tasks: TaskStore;
  executions: ExecutionStore;
  pending: PendingApprovalStore;
  providers: ProviderRegistry;
  claude?: ClaudeClient;
  logger: Logger;
  config: {
    cost_ceiling_usd: number;
    confidence_gap: number;
    approval_ttl_hours: number;
    decay_half_life: number;
  };
}

export class Pipeline {
  constructor(private deps: PipelineDeps) {}

  /**
   * 完整入口：分析 → 决策 →（必要时挂起 approval）→ 执行 → 校验 → 校准。
   */
  async runDelegate(
    input: DelegateInput,
    overrides?: { analyzerLlm?: ClaudeClient },
  ): Promise<DelegateResult> {
    const log = this.deps.logger.child({ caller_id: input.caller_id });

    // 幂等
    if (input.idempotency_key) {
      const existing = this.deps.tasks.findByIdempotency(input.caller_id, input.idempotency_key);
      if (existing) {
        log.info({ task_id: existing.task_id }, "idempotency hit; returning existing task");
        return this.assembleResultFromTask(existing);
      }
    }

    const task = await this.analyzeAndPersist(input, overrides?.analyzerLlm);
    log.info({ task_id: task.task_id, type: task.analyzed?.task_type }, "task analyzed");

    // 候选模型池
    const candidates = this.deps.registry.listActiveFull();
    if (candidates.length === 0) {
      return this.failTask(task, "no_active_models", "ModelRegistry contains no active entries");
    }

    let proposal: Proposal;
    let approval: ApprovalDecision;
    try {
      const decision = decide({
        task,
        models: candidates,
        cost_ceiling_usd: this.deps.config.cost_ceiling_usd,
        confidence_gap: this.deps.config.confidence_gap,
      });
      proposal = decision.proposal;
      approval = decision.approval;
    } catch (e) {
      return this.failTask(task, "no_viable_model", (e as Error).message);
    }

    if (approval.required) {
      const token = ulid();
      this.deps.pending.create({
        token,
        task_id: task.task_id,
        proposal,
        reasons: approval.reasons,
        ttl_hours: this.deps.config.approval_ttl_hours,
      });
      const updated = this.deps.tasks.setStatus(task.task_id, "pending_approval");
      log.info({ task_id: task.task_id, token, reasons: approval.reasons }, "awaiting approval");
      return {
        status: "pending_approval",
        task: updated,
        proposal,
        approval_required: true,
        approval_reasons: approval.reasons,
        continuation_token: token,
      };
    }

    return this.doExecute(task, proposal);
  }

  /**
   * 调用方批准后调用：通过 continuation_token 取出 proposal 并执行。
   */
  async confirmAndExecute(token: string, override?: { proposal?: Proposal }): Promise<DelegateResult> {
    const pending = this.deps.pending.get(token);
    if (!pending) throw new Error(`Unknown continuation_token: ${token}`);
    if (pending.consumed) throw new Error("continuation_token already consumed");
    if (new Date(pending.expires_at) < new Date()) throw new Error("continuation_token expired");

    const task = this.deps.tasks.get(pending.task_id);
    const proposal = override?.proposal ?? pending.proposal;
    this.deps.pending.markConsumed(token);

    return this.doExecute(task, proposal);
  }

  /**
   * 写入用户反馈，重新跑校准。
   */
  submitFeedback(record_id: string, feedback: UserFeedback): ExecutionRecord {
    const updated = this.deps.executions.updateFeedback(record_id, feedback);
    const model = this.deps.registry.tryGet(updated.decision.chosen_model_id);
    if (!model) return updated;

    const { next_calibration } = calibrate({
      model,
      record: updated,
      weights_used: updated.decision.weights_used,
      config: { decay_half_life: this.deps.config.decay_half_life },
    });
    this.deps.registry.updateCalibration(model.id, next_calibration);
    return updated;
  }

  // ----------------------------------------------------------------
  // 内部
  // ----------------------------------------------------------------

  private async analyzeAndPersist(
    input: DelegateInput,
    analyzerLlmOverride?: ClaudeClient,
  ): Promise<TaskSpec> {
    const now = new Date().toISOString();
    const draft: TaskSpec = TaskSpecSchema.parse({
      task_id: ulid(),
      parent_task_id: input.parent_task_id ?? null,
      caller_id: input.caller_id,
      caller_session_id: input.caller_session_id ?? null,
      idempotency_key: input.idempotency_key ?? null,
      raw_description: input.description,
      inputs: {
        text: input.inputs?.text,
        references: input.inputs?.references ?? [],
        files: input.inputs?.files ?? [],
        schema: input.inputs?.schema,
      },
      constraints: {
        output_format: input.constraints?.output_format,
        language: input.constraints?.language,
        max_output_tokens: input.constraints?.max_output_tokens,
        must_include: input.constraints?.must_include ?? [],
        must_avoid: input.constraints?.must_avoid ?? [],
      },
      hints: {
        preferred_models: input.hints?.preferred_models ?? [],
        excluded_models: input.hints?.excluded_models ?? [],
        sensitivity_level: input.hints?.sensitivity_level,
        risk_level: input.hints?.risk_level,
        cost_ceiling_usd: input.hints?.cost_ceiling_usd,
      },
      analyzed: null,
      status: "analyzing",
      created_at: now,
      updated_at: now,
    });
    this.deps.tasks.create(draft);

    const analyzed = await analyze(
      {
        raw_description: draft.raw_description,
        inputs: draft.inputs,
        hints: draft.hints,
      },
      { claude: analyzerLlmOverride ?? this.deps.claude },
    );
    return this.deps.tasks.update({ ...draft, analyzed, status: "analyzing" });
  }

  private async doExecute(task: TaskSpec, proposal: Proposal): Promise<DelegateResult> {
    const log = this.deps.logger.child({ task_id: task.task_id });
    const model = this.deps.registry.get(proposal.chosen_model_id);
    const t = this.deps.tasks.setStatus(task.task_id, "executing");

    try {
      const outcome = await execute({ proposal, model, registry: this.deps.providers });
      const validation = validate({ task: t, raw_output: outcome.raw_output });

      const weights = proposal.weights_used as Record<string, number>;
      const { next_calibration, deltas } = calibrate({
        model,
        record: {
          validation,
          decision: {
            chosen_model_id: model.id,
            chosen_model_snapshot: model,
            score: proposal.score,
            weights_used: weights,
            rationale: proposal.rationale,
            alternates: proposal.alternates,
            decision_trace: proposal.decision_trace,
          },
        },
        weights_used: weights,
        config: { decay_half_life: this.deps.config.decay_half_life },
      });

      const record_id = ulid();
      const record: ExecutionRecord = ExecutionRecordSchema.parse({
        record_id,
        task_id: t.task_id,
        decision: {
          chosen_model_id: model.id,
          chosen_model_snapshot: model,
          score: proposal.score,
          weights_used: weights,
          rationale: proposal.rationale,
          alternates: proposal.alternates,
          decision_trace: proposal.decision_trace,
        },
        prompt_used: {
          system: proposal.prompt.system,
          user: proposal.prompt.user,
          recipes_applied: proposal.prompt.recipes_applied,
          references_resolved: [],
        },
        execution: {
          started_at: outcome.started_at,
          completed_at: outcome.completed_at,
          raw_output: outcome.raw_output,
          actual_cost: {
            tokens_in: outcome.tokens_in,
            tokens_out: outcome.tokens_out,
            usd: outcome.usd,
          },
          actual_latency_ms: outcome.latency_ms,
          retries: outcome.retries,
          retry_history: outcome.retry_history,
        },
        validation,
        calibration_applied: {
          dimensions_updated: deltas,
          timestamp: new Date().toISOString(),
        },
      });
      this.deps.executions.insert(record);
      this.deps.registry.updateCalibration(model.id, next_calibration);

      const finalTask = this.deps.tasks.setStatus(
        t.task_id,
        validation.passed ? "executed" : "failed",
      );
      log.info({ record_id, passed: validation.passed }, "execution complete");

      return {
        status: validation.passed ? "executed" : "failed",
        task: finalTask,
        proposal,
        approval_required: false,
        approval_reasons: [],
        result: outcome.raw_output,
        execution_record_id: record_id,
        ...(validation.passed
          ? {}
          : {
              error: {
                code: "validation_failed",
                message: validation.failure_reasons.join("; "),
              },
            }),
      };
    } catch (e) {
      log.error({ err: (e as Error).message }, "execution failed");
      const failed = this.deps.tasks.setStatus(task.task_id, "failed");
      return {
        status: "failed",
        task: failed,
        proposal,
        approval_required: false,
        approval_reasons: [],
        error: { code: "execute_failed", message: (e as Error).message },
      };
    }
  }

  private failTask(task: TaskSpec, code: string, message: string): DelegateResult {
    const updated = this.deps.tasks.setStatus(task.task_id, "failed");
    return {
      status: "failed",
      task: updated,
      approval_required: false,
      approval_reasons: [],
      error: { code, message },
    };
  }

  /** 幂等命中时，根据已有 task 状态合成 DelegateResult */
  private assembleResultFromTask(task: TaskSpec): DelegateResult {
    // 简化：直接以当前状态返回；executed 时缺 result（调用方可单独查 execution 记录）
    return {
      status:
        task.status === "executed" || task.status === "failed" || task.status === "pending_approval"
          ? (task.status === "pending_approval" ? "pending_approval" : task.status)
          : "analyzing",
      task,
      approval_required: task.status === "pending_approval",
      approval_reasons: [],
    };
  }
}

// 工具：仅在没有 calibration 时给路由一个合理 weights。
// 路由器评分本来就走 resolveWeights，这里只是导出方便 adapter 在 debug 时复用。
export { resolveWeights };
