import { describe, it, expect } from "vitest";
import { buildTestContext, MockProviderRegistry } from "./_helpers.js";

describe("pipeline feedback recalibration", () => {
  it("submitFeedback(override=true) drives calibration down", async () => {
    const providers = new MockProviderRegistry({ text: "function go(){}" });
    const ctx = buildTestContext({ providers });

    const r = await ctx.pipeline.runDelegate({
      description: "写一段代码",
      caller_id: "test-suite",
    });
    expect(r.status).toBe("executed");

    const chosenId = r.proposal!.chosen_model_id;
    const before = ctx.registry.get(chosenId);
    const codeBefore = before.calibration.code!.current_score;

    // 用户标记为不满意
    ctx.pipeline.submitFeedback(r.execution_record_id!, {
      override: true,
      rating: 1,
      comment: "代码不能跑",
    });

    const after = ctx.registry.get(chosenId);
    const codeAfter = after.calibration.code!.current_score;
    // 反馈 override=true 把成功记反，应让 current 走低
    expect(codeAfter).toBeLessThanOrEqual(codeBefore);
    expect(after.calibration.code!.success_count).toBe(0);
  });

  it("submitFeedback(override=false, rating=5) keeps calibration positive", async () => {
    const providers = new MockProviderRegistry({ text: "function ok(){}" });
    const ctx = buildTestContext({ providers });

    const r = await ctx.pipeline.runDelegate({
      description: "写一段代码",
      caller_id: "test-suite",
    });
    const chosenId = r.proposal!.chosen_model_id;
    const before = ctx.registry.get(chosenId).calibration.code!;

    ctx.pipeline.submitFeedback(r.execution_record_id!, {
      override: false,
      rating: 5,
    });

    const after = ctx.registry.get(chosenId).calibration.code!;
    // 反馈不 override：仍算成功；total_count 加 1
    expect(after.total_count).toBeGreaterThan(before.total_count);
    expect(after.success_count).toBeGreaterThanOrEqual(before.success_count);
  });
});
