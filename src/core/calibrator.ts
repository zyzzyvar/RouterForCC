/**
 * 阶段⑦：校准。
 *
 * 把执行结果反馈到 ModelEntry.calibration：
 *   - 命中的维度（weights_used 中权重 > 0 的那些）做半衰加权更新
 *   - 半衰窗口：N 次样本后旧样本权重为 0.5（默认 50）
 *   - empirical_score = exponential moving average of (success ? 5 : 0)
 *   - current_score = 0.7 * empirical + 0.3 * initial （锚住先验，避免抖动）
 *   - 用户反馈 override：若 user_feedback.override=true，则把那一次记为失败
 *
 * 这里只算"该怎么改"；写回注册表由 ModelRegistry.updateCalibration() 完成。
 */
import type {
  CalibrationEntry,
  CalibrationState,
  CapabilityDimension,
  ExecutionRecord,
  ModelEntry,
} from "./types.js";

export interface CalibratorConfig {
  decay_half_life: number; // 默认 50
  initial_anchor_weight: number; // 默认 0.3
}

const DEFAULTS: CalibratorConfig = {
  decay_half_life: 50,
  initial_anchor_weight: 0.3,
};

export interface CalibrationDelta {
  dim: CapabilityDimension;
  model_id: string;
  score_before: number;
  score_after: number;
}

export interface CalibrateArgs {
  model: ModelEntry;
  record: Pick<ExecutionRecord, "validation" | "user_feedback" | "decision">;
  weights_used: Partial<Record<CapabilityDimension, number>>;
  config?: Partial<CalibratorConfig>;
}

export interface CalibrateResult {
  next_calibration: CalibrationState;
  deltas: CalibrationDelta[];
}

export function calibrate(args: CalibrateArgs): CalibrateResult {
  const cfg = { ...DEFAULTS, ...args.config };
  const success = decideSuccess(args.record);
  const next: CalibrationState = { ...(args.model.calibration ?? {}) };
  const deltas: CalibrationDelta[] = [];
  const now = new Date().toISOString();
  // EMA 平滑常数：每次样本对均值的贡献
  const alpha = 1 - Math.pow(0.5, 1 / cfg.decay_half_life);

  for (const [dim, weight] of Object.entries(args.weights_used) as Array<[CapabilityDimension, number]>) {
    if (!weight) continue;
    const prev: CalibrationEntry = next[dim] ?? makeInitial(args.model.capability_scores[dim], now);
    const sample = success ? 5 : 0;
    const empirical_next = prev.empirical_score + alpha * (sample - prev.empirical_score);
    const current_next =
      (1 - cfg.initial_anchor_weight) * empirical_next +
      cfg.initial_anchor_weight * prev.initial_score;

    const updated: CalibrationEntry = {
      initial_score: prev.initial_score,
      empirical_score: clamp(empirical_next, 0, 5),
      current_score: clamp(current_next, 0, 5),
      success_count: prev.success_count + (success ? 1 : 0),
      total_count: prev.total_count + 1,
      last_updated: now,
    };

    next[dim] = updated;
    deltas.push({
      dim,
      model_id: args.model.id,
      score_before: prev.current_score,
      score_after: updated.current_score,
    });
  }

  return { next_calibration: next, deltas };
}

function decideSuccess(
  record: Pick<ExecutionRecord, "validation" | "user_feedback">,
): boolean {
  if (record.user_feedback?.override === true) return false;
  return record.validation.passed;
}

function makeInitial(initial: number, now: string): CalibrationEntry {
  return {
    initial_score: initial,
    empirical_score: initial,
    current_score: initial,
    success_count: 0,
    total_count: 0,
    last_updated: now,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
