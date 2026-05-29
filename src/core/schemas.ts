/**
 * 系统的事实源头：所有数据结构由 Zod 定义，TS 类型从 schema 推导。
 *
 * 设计层次：
 *   - Layer 1 硬属性：deployment_type 决定 hosted/local 分支字段
 *   - Layer 2 能力评级（10 维度，0-5 分）+ 校准状态
 *   - Layer 3 软标签：半结构化（free text + prompt_recipes + avoid_patterns）
 *
 * 见对话中的设计文档了解每一项的来历。
 */
import { z } from "zod";

// ============================================================================
// 基础枚举
// ============================================================================

export const TaskTypeSchema = z.enum([
  "code",                    // 代码生成与调试
  "long_writing",            // 长文档写作
  "structured_extraction",   // 结构化抽取与转换
  "translation",             // 翻译与跨语言改写
  "factual_qa",              // 事实类问答
  "validation",              // 复核/验收（LLM-as-judge）
  "math",                    // 数学/计量/符号计算
  "other",                   // 兜底
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const LanguageSchema = z.enum(["zh", "en", "auto", "mixed"]);
export type Language = z.infer<typeof LanguageSchema>;

export const SeverityLevelSchema = z.enum(["low", "medium", "high"]);
export type SeverityLevel = z.infer<typeof SeverityLevelSchema>;

export const ModalitySchema = z.enum(["text", "image", "audio"]);
export type Modality = z.infer<typeof ModalitySchema>;

// ============================================================================
// Layer 2：10 个能力维度
// ============================================================================

export const CapabilityDimensionSchema = z.enum([
  "instruction_following",   // 指令遵循
  "chinese_quality",         // 中文质量
  "structured_output",       // 结构化输出可靠性
  "code",                    // 代码能力
  "long_form_coherence",     // 长文连贯性
  "translation",             // 翻译质量
  "factual_accuracy",        // 事实准确性 / 抗幻觉
  "math_reasoning",          // 数学与符号推理
  "critical_judgment",       // 批判性判断
  "tool_use",                // 工具调用可靠性
]);
export type CapabilityDimension = z.infer<typeof CapabilityDimensionSchema>;

export const CAPABILITY_DIMENSIONS: readonly CapabilityDimension[] = [
  "instruction_following",
  "chinese_quality",
  "structured_output",
  "code",
  "long_form_coherence",
  "translation",
  "factual_accuracy",
  "math_reasoning",
  "critical_judgment",
  "tool_use",
] as const;

const ScoreSchema = z.number().min(0).max(5);

export const CapabilityScoresSchema = z.object({
  instruction_following: ScoreSchema,
  chinese_quality: ScoreSchema,
  structured_output: ScoreSchema,
  code: ScoreSchema,
  long_form_coherence: ScoreSchema,
  translation: ScoreSchema,
  factual_accuracy: ScoreSchema,
  math_reasoning: ScoreSchema,
  critical_judgment: ScoreSchema,
  tool_use: ScoreSchema,
});
export type CapabilityScores = z.infer<typeof CapabilityScoresSchema>;

// ============================================================================
// Layer 3：软标签
// ============================================================================

export const AvoidPatternSchema = z.object({
  description: z.string(),
  /**
   * 简单表达式，例如：
   *   task_type == 'long_writing' AND estimated_output_tokens > 6000
   *   sensitivity_level == 'high'
   * 支持运算符: == != > < >= <= ; 逻辑: AND OR ; 括号
   */
  condition_expr: z.string(),
});
export type AvoidPattern = z.infer<typeof AvoidPatternSchema>;

export const ToolUseBreakdownSchema = z.object({
  format_score: z.number().int().min(1).max(5),
  timing_score: z.number().int().min(1).max(5),
  orchestration_score: z.number().int().min(1).max(5),
});

export const SoftLabelsSchema = z.object({
  free_description: z.string().default(""),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  prompt_recipes: z.array(z.string()).default([]),
  avoid_patterns: z.array(AvoidPatternSchema).default([]),
  tool_use_breakdown: ToolUseBreakdownSchema.optional(),
});
export type SoftLabels = z.infer<typeof SoftLabelsSchema>;

// ============================================================================
// Layer 1：硬属性
// ============================================================================

export const HostedAttributesSchema = z.object({
  endpoint: z.string().min(1),
  /** 指向 secret store 的引用名，不存密钥本身 */
  auth_ref: z.string(),
  price_per_million_input_usd: z.number().nonnegative(),
  price_per_million_output_usd: z.number().nonnegative(),
  price_per_million_cache_read_usd: z.number().nonnegative().optional(),
  price_updated_at: z.string().datetime(),
  tier_concurrency_limit: z.number().int().positive(),
  avg_first_token_latency_ms: z.number().int().nonnegative(),
  data_residency: z.string(),
  used_for_training: z.boolean(),
});
export type HostedAttributes = z.infer<typeof HostedAttributesSchema>;

export const LocalAttributesSchema = z.object({
  inference_engine: z.enum(["vllm", "ollama", "tgi", "llamacpp", "transformers"]),
  endpoint: z.string().min(1),
  gpu_footprint: z.string(),
  quantization: z.enum(["fp16", "bf16", "int8", "int4", "awq", "gptq", "none"]),
  throughput_tokens_per_sec: z.number().int().positive(),
  max_concurrent_requests: z.number().int().positive(),
  /** 当本地端点要求 Bearer auth 时（如 vLLM --api-key），指向 secret 引用名 */
  auth_ref: z.string().optional(),
});
export type LocalAttributes = z.infer<typeof LocalAttributesSchema>;

export const ComplianceSchema = z.object({
  can_process_pii: z.boolean(),
  can_process_confidential: z.boolean(),
  data_egress_region: z.string().nullable(),
  notes: z.string().default(""),
});
export type Compliance = z.infer<typeof ComplianceSchema>;

// ============================================================================
// 校准状态
// ============================================================================

export const CalibrationEntrySchema = z.object({
  initial_score: ScoreSchema,
  empirical_score: ScoreSchema,
  current_score: ScoreSchema,
  success_count: z.number().int().nonnegative(),
  total_count: z.number().int().nonnegative(),
  last_updated: z.string().datetime(),
});
export type CalibrationEntry = z.infer<typeof CalibrationEntrySchema>;

export const CalibrationStateSchema = z.record(
  CapabilityDimensionSchema,
  CalibrationEntrySchema,
);
export type CalibrationState = z.infer<typeof CalibrationStateSchema>;

// ============================================================================
// ModelEntry —— 注册表中的一条记录
// ============================================================================

export const ModelEntrySchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string(),
    vendor: z.string(),
    version: z.string(),
    status: z.enum(["active", "deprecated", "experimental"]).default("active"),
    registered_at: z.string().datetime(),
    last_updated_at: z.string().datetime(),

    // Layer 1 共用
    deployment_type: z.enum(["hosted", "local"]),
    context_max: z.number().int().positive(),
    context_effective: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    input_modalities: z.array(ModalitySchema).default(["text"]),
    output_modalities: z.array(ModalitySchema).default(["text"]),
    supports_tool_use: z.boolean(),
    supports_strict_json: z.boolean(),
    supports_streaming: z.boolean(),

    // Layer 1 分支
    hosted: HostedAttributesSchema.optional(),
    local: LocalAttributesSchema.optional(),

    compliance: ComplianceSchema,
    capability_scores: CapabilityScoresSchema,
    calibration: CalibrationStateSchema.default({}),
    soft_labels: SoftLabelsSchema,
  })
  .superRefine((data, ctx) => {
    if (data.deployment_type === "hosted" && !data.hosted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hosted attributes required when deployment_type='hosted'",
        path: ["hosted"],
      });
    }
    if (data.deployment_type === "local" && !data.local) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "local attributes required when deployment_type='local'",
        path: ["local"],
      });
    }
    if (data.context_effective > data.context_max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "context_effective cannot exceed context_max",
        path: ["context_effective"],
      });
    }
  });
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

