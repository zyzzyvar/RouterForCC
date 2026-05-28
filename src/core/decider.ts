/**
 * 阶段④：决策。
 *
 * 组合 hardFilter + scorer 的产出，落到一个 Proposal：
 *   - chosen_model_id：评分第一名
 *   - alternates：第 2-4 名 + 简短 why_not
 *   - rationale：人话解释为什么选了它
 *   - prompt：基于 Layer 3 prompt_recipes 拼出的 system/user
 *   - estimated_cost：来自 scorer
 *   - decision_trace：每一步的决定串成可读 trace
 *
 * 同时输出 ApprovalDecision —— 是否需要人工确认：
 *   - cost_over_threshold：估算成本 > config.cost_ceiling_usd（或 hints.cost_ceiling_usd 更严）
 *   - high_risk_task：analyzed.risk_level == 'high'
 *   - low_confidence_decision：top1 与 top2 总分差 < confidence_gap
 *   - explicit_caller_request：调用方在 hints 里要求 require_approval（未来扩展）
 */
import type {
  ModelEntry,
  Proposal,
  TaskSpec,
  ApprovalDecision,
  AlternateModel,
} from "./types.js";
import type { ScoredCandidate } from "./scorer.js";
import { hardFilter, type HardFilterReason } from "./hardFilter.js";
import { scoreCandidates } from "./scorer.js";

export interface DecideArgs {
  task: TaskSpec;
  models: readonly ModelEntry[];
  /** 全局成本阈值；hints.cost_ceiling_usd 若更严，会覆盖 */
  cost_ceiling_usd?: number;
  /** top1 - top2 < 此值 视作低置信 */
  confidence_gap?: number;
}

export interface DecideResult {
  proposal: Proposal;
  approval: ApprovalDecision;
  rejected: HardFilterReason[];
  ranked: ScoredCandidate[];
}

const DEFAULT_COST_CEILING = 0.1;
const DEFAULT_CONFIDENCE_GAP = 0.3;

export function decide(args: DecideArgs): DecideResult {
  const { task, models } = args;
  const analyzed = task.analyzed;
  if (!analyzed) throw new Error("decide requires task.analyzed");

  const trace: string[] = [];
  trace.push(`candidates_in=${models.length}`);

  // 1. 硬筛
  const filtered = hardFilter(models, task);
  trace.push(`hard_filter: kept=${filtered.kept.length}, rejected=${filtered.rejected.length}`);
  if (filtered.kept.length === 0) {
    throw new Error(
      `No model survives hard filter. Rejections: ${filtered.rejected
        .map((r) => `${r.model_id}(${r.reason})`)
        .join("; ")}`,
    );
  }

  // 2. 评分
  const ranked = scoreCandidates(filtered.kept, task);
  trace.push(`scored: top=${ranked[0]?.model.id}@${ranked[0]?.total_score.toFixed(3)}`);

  const top = ranked[0]!;
  const alternates: AlternateModel[] = ranked.slice(1, 4).map((c) => ({
    model_id: c.model.id,
    score: round3(c.total_score),
    why_not: buildWhyNot(top, c),
  }));

  // 3. prompt 拼装（包含 prompt_recipes）
  const prompt = composePrompt(task, top.model);

  // 4. 估算成本
  const estimated_cost = {
    tokens_in: analyzed.estimated_input_tokens,
    tokens_out: analyzed.estimated_output_tokens,
    usd: top.estimated_cost_usd,
  };

  const rationale = buildRationale(top, analyzed.task_type, ranked.length);
  trace.push(`rationale_drafted`);

  const proposal: Proposal = {
    chosen_model_id: top.model.id,
    score: round3(top.total_score),
    weights_used: top.weights_used as Record<string, number>,
    rationale,
    prompt,
    estimated_cost,
    alternates,
    decision_trace: trace,
  };

  // 5. 审批判断
  const approval = decideApproval(top, ranked, task, args);
  trace.push(`approval_required=${approval.required}${approval.reasons.length ? ":" + approval.reasons.join(",") : ""}`);

  return { proposal, approval, rejected: filtered.rejected, ranked };
}

