import { describe, it, expect } from "vitest";
import { buildTestContext, MockProviderRegistry, findRecordByTask } from "./_helpers.js";

describe("pipeline happy path", () => {
  it("runs analyze → decide → execute → validate → calibrate end-to-end", async () => {
    const providers = new MockProviderRegistry({
      text: "function quicksort(arr) { return arr; }",
      tokens_in: 150,
      tokens_out: 80,
    });
    const ctx = buildTestContext({ providers });

    const result = await ctx.pipeline.runDelegate({
      description: "请写一个 quicksort 函数，返回排好序的数组。",
      caller_id: "test-suite",
      inputs: undefined,
      constraints: undefined,
      hints: undefined,
    });

    expect(result.status).toBe("executed");
    expect(result.approval_required).toBe(false);
    expect(result.proposal).toBeDefined();
    expect(result.execution_record_id).toBeDefined();
    expect(result.result).toContain("quicksort");

    // task 最终状态 executed
    const task = ctx.tasks.get(result.task.task_id);
    expect(task.status).toBe("executed");
    expect(task.analyzed?.task_type).toBe("code");

    // ExecutionRecord 入库
    const rec = findRecordByTask(ctx.executions, task.task_id);
    expect(rec).toBeDefined();
    expect(rec!.decision.chosen_model_id).toBe(result.proposal!.chosen_model_id);
    expect(rec!.validation.passed).toBe(true);

    // calibration 已经写回所选模型
    const chosen = ctx.registry.get(rec!.decision.chosen_model_id);
    const codeCal = chosen.calibration.code;
    expect(codeCal).toBeDefined();
    expect(codeCal!.total_count).toBeGreaterThanOrEqual(1);
  });

  it("idempotency_key returns same task on retry", async () => {
    const ctx = buildTestContext();
    const args = {
      description: "翻译: hello world 到中文",
      caller_id: "test-suite",
      idempotency_key: "trans-1",
    };
    const r1 = await ctx.pipeline.runDelegate(args);
    const r2 = await ctx.pipeline.runDelegate(args);
    expect(r2.task.task_id).toBe(r1.task.task_id);
  });

  it("rejects when no active models", async () => {
    const ctx = buildTestContext({ seed: false });
    const r = await ctx.pipeline.runDelegate({
      description: "anything",
      caller_id: "t",
    });
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("no_active_models");
  });
});
