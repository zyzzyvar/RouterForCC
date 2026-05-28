/**
 * 阶段⑥：校验。
 *
 * 三种校验路径：
 *   1. rules：必含/必避、非空 / 极短判断
 *   2. schema：output_format == 'json' 时尝试 JSON.parse
 *   3. llm_judge：调用 Claude 做结构性裁判（当前为占位）
 *
 * 选择策略：
 *   - output_format=json → schema 验证 + 规则
 *   - 复核类任务/risk_level=high → llm_judge（占位返回 passed=true）
 *   - 其它 → rules
 *
 * 历史：原本有"实际输出 < 预期 20% 视为可疑"的硬阈值，但 heuristic analyzer
 *      估算 vs 实际差距经常很大（让模型"写一段代码"可能估 1500 但实际 80 token
 *      也是合理回答）。改为只在真正空 / 几乎为空时失败；长度异常作为软信号但
 *      不阻断 pipeline。
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

const MIN_ABS_TOKENS = 3; // 少于这么多就视为空回答（保护性下限）

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
  const actualTokens = estimateTokens(text);

  // 1. 几乎为空 = 模型拒答或调用层 bug
  if (actualTokens < MIN_ABS_TOKENS) {
    failures.push(`output is empty or near-empty (~${actualTokens} tokens)`);
  }

  // 2. 必含
  for (const must of task.constraints.must_include) {
    if (!text.includes(must)) failures.push(`missing required content: "${must}"`);
  }
  // 3. 必避
  for (const avoid of task.constraints.must_avoid) {
    if (text.includes(avoid)) failures.push(`contains forbidden content: "${avoid}"`);
  }

  // 4. 软信号：远短于预期，记入 reasons 但不让通过失败
  //    （只在 estimateTokens >= MIN_ABS_TOKENS 且远低于估计时记录）
  const expected = task.analyzed?.estimated_output_tokens ?? 0;
  const passed = failures.length === 0;
  const softReasons: string[] = [];
  if (passed && expected > 0 && actualTokens < expected * 0.2) {
    softReasons.push(
      `note: output much shorter than estimated (~${actualTokens} vs ~${expected} tokens)`,
    );
  }

  return {
    passed,
    validator_type: "rules",
    failure_reasons: passed ? softReasons : failures,
    confidence: 0.8,
  };
}

function llmJudgeStub(_raw: string): ValidationOutcome {
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
