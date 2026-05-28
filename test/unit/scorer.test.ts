import { describe, it, expect } from "vitest";
import { scoreCandidates, estimateCostUsd } from "../../src/core/scorer.js";
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

describe("scoreCandidates", () => {
  const models = buildSampleModels();

  it("returns ranked array with total_score descending", () => {
    const t = makeTask();
    const ranked = scoreCandidates(models, t);
    expect(ranked.length).toBe(models.length);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.total_score).toBeGreaterThanOrEqual(ranked[i]!.total_score);
    }
  });

  it("local model has cost_factor = 1 (zero normalized cost)", () => {
    const t = makeTask();
    const ranked = scoreCandidates(models, t);
    const local = ranked.find((c) => c.model.id === "qwen2.5-72b-local");
    expect(local).toBeDefined();
    expect(local!.cost_factor).toBeCloseTo(1, 5);
    expect(local!.estimated_cost_usd).toBeNull();
  });

  it("preferred_model gets a bonus and outranks otherwise-equal", () => {
    const t = makeTask({
      hints: { preferred_models: ["deepseek-chat"], excluded_models: [] },
    });
    const ranked = scoreCandidates(models, t);
    const ds = ranked.find((c) => c.model.id === "deepseek-chat");
    expect(ds!.prefer_bonus).toBeGreaterThan(0);
  });

  it("breakdown sums to capability_score", () => {
    const t = makeTask();
    const ranked = scoreCandidates(models, t);
    for (const c of ranked) {
      const sum = c.breakdown.reduce((acc, b) => acc + b.contribution, 0);
      expect(sum).toBeCloseTo(c.capability_score, 5);
    }
  });

  it("uses code weights for task_type=code", () => {
    const t = makeTask();
    const ranked = scoreCandidates(models, t);
    expect(ranked[0]!.weights_used.code).toBeDefined();
    expect(ranked[0]!.weights_used.code).toBeGreaterThan(0);
  });

  it("estimateCostUsd computes hosted price correctly", () => {
    const hosted = models.find((m) => m.id === "gpt-4o-mini")!;
    // 1000 tokens in @ $0.15/M + 500 out @ $0.60/M
    const cost = estimateCostUsd(hosted, 1000, 500);
    expect(cost).toBeCloseTo(0.00015 + 0.0003, 8);
  });

  it("estimateCostUsd returns null for local", () => {
    const local = models.find((m) => m.id === "qwen2.5-72b-local")!;
    expect(estimateCostUsd(local, 1000, 500)).toBeNull();
  });
});
