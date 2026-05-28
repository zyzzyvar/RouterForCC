/**
 * 阶段②：硬筛。
 *
 * 把不能用的模型剔除，让评分阶段只关心"能用的之间谁更好"。
 *
 * 硬筛维度：
 *   1. 状态：必须 active
 *   2. 模态：input/output 模态匹配（任务声明的 modality 必须 ⊂ 模型支持）
 *   3. tool_use：要求工具调用时，模型必须 supports_tool_use
 *   4. 上下文窗口：estimated_input + estimated_output 必须 ≤ context_effective
 *   5. 输出上限：estimated_output_tokens ≤ max_output_tokens
 *   6. 合规：sensitivity_level=high → 必须 can_process_confidential
 *           包含 PII 暗示（待 analyzer 增强）暂以 sensitivity≥medium 作弱代理
 *   7. avoid_patterns：用 condition_expr 在任务上下文求值，命中则剔除
 *   8. excluded_models（hints）
 *   9. 显式 preferred_models 时不做"白名单收窄"——它只是软偏好，
 *      让 hard filter 保持纯客观；评分阶段再加偏置。
 *
 * 返回：保留下来的 ModelEntry[] + 每个被剔除模型的原因。
 */
import type {
  ModelEntry,
  TaskSpec,
  TaskAnalyzed,
  Modality,
} from "./types.js";
import { evaluate } from "./exprEval.js";

export interface HardFilterReason {
  model_id: string;
  reason: string;
}

export interface HardFilterResult {
  kept: ModelEntry[];
  rejected: HardFilterReason[];
}

export function hardFilter(
  models: readonly ModelEntry[],
  task: TaskSpec,
): HardFilterResult {
  const analyzed = task.analyzed;
  if (!analyzed) {
    throw new Error("hardFilter requires task.analyzed (run analyzer first)");
  }

  const kept: ModelEntry[] = [];
  const rejected: HardFilterReason[] = [];
  const excluded = new Set(task.hints.excluded_models);

  for (const m of models) {
    const reason = checkOne(m, task, analyzed, excluded);
    if (reason) rejected.push({ model_id: m.id, reason });
    else kept.push(m);
  }

  return { kept, rejected };
}

function checkOne(
  m: ModelEntry,
  task: TaskSpec,
  a: TaskAnalyzed,
  excluded: Set<string>,
): string | null {
  // 1. 状态
  if (m.status !== "active") return `status=${m.status}`;

  // 2. 显式 excluded
  if (excluded.has(m.id)) return "excluded_by_hint";

  // 3. 模态
  const inSupported = new Set<Modality>(m.input_modalities);
  for (const need of a.requires_modality) {
    if (!inSupported.has(need)) return `missing input_modality: ${need}`;
  }

  // 4. 工具调用
  if (a.requires_tool_use && !m.supports_tool_use) {
    return "tool_use required but not supported";
  }

  // 5. 上下文窗口
  const totalTokens = a.estimated_input_tokens + a.estimated_output_tokens;
  if (totalTokens > m.context_effective) {
    return `context overflow: need ${totalTokens}, effective ${m.context_effective}`;
  }

  // 6. 输出上限
  if (a.estimated_output_tokens > m.max_output_tokens) {
    return `output exceeds max_output_tokens (${m.max_output_tokens})`;
  }

  // 7. 合规
  if (a.sensitivity_level === "high" && !m.compliance.can_process_confidential) {
    return "sensitivity=high not allowed by compliance";
  }
  // 中等敏感的可处理 PII 检查
  if (a.sensitivity_level === "medium" && !m.compliance.can_process_pii) {
    return "sensitivity=medium requires can_process_pii";
  }

  // 8. avoid_patterns（在评估上下文中查得到）
  const exprCtx = buildExprContext(task, a, m);
  for (const p of m.soft_labels.avoid_patterns) {
    if (evaluate(p.condition_expr, exprCtx)) {
      return `avoid_pattern: ${p.description}`;
    }
  }

  // 9. 输出格式 strict_json
  if (task.constraints.output_format === "json" && !m.supports_strict_json) {
    return "output_format=json but supports_strict_json=false";
  }

  return null;
}

/**
 * 把任务关键字段铺平给 exprEval，让 condition_expr 能直接引用。
 * 设计原则：尽量铺平（避免点路径过长），同时保留嵌套以便扩展。
 */
function buildExprContext(
  task: TaskSpec,
  a: TaskAnalyzed,
  m: ModelEntry,
): Record<string, unknown> {
  return {
    task_type: a.task_type,
    primary_language: a.primary_language,
    sensitivity_level: a.sensitivity_level,
    risk_level: a.risk_level,
    estimated_input_tokens: a.estimated_input_tokens,
    estimated_output_tokens: a.estimated_output_tokens,
    difficulty_hint: a.difficulty_hint,
    requires_tool_use: a.requires_tool_use,
    output_format: task.constraints.output_format ?? "text",
    language: task.constraints.language ?? a.primary_language,
    deployment_type: m.deployment_type,
    analyzed: a,
    constraints: task.constraints,
    hints: task.hints,
  };
}
