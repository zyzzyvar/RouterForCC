import { describe, it, expect } from "vitest";
import { buildTestContext, MockProviderRegistry } from "./_helpers.js";

describe("pipeline pending approval flow", () => {
  it("returns pending_approval when risk_level=high", async () => {
    const providers = new MockProviderRegistry({ text: "ok" });
    const ctx = buildTestContext({ providers });

    const result = await ctx.pipeline.runDelegate({
      description: "总结一份机密的财务报告",
      caller_id: "test-suite",
      hints: { risk_level: "high" },
    });

    expect(result.status).toBe("pending_approval");
    expect(result.approval_required).toBe(true);
    expect(result.approval_reasons).toContain("high_risk_task");
    expect(result.continuation_token).toBeDefined();
    expect(result.proposal).toBeDefined();

    // 任务状态进入 pending_approval
    const t = ctx.tasks.get(result.task.task_id);
    expect(t.status).toBe("pending_approval");
  });

  it("confirmAndExecute completes the second half", async () => {
    const providers = new MockProviderRegistry({ text: "审核后的输出" });
    const ctx = buildTestContext({ providers });

    const r1 = await ctx.pipeline.runDelegate({
      description: "高风险任务样例",
      caller_id: "test-suite",
      hints: { risk_level: "high" },
    });
    expect(r1.status).toBe("pending_approval");

    const r2 = await ctx.pipeline.confirmAndExecute(r1.continuation_token!);
    expect(r2.status).toBe("executed");
    expect(r2.result).toBe("审核后的输出");
    expect(r2.execution_record_id).toBeDefined();
  });

  it("rejects expired or consumed tokens", async () => {
    const providers = new MockProviderRegistry({ text: "x" });
    const ctx = buildTestContext({ providers });

    const r1 = await ctx.pipeline.runDelegate({
      description: "敏感任务",
      caller_id: "test-suite",
      hints: { risk_level: "high" },
    });
    await ctx.pipeline.confirmAndExecute(r1.continuation_token!);
    // 第二次使用同一个 token 应该失败
    await expect(
      ctx.pipeline.confirmAndExecute(r1.continuation_token!),
    ).rejects.toThrow(/consumed/);
  });

  it("triggers approval when estimated cost exceeds ceiling", async () => {
    // 用极低 cost_ceiling 构造触发条件
    const providers = new MockProviderRegistry({ text: "x" });
    const ctx = buildTestContext({ providers });
    // 把 ceiling 改成 1e-6（直接构造一个新的 pipeline 配置太重，我们走 hints 通道）
    const result = await ctx.pipeline.runDelegate({
      description: "写一段代码",
      caller_id: "test-suite",
      hints: { cost_ceiling_usd: 0.000001 },
    });
    // 由于 hints.cost_ceiling 严于 config，hosted 模型的估算成本都会超过它
    // 期待 approval 或 chosen 是 local 模型（cost=null 不超）
    if (result.approval_required) {
      expect(result.approval_reasons).toContain("cost_over_threshold");
    } else {
      expect(result.proposal!.chosen_model_id).toBe("qwen2.5-72b-local");
    }
  });
});
