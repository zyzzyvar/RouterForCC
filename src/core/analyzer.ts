/**
 * 阶段①：任务分析。
 *
 * 用 Claude 把 raw_description + inputs 解析为结构化的 TaskAnalyzed。
 *
 * 当前为骨架：
 *   - analyzeWithClaude()：调用 ClaudeClient.complete()，要求严格 JSON 输出，
 *     用 TaskAnalyzedSchema 做 zod 解析。
 *   - heuristicAnalyze()：在 Claude 不可用 / 离线测试时的应急 fallback，
 *     基于关键词与字符数粗估字段。
 *
 * 设计抉择：analyzer 不读模型注册表 —— 它只描述任务，不挑模型。
 *           因此可独立测试，也方便未来换成纯本地小模型分析。
 */
import { TaskAnalyzedSchema, type TaskAnalyzed, type TaskInputs, type TaskHints } from "./types.js";
import type { ClaudeClient } from "../claude/client.js";

const SYSTEM_PROMPT = `You are a task analyzer for an LLM router. Read the user's task description and any provided inputs, then output a STRICT JSON object matching this schema (no markdown fences, no commentary):

{
  "task_type": "code" | "long_writing" | "structured_extraction" | "translation" | "factual_qa" | "validation" | "math" | "other",
  "task_type_mix": { "<task_type>": <fraction 0..1>, ... }  // optional, only when truly composite
  "primary_language": "zh" | "en" | "auto" | "mixed",
  "estimated_input_tokens": <int>,
  "estimated_output_tokens": <int>,
  "requires_tool_use": <bool>,
  "requires_modality": ["text" | "image" | "audio"],
  "sensitivity_level": "low" | "medium" | "high",
  "risk_level": "low" | "medium" | "high",
  "difficulty_hint": 1..5,
  "format_constraints": [<string>, ...]
}

Be conservative. Default to "low" sensitivity/risk unless the description suggests confidential or high-stakes content.`;

export interface AnalyzeArgs {
  raw_description: string;
  inputs: TaskInputs;
  hints: TaskHints;
}

export interface AnalyzerOptions {
  claude?: ClaudeClient;
  /** 若为 true 或 claude 缺失，使用启发式 fallback */
  use_heuristic?: boolean;
}

export async function analyze(
  args: AnalyzeArgs,
  options: AnalyzerOptions = {},
): Promise<TaskAnalyzed> {
  if (!options.claude || options.use_heuristic) {
    return heuristicAnalyze(args);
  }
  try {
    return await analyzeWithClaude(args, options.claude);
  } catch {
    // 退化：任何调用 / 解析失败都走 fallback
    return heuristicAnalyze(args);
  }
}

async function analyzeWithClaude(args: AnalyzeArgs, claude: ClaudeClient): Promise<TaskAnalyzed> {
  const userMsg = renderUserMessage(args);
  const raw = await claude.complete({
    system: SYSTEM_PROMPT,
    user: userMsg,
    max_tokens: 1024,
    temperature: 0,
  });
  const json = stripFences(raw);
  return TaskAnalyzedSchema.parse(JSON.parse(json));
}

function renderUserMessage(args: AnalyzeArgs): string {
  const parts: string[] = [];
  parts.push(`# Task description\n${args.raw_description}`);
  if (args.inputs.text) parts.push(`# Inputs\n${truncate(args.inputs.text, 4000)}`);
  if (args.inputs.files.length > 0) {
    parts.push(`# Attached files\n${args.inputs.files.map((f) => `- ${f.path} (${f.mime})`).join("\n")}`);
  }
  if (args.hints.sensitivity_level) parts.push(`# Caller-supplied sensitivity hint: ${args.hints.sensitivity_level}`);
  if (args.hints.risk_level) parts.push(`# Caller-supplied risk hint: ${args.hints.risk_level}`);
  parts.push("Return ONLY the JSON object.");
  return parts.join("\n\n");
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "… [truncated]" : s;
}

// ============================================================================
// 启发式 fallback
// ============================================================================

/**
 * 在 Claude 不可用 / 单元测试场景下的应急分析。
 *
 * 准确度有限，但保证 pipeline 可跑：
 *   - task_type 用关键词匹配
 *   - tokens 用字符/4 粗估
 *   - 语言由全角与中文字符比例判断
 */
export function heuristicAnalyze(args: AnalyzeArgs): TaskAnalyzed {
  const desc = args.raw_description;
  const text = `${desc}\n${args.inputs.text ?? ""}`;
  const task_type = guessTaskType(desc);
  const primary_language = guessLanguage(text);
  const estimated_input_tokens = Math.ceil(text.length / 3);
  const estimated_output_tokens = guessOutputTokens(task_type, desc);
  const sensitivity_level = args.hints.sensitivity_level ?? "low";
  const risk_level = args.hints.risk_level ?? "low";

  return TaskAnalyzedSchema.parse({
    task_type,
    primary_language,
    estimated_input_tokens,
    estimated_output_tokens,
    requires_tool_use: /工具|tool[_ ]use|MCP|API 调用/i.test(desc),
    requires_modality: ["text"],
    sensitivity_level,
    risk_level,
    difficulty_hint: 3,
    format_constraints: [],
  });
}

function guessTaskType(d: string): TaskAnalyzed["task_type"] {
  const s = d.toLowerCase();
  if (/code|代码|函数|脚本|bug/i.test(s)) return "code";
  if (/翻译|translate|trans/i.test(s)) return "translation";
  if (/抽取|extract|json|schema/i.test(s)) return "structured_extraction";
  if (/复核|审|critique|judge|review/i.test(s)) return "validation";
  if (/数学|math|计算|证明/i.test(s)) return "math";
  if (/文档|长文|文章|report|article|长写作/i.test(s)) return "long_writing";
  if (/什么|why|how|where|when|是谁|事实/i.test(s)) return "factual_qa";
  return "other";
}

function guessLanguage(t: string): TaskAnalyzed["primary_language"] {
  const total = t.length || 1;
  const cjk = (t.match(/[一-鿿]/g) ?? []).length;
  const ratio = cjk / total;
  if (ratio > 0.5) return "zh";
  if (ratio < 0.05) return "en";
  return "mixed";
}

function guessOutputTokens(t: TaskAnalyzed["task_type"], d: string): number {
  if (t === "long_writing") return 4000;
  if (t === "code") return 1500;
  if (t === "structured_extraction") return 800;
  if (t === "factual_qa") return 400;
  if (t === "math") return 600;
  if (t === "validation") return 500;
  if (t === "translation") return Math.max(400, Math.ceil(d.length / 3));
  return 600;
}
