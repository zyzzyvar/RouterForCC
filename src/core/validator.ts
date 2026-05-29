/**
 * 阶段⑥：校验。
 *
 * 三种校验路径：
 *   1. rules：必含/必避、真空判断
 *   2. schema：output_format == 'json' 时尝试 JSON.parse
 *   3. llm_judge：调用 Claude 做结构性裁判（当前为占位）
 *
 * 选择策略：
 *   - output_format=json → schema 验证 + 规则
 *   - 复核类任务/risk_level=high → llm_judge（占位返回 passed=true）
 *   - 其它 → rules
 *
 * 历史教训：
 *   - 原本"实际输出 < 预期 20% 视为可疑"过严，heuristic 估算 vs 实际差距常很大
 *   - 之后改成 MIN_ABS_TOKENS=3，但 estimateTokens 对 CJK 严重低估
 *     ("你好世界" 4 字符 ÷ 3 ≈ 2 tokens < 3 → 误判失败)
 *   - 现在改用 raw.trim().length === 0 直接判真空；token 估算只用作软信号
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

  // 1. 真空 = 模型拒答 / 调用层 bug；只看 trim 后是否空，避免对短回答误伤
  if (text.trim().length === 0) {
    failures.push("output is empty");
  }

  // 2. 必含
  for (const must of task.constraints.must_include) {
    if (!text.includes(must)) failures.push(`missing required content: "${must}"`);
  }
  // 3. 必避
  for (const avoid of task.constraints.must_avoid) {
    if (text.includes(avoid)) failures.push(`contains forbidden content: "${avoid}"`);
  }

  // 4. 软信号：远短于预期，记入 reasons 但 passed=true
  const expected = task.analyzed?.estimated_output_tokens ?? 0;
  const passed = failures.length === 0;
  const actualTokens = estimateTokens(text);
  const softReasons: string[] = [];
  if (passed && expected > 0 && actualTokens > 0 && actualTokens < expected * 0.2) {
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

/**
 * 估算 token 数，区分 CJK 与 ASCII：
 *   - CJK 字符（汉字 / 假名 / 韩文 / 全角符号）：~1 token / char
 *   - 其它（ASCII 单词、空格、英文标点）：~1 token / 3 chars
 * 这是 GPT/Claude 系 tokenizer 的粗略经验值；只用于估算，不要求精确。
 */
function estimateTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  // Array.from 按 code point 遍历，正确处理 surrogate pair
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    // 主要 CJK 范围：汉字、假名、韩文、全角符号、半宽假名
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0x3000 && cp <= 0x30ff) || // CJK Symbols, Hiragana, Katakana
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
      (cp >= 0xff00 && cp <= 0xffef) || // Halfwidth/Fullwidth Forms
      (cp >= 0x20000 && cp <= 0x2ffff) // CJK Extensions B+
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + Math.ceil(other / 3);
}
