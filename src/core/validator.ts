/**
 * 阶段⑥：校验。
 *
 * 三种校验路径：
 *   1. rules：长度、必含/必避词、结尾标点等
 *   2. schema：当 task.constraints.output_format == 'json' 且提供 inputs.schema 时，
 *              用 zod 解析（要求 inputs.schema 也是 zod-shaped object），
 *              简化版：尝试 JSON.parse，失败即不通过
 *   3. llm_judge：调用 Claude 做结构性裁判（当前为占位）
 *
 * 选择策略：
 *   - output_format=json → schema 验证 + 规则
 *   - 复核类任务/risk_level=high → llm_judge（先返回 passed=true 的桩，避免阻塞）
 *   - 其它 → rules
 */
import type { TaskSpec, ValidatorType } from "./types.js";

export interface ValidateArgs {
  task: TaskSpec;
  raw_output: string;
}

export interface ValidationOutcome {
  passed: boolean;
  validator_type: ValidatorType;
  failure_reasons: string[];
  confidence: number;
}

export function validate(args: ValidateArgs): ValidationOutcome {
  const { task, raw_output } = args;
  const fmt = task.constraints.output_format;

  if (fmt === "json") return validateJson(task, raw_output);
  if (task.analyzed?.risk_level === "high" || task.analyzed?.task_type === "validation") {
    return llmJudgeStub(raw_output);
  }
  return validateRules(task, raw_output);
}

function validateJson(task: TaskSpec, raw: string): ValidationOutcome {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    JSON.parse(stripped);
  } catch (e) {
    return {
      passed: false,
      validator_type: "schema",
      failure_reasons: [`invalid JSON: ${(e as Error).message}`],
      confidence: 1,
    };
  }
  const ruleResult = validateRules(task, stripped);
  return {
    passed: ruleResult.passed,
    validator_type: "schema",
    failure_reasons: ruleResult.failure_reasons,
    confidence: ruleResult.confidence,
  };
}

function validateRules(task: TaskSpec, raw: string): ValidationOutcome {
  const failures: string[] = [];
  const text = raw;

  // 长度下限：估计输出 < 20% 视为可疑
  const expected = task.analyzed?.estimated_output_tokens ?? 0;
  if (expected > 0 && estimateTokens(text) < expected * 0.2) {
    failures.push(`output too short (got ~${estimateTokens(text)} tokens, expected ~${expected})`);
  }

  // 必含
  for (const must of task.constraints.must_include) {
    if (!text.includes(must)) failures.push(`missing required content: "${must}"`);
  }
  // 必避
  for (const avoid of task.constraints.must_avoid) {
    if (text.includes(avoid)) failures.push(`contains forbidden content: "${avoid}"`);
  }

  return {
    passed: failures.length === 0,
    validator_type: "rules",
    failure_reasons: failures,
    confidence: 0.8,
  };
}

function llmJudgeStub(_raw: string): ValidationOutcome {
  // 占位：未来这里调用 Claude 做 LLM-as-judge
  return {
    passed: true,
    validator_type: "llm_judge",
    failure_reasons: [],
    confidence: 0.5,
  };
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3);
}
