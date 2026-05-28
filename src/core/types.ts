/**
 * 重新导出所有 schema 推导出的 TS 类型，方便上层 import。
 */
export {
  // 枚举
  TaskTypeSchema,
  type TaskType,
  LanguageSchema,
  type Language,
  SeverityLevelSchema,
  type SeverityLevel,
  ModalitySchema,
  type Modality,
  CapabilityDimensionSchema,
  type CapabilityDimension,
  CAPABILITY_DIMENSIONS,
  TaskStatusSchema,
  type TaskStatus,
  ValidatorTypeSchema,
  type ValidatorType,
  ApprovalReasonSchema,
  type ApprovalReason,

  // Layer 1
  HostedAttributesSchema,
  type HostedAttributes,
  LocalAttributesSchema,
  type LocalAttributes,
  ComplianceSchema,
  type Compliance,

  // Layer 2
  CapabilityScoresSchema,
  type CapabilityScores,
  CalibrationEntrySchema,
  type CalibrationEntry,
  CalibrationStateSchema,
  type CalibrationState,

  // Layer 3
  AvoidPatternSchema,
  type AvoidPattern,
  ToolUseBreakdownSchema,
  SoftLabelsSchema,
  type SoftLabels,

  // 主对象
  ModelEntrySchema,
  type ModelEntry,
  ModelEntryInputSchema,
  type ModelEntryInput,
  ModelSummarySchema,
  type ModelSummary,
  TaskAnalyzedSchema,
  type TaskAnalyzed,
  TaskInputsSchema,
  type TaskInputs,
  TaskConstraintsSchema,
  type TaskConstraints,
  TaskHintsSchema,
  type TaskHints,
  TaskSpecSchema,
  type TaskSpec,
  DelegateInputSchema,
  type DelegateInput,
  AlternateModelSchema,
  type AlternateModel,
  ProposalSchema,
  type Proposal,
  ApprovalDecisionSchema,
  type ApprovalDecision,
  ExecutionRecordSchema,
  type ExecutionRecord,
  UserFeedbackSchema,
  type UserFeedback,
  DelegateResultSchema,
  type DelegateResult,
} from "./schemas.js";

// Caller context（不入库，仅用于运行时上下文）
export interface CallerContext {
  caller_id: string;
  caller_session_id?: string;
}
