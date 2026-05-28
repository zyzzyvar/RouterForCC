/**
 * 任务类型 → 能力维度权重表。
 *
 * 这是路由器评分阶段的核心数据。修改这张表 = 调整路由偏好。
 *
 * 每一行权重之和应为 1.0（允许微小浮点误差）。
 * 当任务是复合类型时（task_type_mix），用 mixedWeights() 加权混合。
 *
 * 设计依据：见对话中"路由器决策算法"那一节。
 */
import type { TaskType, CapabilityDimension } from "./types.js";

export type DimensionWeights = Partial<Record<CapabilityDimension, number>>;

export const DEFAULT_WEIGHTS: Record<TaskType, DimensionWeights> = {
  // —— 代码生成与调试 ——
  code: {
    code: 0.45,
    instruction_following: 0.2,
    structured_output: 0.15,
    long_form_coherence: 0.1,
    factual_accuracy: 0.1,
  },

  // —— 长文档写作 ——
  long_writing: {
    long_form_coherence: 0.35,
    chinese_quality: 0.25,
    instruction_following: 0.2,
    factual_accuracy: 0.15,
    structured_output: 0.05,
  },

  // —— 结构化抽取与转换 ——
  structured_extraction: {
    structured_output: 0.45,
    instruction_following: 0.3,
    factual_accuracy: 0.15,
    chinese_quality: 0.1,
  },

  // —— 翻译与跨语言改写 ——
  translation: {
    translation: 0.4,
    chinese_quality: 0.25,
    instruction_following: 0.2,
    factual_accuracy: 0.15,
  },

  // —— 事实类问答 ——
  factual_qa: {
    factual_accuracy: 0.4,
    instruction_following: 0.2,
    critical_judgment: 0.15,
    chinese_quality: 0.15,
    long_form_coherence: 0.1,
  },

  // —— 复核/验收（LLM-as-judge） ——
  validation: {
    critical_judgment: 0.4,
    factual_accuracy: 0.25,
    instruction_following: 0.2,
    structured_output: 0.15,
  },

  // —— 数学/计量 ——
  math: {
    math_reasoning: 0.5,
    instruction_following: 0.2,
    structured_output: 0.15,
    factual_accuracy: 0.15,
  },

  // —— 兜底 ——
  other: {
    instruction_following: 0.4,
    factual_accuracy: 0.2,
    chinese_quality: 0.2,
    long_form_coherence: 0.2,
  },
};

/**
 * 当任务是复合类型时，按 task_type_mix 的比例线性组合各维度权重。
 *
 * 例：mix = { code: 0.6, structured_extraction: 0.4 }
 *      → 60% 取代码权重 + 40% 取抽取权重
 */
export function mixedWeights(
  mix: Partial<Record<TaskType, number>>,
): DimensionWeights {
  const result: DimensionWeights = {};
  for (const [type, share] of Object.entries(mix) as Array<[TaskType, number]>) {
    if (!share || share <= 0) continue;
    const base = DEFAULT_WEIGHTS[type];
    if (!base) continue;
    for (const [dim, w] of Object.entries(base) as Array<[CapabilityDimension, number]>) {
      result[dim] = (result[dim] ?? 0) + w * share;
    }
  }
  return result;
}

/**
 * 工具方法：把任意 DimensionWeights 归一化到 sum=1。
 * 在 mixedWeights 输入和不为 1 时使用。
 */
export function normalizeWeights(w: DimensionWeights): DimensionWeights {
  const sum = Object.values(w).reduce((acc, v) => acc + (v ?? 0), 0);
  if (sum === 0) return w;
  const out: DimensionWeights = {};
  for (const [k, v] of Object.entries(w) as Array<[CapabilityDimension, number]>) {
    out[k] = v / sum;
  }
  return out;
}

/**
 * 解析任务的权重（处理普通 vs. 混合两种情况）。
 */
export function resolveWeights(
  task_type: TaskType,
  task_type_mix?: Partial<Record<TaskType, number>>,
): DimensionWeights {
  if (task_type_mix && Object.keys(task_type_mix).length > 0) {
    return normalizeWeights(mixedWeights(task_type_mix));
  }
  return DEFAULT_WEIGHTS[task_type] ?? DEFAULT_WEIGHTS.other;
}