// 模型注册时的简化输入：calibration 默认为空、registered_at 自动填充
export const ModelEntryInputSchema = ModelEntrySchema._def.schema
  .omit({ registered_at: true, last_updated_at: true, calibration: true })
  .extend({
    calibration: CalibrationStateSchema.optional(),
  });
export type ModelEntryInput = z.infer<typeof ModelEntryInputSchema>;

// 列表返回时的精简形态
export const ModelSummarySchema = z.object({
  id: z.string(),
  display_name: z.string(),
  vendor: z.string(),
  deployment_type: z.enum(["hosted", "local"]),
  status: z.enum(["active", "deprecated", "experimental"]),
});
export type ModelSummary = z.infer<typeof ModelSummarySchema>;

// ============================================================================
// TaskSpec —— 调用方传入 + 阶段①分析填充
// ============================================================================

export const TaskAnalyzedSchema = z.object({
  task_type: TaskTypeSchema,
  /** 复合任务时给出，跟 task_type 互补 */
  task_type_mix: z.record(TaskTypeSchema, z.number().min(0).max(1)).optional(),
  primary_language: LanguageSchema,
  estimated_input_tokens: z.number().int().nonnegative(),
  estimated_output_tokens: z.number().int().nonnegative(),
  requires_tool_use: z.boolean().default(false),
  requires_modality: z.array(ModalitySchema).default(["text"]),
  sensitivity_level: SeverityLevelSchema,
  risk_level: SeverityLevelSchema,
  difficulty_hint: z.number().int().min(1).max(5),
  format_constraints: z.array(z.string()).default([]),
});
export type TaskAnalyzed = z.infer<typeof TaskAnalyzedSchema>;