// ----------------------------------------------------------------
// 辅助
// ----------------------------------------------------------------

function decideApproval(
  top: ScoredCandidate,
  ranked: readonly ScoredCandidate[],
  task: TaskSpec,
  args: DecideArgs,
): ApprovalDecision {
  const reasons: ApprovalDecision["reasons"] = [];
  const ceiling = Math.min(
    task.hints.cost_ceiling_usd ?? Number.POSITIVE_INFINITY,
    args.cost_ceiling_usd ?? DEFAULT_COST_CEILING,
  );
  if (top.estimated_cost_usd !== null && top.estimated_cost_usd > ceiling) {
    reasons.push("cost_over_threshold");
  }
  if (task.analyzed?.risk_level === "high") {
    reasons.push("high_risk_task");
  }
  const gap = args.confidence_gap ?? DEFAULT_CONFIDENCE_GAP;
  if (ranked.length >= 2 && top.total_score - ranked[1]!.total_score < gap) {
    reasons.push("low_confidence_decision");
  }
  return { required: reasons.length > 0, reasons };
}

function buildWhyNot(top: ScoredCandidate, c: ScoredCandidate): string {
  const dim = biggestGap(top, c);
  const costGap = (c.estimated_cost_usd ?? 0) - (top.estimated_cost_usd ?? 0);
  const parts: string[] = [];
  if (dim) parts.push(`${dim} 弱于 ${top.model.id}`);
  if (costGap > 0.005) parts.push(`成本高 ${formatUsd(costGap)}`);
  if (parts.length === 0) parts.push(`总分低 ${(top.total_score - c.total_score).toFixed(3)}`);
  return parts.join("；");
}

function biggestGap(top: ScoredCandidate, c: ScoredCandidate): string | null {
  let bestDim: string | null = null;
  let bestDelta = 0;
  const cMap = new Map(c.breakdown.map((b) => [b.dim, b.contribution]));
  for (const t of top.breakdown) {
    const delta = t.contribution - (cMap.get(t.dim) ?? 0);
    if (delta > bestDelta) {
      bestDelta = delta;
      bestDim = t.dim;
    }
  }
  return bestDim;
}

function buildRationale(top: ScoredCandidate, taskType: string, total: number): string {
  const topDims = [...top.breakdown]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((b) => `${b.dim}=${b.score.toFixed(1)}(权重${(b.weight * 100).toFixed(0)}%)`);
  const cost = top.estimated_cost_usd === null ? "本地零成本" : `约 ${formatUsd(top.estimated_cost_usd)}`;
  return `任务类型 ${taskType}；${total} 个候选中选择 ${top.model.id} —— 关键维度：${topDims.join("、")}；成本 ${cost}。`;
}

function composePrompt(
  task: TaskSpec,
  model: ModelEntry,
): Proposal["prompt"] {
  const recipes = model.soft_labels.prompt_recipes;
  const systemParts: string[] = [];
  if (task.constraints.language) {
    systemParts.push(
      task.constraints.language === "zh"
        ? "请使用中文回答。"
        : task.constraints.language === "en"
          ? "Please answer in English."
          : "",
    );
  }
  for (const r of recipes) systemParts.push(r);
  if (task.constraints.output_format === "json") {
    systemParts.push("严格输出符合上下文要求的 JSON，不要使用 markdown 代码块。");
  }
  const system = systemParts.filter(Boolean).join("\n\n");

  const userParts: string[] = [task.raw_description];
  if (task.inputs.text) userParts.push(`\n# 输入材料\n${task.inputs.text}`);
  if (task.constraints.must_include.length > 0) {
    userParts.push(`\n# 必须包含\n- ${task.constraints.must_include.join("\n- ")}`);
  }
  if (task.constraints.must_avoid.length > 0) {
    userParts.push(`\n# 必须避免\n- ${task.constraints.must_avoid.join("\n- ")}`);
  }

  return {
    system,
    user: userParts.join("\n"),
    recipes_applied: recipes,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
