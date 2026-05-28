import { describe, it, expect } from "vitest";
import { hardFilter } from "../../src/core/hardFilter.js";
import { TaskSpecSchema, type TaskSpec } from "../../src/core/types.js";
import { buildSampleModels } from "../../src/util/fixtures.js";

function makeTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  const now = "2026-05-25T00:00:00.000Z";
  return TaskSpecSchema.parse({
    task_id: "t1",
    parent_task_id: null,
    caller_id: "tester",
    caller_session_id: null,
    idempotency_key: null,
    raw_description: "test",
    inputs: { text: "x", references: [], files: [] },
    constraints: { must_include: [], must_avoid: [] },
    hints: { preferred_models: [], excluded_models: [] },
    analyzed: {
      task_type: "code",
      primary_language: "zh",
      estimated_input_tokens: 1000,
      estimated_output_tokens: 500,
      requires_tool_use: false,
      requires_modality: ["text"],
      sensitivity_level: "low",
      risk_level: "low",
      difficulty_hint: 3,
      format_constraints: [],
    },
    status: "executing",
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

describe("hardFilter", () => {
  const models = buildSampleModels();

  it("keeps all when constraints are loose", () => {
    const result = hardFilter(models, makeTask());
    expect(result.kept.length).toBe(models.length);
    expect(result.rejected.length).toBe(0);
  });

  it("rejects models that lack tool_use when required", () => {
    const noTool = models.map((m) => ({ ...m, supports_tool_use: false }));
    const t = makeTask({
      analyzed: {
        task_type: "code",
        primary_language: "zh",
        estimated_input_tokens: 1000,
        estimated_output_tokens: 500,
        requires_tool_use: true,
        requires_modality: ["text"],
        sensitivity_level: "low",
        risk_level: "low",
        difficulty_hint: 3,
        format_constraints: [],
      },
    });
    const result = hardFilter(noTool, t);
    expect(result.kept.length).toBe(0);
    expect(result.rejected.every((r) => r.reason.includes("tool_use"))).toBe(true);
  });

  it("rejects models when context_effective is exceeded", () => {
    const t = makeTask({
      analyzed: {
        task_type: "code",
        primary_language: "zh",
        estimated_input_tokens: 200_000, // 远超
        estimated_output_tokens: 1000,
        requires_tool_use: false,
        requires_modality: ["text"],
        sensitivity_level: "low",
        risk_level: "low",
        difficulty_hint: 3,
        format_constraints: [],
      },
    });
    const result = hardFilter(models, t);
    expect(result.kept.length).toBe(0);
  });

  it("excludes by hints.excluded_models", () => {
    const t = makeTask({
      hints: { preferred_models: [], excluded_models: ["gpt-4o-mini"] },
    });
    const result = hardFilter(models, t);
    expect(result.kept.map((m) => m.id)).not.toContain("gpt-4o-mini");
  });

  it("applies avoid_patterns when expression matches", () => {
    const t = makeTask({
      analyzed: {
        task_type: "long_writing",
        primary_language: "zh",
        estimated_input_tokens: 2000,
        estimated_output_tokens: 8000,
        requires_tool_use: false,
        requires_modality: ["text"],
        sensitivity_level: "low",
        risk_level: "low",
        difficulty_hint: 3,
        format_constraints: [],
      },
    });
    const result = hardFilter(models, t);
    // qwen2.5-72b-local 有 avoid_pattern: long_writing AND output > 6000
    expect(result.rejected.find((r) => r.model_id === "qwen2.5-72b-local")?.reason).toMatch(/avoid_pattern/);
  });

  it("rejects hosted-without-PII when sensitivity=medium", () => {
    const t = makeTask({
      analyzed: {
        task_type: "code",
        primary_language: "zh",
        estimated_input_tokens: 100,
        estimated_output_tokens: 100,
        requires_tool_use: false,
        requires_modality: ["text"],
        sensitivity_level: "medium",
        risk_level: "low",
        difficulty_hint: 3,
        format_constraints: [],
      },
    });
    const result = hardFilter(models, t);
    // 只有 local（can_process_pii=true）保留
    expect(result.kept.map((m) => m.id)).toEqual(["qwen2.5-72b-local"]);
  });
});
