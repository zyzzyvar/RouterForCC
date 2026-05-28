/**
 * 阶段③：评分。
 *
 * 输入：硬筛后的 ModelEntry[] + 已分析的 TaskSpec
 * 输出：按总分降序排列的 ScoredCandidate[]
 *
 * 总分构成：
 *   capability_score  = Σ weight_dim * current_score_dim (优先 calibration.current_score)
 *   cost_factor       = 1 - α * (cost_norm)           （hosted 才计，local 视作 0 成本）
 *   prefer_bonus      = β if model_id ∈ preferred_models else 0
 *   score             = capability_score * cost_factor + prefer_bonus
 *
 * 数字选取（可配置；这里给默认）：
 *   α = 0.15        // 价格对总分的最大压缩比例
 *   β = 0.25        // 偏好模型加分
 *   cost_norm ∈ [0,1]：在候选池内做 min-max 归一化
 *
 * 输出还附带 breakdown（每个维度贡献了多少分），方便决策痕迹与调试。
 */
import type { ModelEntry, TaskSpec, CapabilityDimension } from "./types.js";
import { resolveWeights, type DimensionWeights } from "./weights.js";

const ALPHA_COST = 0.15;
const BETA_PREFER = 0.25;

export interface ScoreBreakdownEntry {
  dim: CapabilityDimension;
  weight: number;
  score: number;       // 实际取的分（来自 calibration.current 或 capability_scores）
  source: "calibration" | "initial";
  contribution: number; // weight * score
}

export interface ScoredCandidate {
  model: ModelEntry;
  capability_score: number;
  cost_factor: number;
  prefer_bonus: number;
  total_score: number;
  estimated_cost_usd: number | null;
  weights_used: DimensionWeights;
  breakdown: ScoreBreakdownEntry[];
  notes: string[];
}

export interface ScoreOptions {
  alpha_cost?: number;
  beta_prefer?: number;
}

export function scoreCandidates(
  models: readonly ModelEntry[],
  task: TaskSpec,
  options: ScoreOptions = {},
): ScoredCandidate[] {
  const analyzed = task.analyzed;
  if (!analyzed) throw new Error("scoreCandidates requires task.analyzed");

  const alpha = options.alpha_cost ?? ALPHA_COST;
  const beta = options.beta_prefer ?? BETA_PREFER;

  const weights = resolveWeights(analyzed.task_type, analyzed.task_type_mix);
  const preferred = new Set(task.hints.preferred_models);

  // 先算每个模型的成本，再做 min-max
  const withCost = models.map((m) => ({
    model: m,
    cost: estimateCostUsd(m, analyzed.estimated_input_tokens, analyzed.estimated_output_tokens),
  }));
  const costNormMap = normalizeCosts(withCost);

  const out: ScoredCandidate[] = withCost.map(({ model, cost }) => {
    const breakdown: ScoreBreakdownEntry[] = [];
    let capabilityScore = 0;

    for (const [dim, w] of Object.entries(weights) as Array<[CapabilityDimension, number]>) {
      if (!w) continue;
      const { score, source } = pickScore(model, dim);
      const contribution = w * score;
      capabilityScore += contribution;
      breakdown.push({ dim, weight: w, score, source, contribution });
    }

    const costNorm = costNormMap.get(model.id) ?? 0;
    const costFactor = 1 - alpha * costNorm;
    const preferBonus = preferred.has(model.id) ? beta : 0;
    const total = capabilityScore * costFactor + preferBonus;

    const notes: string[] = [];
    if (preferred.has(model.id)) notes.push("preferred_model bonus applied");
    if (cost === null) notes.push("local model: cost treated as 0");

    return {
      model,
      capability_score: capabilityScore,
      cost_factor: costFactor,
      prefer_bonus: preferBonus,
      total_score: total,
      estimated_cost_usd: cost,
      weights_used: weights,
      breakdown,
      notes,
    };
  });

  out.sort((a, b) => b.total_score - a.total_score);
  return out;
}

/**
 * 从 calibration 中拿 current_score；没有就退回 capability_scores（初始）。
 */
function pickScore(
  m: ModelEntry,
  dim: CapabilityDimension,
): { score: number; source: "calibration" | "initial" } {
  const c = m.calibration?.[dim];
  if (c) return { score: c.current_score, source: "calibration" };
  return { score: m.capability_scores[dim], source: "initial" };
}

/**
 * 估算一次调用的 USD 成本。local 模型返回 null（不参与成本归一）。
 */
export function estimateCostUsd(
  m: ModelEntry,
  tokensIn: number,
  tokensOut: number,
): number | null {
  if (m.deployment_type === "local" || !m.hosted) return null;
  const inUsd = (tokensIn / 1_000_000) * m.hosted.price_per_million_input_usd;
  const outUsd = (tokensOut / 1_000_000) * m.hosted.price_per_million_output_usd;
  return inUsd + outUsd;
}

function normalizeCosts(
  arr: ReadonlyArray<{ model: ModelEntry; cost: number | null }>,
): Map<string, number> {
  const valid = arr.filter((x) => x.cost !== null) as Array<{ model: ModelEntry; cost: number }>;
  const result = new Map<string, number>();
  if (valid.length === 0) {
    for (const { model } of arr) result.set(model.id, 0);
    return result;
  }
  const costs = valid.map((x) => x.cost);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const span = max - min;
  for (const { model, cost } of arr) {
    if (cost === null) {
      result.set(model.id, 0); // local 视作 0 成本
      continue;
    }
    result.set(model.id, span > 0 ? (cost - min) / span : 0);
  }
  return result;
}