export const TaskInputsSchema = z.object({
  text: z.string().optional(),
  /** 引用历史 ExecutionRecord 的产出，避免重复传上下文 */
  references: z.array(z.string()).default([]),
  files: z
    .array(
      z.object({
        path: z.string(),
        mime: z.string(),
      }),
    )
    .default([]),
  schema: z.unknown().optional(),
});
export type TaskInputs = z.infer<typeof TaskInputsSchema>;

export const TaskConstraintsSchema = z.object({
  output_format: z.enum(["text", "markdown", "json", "code"]).optional(),
  language: LanguageSchema.optional(),
  max_output_tokens: z.number().int().positive().optional(),
  must_include: z.array(z.string()).default([]),
  must_avoid: z.array(z.string()).default([]),
});
export type TaskConstraints = z.infer<typeof TaskConstraintsSchema>;

export const TaskHintsSchema = z.object({
  preferred_models: z.array(z.string()).default([]),
  excluded_models: z.array(z.string()).default([]),
  sensitivity_level: SeverityLevelSchema.optional(),
  risk_level: SeverityLevelSchema.optional(),
  cost_ceiling_usd: z.number().positive().optional(),
});
export type TaskHints = z.infer<typeof TaskHintsSchema>;

export const TaskStatusSchema = z.enum([
  "analyzing",
  "pending_approval",
  "executing",
  "executed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSpecSchema = z.object({
  task_id: z.string(),
  parent_task_id: z.string().nullable().default(null),
  caller_id: z.string(),
  caller_session_id: z.string().nullable().default(null),
  idempotency_key: z.string().nullable().default(null),
  raw_description: z.string(),
  inputs: TaskInputsSchema,
  constraints: TaskConstraintsSchema,
  hints: TaskHintsSchema,
  analyzed: TaskAnalyzedSchema.nullable().default(null),
  status: TaskStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

// 调用方传入 delegate_subtask 时的输入（最简形态）
export const DelegateInputSchema = z.object({
  description: z.string().min(1),
  inputs: TaskInputsSchema.partial().optional(),
  constraints: TaskConstraintsSchema.partial().optional(),
  hints: TaskHintsSchema.partial().optional(),
  caller_id: z.string().default("unknown"),
  caller_session_id: z.string().optional(),
  parent_task_id: z.string().optional(),
  idempotency_key: z.string().optional(),
});
export type DelegateInput = z.infer<typeof DelegateInputSchema>;

// ============================================================================
// Proposal —— 阶段④的决策方案
// ============================================================================

export const AlternateModelSchema = z.object({
  model_id: z.string(),
  score: z.number(),
  why_not: z.string(),
});
export type AlternateModel = z.infer<typeof AlternateModelSchema>;

export const ProposalSchema = z.object({
  chosen_model_id: z.string(),
  score: z.number(),
  weights_used: z.record(CapabilityDimensionSchema, z.number()),
  rationale: z.string(),
  prompt: z.object({
    system: z.string(),
    user: z.string(),
    recipes_applied: z.array(z.string()).default([]),
  }),
  estimated_cost: z.object({
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
    usd: z.number().nonnegative().nullable(),
  }),
  alternates: z.array(AlternateModelSchema).default([]),
  decision_trace: z.array(z.string()).default([]),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ApprovalReasonSchema = z.enum([
  "cost_over_threshold",
  "high_risk_task",
  "low_confidence_decision",
  "explicit_caller_request",
]);
export type ApprovalReason = z.infer<typeof ApprovalReasonSchema>;

export const ApprovalDecisionSchema = z.object({
  required: z.boolean(),
  reasons: z.array(ApprovalReasonSchema).default([]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// ============================================================================
// ExecutionRecord —— 执行后入库的不可变记录
// ============================================================================

export const ValidatorTypeSchema = z.enum(["rules", "schema", "llm_judge"]);
export type ValidatorType = z.infer<typeof ValidatorTypeSchema>;

export const ExecutionRecordSchema = z.object({
  record_id: z.string(),
  task_id: z.string(),
  decision: z.object({
    chosen_model_id: z.string(),
    /** 当时使用的 ModelEntry 精简快照，便于历史回溯 */
    chosen_model_snapshot: z.unknown(),
    score: z.number(),
    weights_used: z.record(CapabilityDimensionSchema, z.number()),
    rationale: z.string(),
    alternates: z.array(AlternateModelSchema),
    decision_trace: z.array(z.string()),
  }),
  prompt_used: z.object({
    system: z.string(),
    user: z.string(),
    recipes_applied: z.array(z.string()),
    references_resolved: z
      .array(
        z.object({
          ref_id: z.string(),
          resolved_to_tokens: z.number().int().nonnegative(),
        }),
      )
      .default([]),
  }),
  execution: z.object({
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    raw_output: z.string(),
    actual_cost: z.object({
      tokens_in: z.number().int().nonnegative(),
      tokens_out: z.number().int().nonnegative(),
      /** local 部署时为 null */
      usd: z.number().nonnegative().nullable(),
    }),
    actual_latency_ms: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    retry_history: z
      .array(
        z.object({
          attempt: z.number().int().positive(),
          model_id: z.string(),
          failure_reason: z.string(),
        }),
      )
      .default([]),
  }),
  validation: z.object({
    passed: z.boolean(),
    validator_type: ValidatorTypeSchema,
    failure_reasons: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(1),
  }),
  user_feedback: z
    .object({
      override: z.boolean(),
      rating: z.number().int().min(1).max(5).optional(),
      comment: z.string().optional(),
      timestamp: z.string().datetime(),
    })
    .optional(),
  calibration_applied: z.object({
    dimensions_updated: z
      .array(
        z.object({
          dim: CapabilityDimensionSchema,
          model_id: z.string(),
          score_before: z.number(),
          score_after: z.number(),
        }),
      )
      .default([]),
    timestamp: z.string().datetime(),
  }),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

// ============================================================================
// 用户反馈 / 服务统一返回
// ============================================================================

export const UserFeedbackSchema = z.object({
  override: z.boolean(),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().optional(),
});
export type UserFeedback = z.infer<typeof UserFeedbackSchema>;

export const DelegateResultSchema = z.object({
  status: z.enum(["executed", "pending_approval", "failed", "analyzing"]),
  task: TaskSpecSchema,
  proposal: ProposalSchema.optional(),
  approval_required: z.boolean(),
  approval_reasons: z.array(ApprovalReasonSchema).default([]),
  continuation_token: z.string().optional(),
  result: z.string().optional(),
  execution_record_id: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});
export type DelegateResult = z.infer<typeof DelegateResultSchema>;
