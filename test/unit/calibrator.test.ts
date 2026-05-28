import { describe, it, expect } from "vitest";
import { calibrate } from "../../src/core/calibrator.js";
import { buildSampleModels } from "../../src/util/fixtures.js";

describe("calibrate", () => {
  const model = buildSampleModels().find((m) => m.id === "qwen2.5-72b-local")!;

  it("moves empirical_score up on success", () => {
    const r = calibrate({
      model,
      record: {
        validation: { passed: true, validator_type: "rules", failure_reasons: [], confidence: 1 },
        decision: {
          chosen_model_id: model.id,
          chosen_model_snapshot: model,
          score: 4,
          weights_used: { code: 1 },
          rationale: "",
          alternates: [],
          decision_trace: [],
        },
      },
      weights_used: { code: 1 },
    });
    const codeEntry = r.next_calibration.code!;
    expect(codeEntry.success_count).toBe(1);
    expect(codeEntry.total_count).toBe(1);
    // current_score 在 initial 与 5 之间
    expect(codeEntry.current_score).toBeGreaterThanOrEqual(codeEntry.initial_score - 0.001);
    expect(codeEntry.current_score).toBeLessThanOrEqual(5);
  });

  it("moves empirical_score down on failure", () => {
    const r = calibrate({
      model,
      record: {
        validation: { passed: false, validator_type: "rules", failure_reasons: ["x"], confidence: 1 },
        decision: {
          chosen_model_id: model.id,
          chosen_model_snapshot: model,
          score: 4,
          weights_used: { code: 1 },
          rationale: "",
          alternates: [],
          decision_trace: [],
        },
      },
      weights_used: { code: 1 },
    });
    const codeEntry = r.next_calibration.code!;
    expect(codeEntry.success_count).toBe(0);
    expect(codeEntry.total_count).toBe(1);
    // 一次失败：empirical 降一点点（由 alpha 决定），current 取 0.7*emp + 0.3*initial
    expect(codeEntry.current_score).toBeLessThan(codeEntry.initial_score);
  });

  it("user_feedback.override=true forces failure regardless of validation", () => {
    const r = calibrate({
      model,
      record: {
        validation: { passed: true, validator_type: "rules", failure_reasons: [], confidence: 1 },
        user_feedback: {
          override: true,
          timestamp: "2026-05-25T00:00:00.000Z",
        },
        decision: {
          chosen_model_id: model.id,
          chosen_model_snapshot: model,
          score: 4,
          weights_used: { code: 1 },
          rationale: "",
          alternates: [],
          decision_trace: [],
        },
      },
      weights_used: { code: 1 },
    });
    expect(r.next_calibration.code!.success_count).toBe(0);
  });
});
