import { describe, it, expect } from "vitest";
import { evaluate } from "../../src/core/exprEval.js";

describe("evaluate (avoid_pattern conditions)", () => {
  it("supports string equality", () => {
    expect(evaluate("task_type == 'long_writing'", { task_type: "long_writing" })).toBe(true);
    expect(evaluate("task_type == 'long_writing'", { task_type: "code" })).toBe(false);
  });

  it("supports number comparisons", () => {
    const ctx = { estimated_output_tokens: 8000 };
    expect(evaluate("estimated_output_tokens > 6000", ctx)).toBe(true);
    expect(evaluate("estimated_output_tokens <= 6000", ctx)).toBe(false);
    expect(evaluate("estimated_output_tokens >= 8000", ctx)).toBe(true);
    expect(evaluate("estimated_output_tokens != 0", ctx)).toBe(true);
  });

  it("supports AND / OR with parens", () => {
    const ctx = { task_type: "long_writing", estimated_output_tokens: 8000 };
    expect(
      evaluate(
        "task_type == 'long_writing' AND estimated_output_tokens > 6000",
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluate("(task_type == 'code') OR (estimated_output_tokens > 6000)", ctx),
    ).toBe(true);
    expect(
      evaluate(
        "task_type == 'code' AND estimated_output_tokens > 6000",
        ctx,
      ),
    ).toBe(false);
  });

  it("returns false (not throws) on bad expressions when not strict", () => {
    expect(evaluate("task_type =", { task_type: "code" })).toBe(false);
  });

  it("treats unknown identifiers as undefined → comparisons fail", () => {
    expect(evaluate("missing_field > 0", {})).toBe(false);
    expect(evaluate("missing_field == 'x'", {})).toBe(false);
  });

  it("supports nested path lookup", () => {
    expect(evaluate("analyzed.task_type == 'code'", { analyzed: { task_type: "code" } })).toBe(true);
  });

  it("supports boolean literals", () => {
    expect(evaluate("requires_tool_use == true", { requires_tool_use: true })).toBe(true);
    expect(evaluate("requires_tool_use == false", { requires_tool_use: true })).toBe(false);
  });
});
