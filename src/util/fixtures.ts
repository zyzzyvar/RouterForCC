/**
 * 测试 / bootstrap 用的样例 ModelEntry。
 *
 * 包含压力组合 B 的两个模型：
 *   - gpt-4o-mini（hosted, 商业 API）
 *   - qwen2.5-72b-local（local, vLLM 部署）
 *
 * 还包括一个 deepseek-chat 作为成本对比基准。
 */
import { ModelEntrySchema, type ModelEntry, type ModelEntryInput } from "../core/types.js";

const NOW = "2026-05-25T00:00:00.000Z";

export const SAMPLE_INPUTS: ModelEntryInput[] = [
  // hosted: GPT-4o
  {
    id: "gpt-4o-mini",
    display_name: "GPT-4o Mini",
    vendor: "openai",
    version: "2024-07-18",
    status: "active",
    deployment_type: "hosted",
    context_max: 128_000,
    context_effective: 128_000,
    max_output_tokens: 16_384,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supports_tool_use: true,
    supports_strict_json: true,
    supports_streaming: true,
    hosted: {
      endpoint: "https://api.openai.com/v1",
      auth_ref: "openai_api_key",
      price_per_million_input_usd: 0.15,
      price_per_million_output_usd: 0.6,
      price_updated_at: NOW,
      tier_concurrency_limit: 500,
      avg_first_token_latency_ms: 600,
      data_residency: "us",
      used_for_training: false,
    },
    compliance: {
      can_process_pii: false,
      can_process_confidential: false,
      data_egress_region: "us",
      notes: "Standard tier; no DPA.",
    },
    capability_scores: {
      instruction_following: 4.4,
      chinese_quality: 3.8,
      structured_output: 4.5,
      code: 4.2,
      long_form_coherence: 4.0,
      translation: 4.1,
      factual_accuracy: 4.2,
      math_reasoning: 4.3,
      critical_judgment: 4.0,
      tool_use: 4.6,
    },
    soft_labels: {
      free_description: "性价比版 GPT-4o；遵循指令稳，工具调用强。",
      strengths: ["instruction_following", "tool_use", "structured_output"],
      weaknesses: ["chinese_quality 相对弱于国产同档"],
      prompt_recipes: [
        "用最少的废话回答；先给结论再给细节。",
      ],
      avoid_patterns: [],
    },
  },

  // local: Qwen2.5-72B
  {
    id: "qwen2.5-72b-local",
    display_name: "Qwen2.5-72B (vLLM)",
    vendor: "alibaba",
    version: "2.5",
    status: "active",
    deployment_type: "local",
    context_max: 131_072,
    context_effective: 65_536, // YaRN 扩展后保守用一半
    max_output_tokens: 8_192,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supports_tool_use: true,
    supports_strict_json: true,
    supports_streaming: true,
    local: {
      inference_engine: "vllm",
      endpoint: "http://127.0.0.1:8000/v1",
      gpu_footprint: "2xA100-80G",
      quantization: "fp16",
      throughput_tokens_per_sec: 80,
      max_concurrent_requests: 8,
    },
    compliance: {
      can_process_pii: true,
      can_process_confidential: true,
      data_egress_region: null,
      notes: "本地部署，数据不出域。",
    },
    capability_scores: {
      instruction_following: 4.2,
      chinese_quality: 4.6,
      structured_output: 4.3,
      code: 4.0,
      long_form_coherence: 4.3,
      translation: 4.4,
      factual_accuracy: 3.9,
      math_reasoning: 4.1,
      critical_judgment: 3.8,
      tool_use: 4.0,
    },
    soft_labels: {
      free_description: "本地零成本，中文表现优；长文连贯性好。",
      strengths: ["chinese_quality", "translation", "long_form_coherence"],
      weaknesses: ["factual_accuracy 中等", "工具调用编排不如商业模型"],
      prompt_recipes: [
        "用中文回答；先给思考再给结论。",
      ],
      avoid_patterns: [
        {
          description: "极长文档写作时上下文有限，避免单次 > 6000 输出",
          condition_expr: "task_type == 'long_writing' AND estimated_output_tokens > 6000",
        },
      ],
    },
  },

  // hosted: DeepSeek-Chat（性价比基线，便于对比）
  {
    id: "deepseek-chat",
    display_name: "DeepSeek Chat",
    vendor: "deepseek",
    version: "v3",
    status: "active",
    deployment_type: "hosted",
    context_max: 64_000,
    context_effective: 64_000,
    max_output_tokens: 8_192,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supports_tool_use: true,
    supports_strict_json: true,
    supports_streaming: true,
    hosted: {
      endpoint: "https://api.deepseek.com/v1",
      auth_ref: "deepseek_api_key",
      price_per_million_input_usd: 0.14,
      price_per_million_output_usd: 0.28,
      price_updated_at: NOW,
      tier_concurrency_limit: 60,
      avg_first_token_latency_ms: 900,
      data_residency: "cn",
      used_for_training: false,
    },
    compliance: {
      can_process_pii: false,
      can_process_confidential: false,
      data_egress_region: "cn",
      notes: "",
    },
    capability_scores: {
      instruction_following: 4.0,
      chinese_quality: 4.3,
      structured_output: 4.0,
      code: 4.4,
      long_form_coherence: 4.0,
      translation: 4.0,
      factual_accuracy: 3.9,
      math_reasoning: 4.4,
      critical_judgment: 3.9,
      tool_use: 4.0,
    },
    soft_labels: {
      free_description: "代码与数学强，价格低。",
      strengths: ["code", "math_reasoning"],
      weaknesses: [],
      prompt_recipes: [],
      avoid_patterns: [],
    },
  },
];

export function buildSampleModels(): ModelEntry[] {
  return SAMPLE_INPUTS.map((s) =>
    ModelEntrySchema.parse({
      ...s,
      registered_at: NOW,
      last_updated_at: NOW,
      calibration: {},
    }),
  );
}

// ============================================================================
// 用环境变量构造一条用户的 vLLM ModelEntry：
//   VLLM_ENDPOINT      http://localhost:8000/v1
//   VLLM_MODEL_ID      Qwen2.5-72B-Instruct  （vLLM 在 /v1/models 暴露的 id）
//   VLLM_DISPLAY_NAME  可选；默认 = VLLM_MODEL_ID
//   VLLM_CONTEXT_MAX   可选；默认 131072
//   VLLM_CONTEXT_EFF   可选；默认 65536
//
// 这是为了让 `router seed-fixtures` 能一行接入用户本机 vLLM，
// 不必手写一份 JSON。
// ============================================================================

export function buildVllmModelFromEnv(): ModelEntryInput | null {
  const endpoint = process.env.VLLM_ENDPOINT;
  const modelId = process.env.VLLM_MODEL_ID;
  if (!endpoint || !modelId) return null;

  const ctxMax = Number(process.env.VLLM_CONTEXT_MAX ?? 131_072);
  const ctxEff = Number(process.env.VLLM_CONTEXT_EFF ?? 65_536);
  const display = process.env.VLLM_DISPLAY_NAME ?? modelId;

  const entry: ModelEntryInput = {
    id: modelId,
    display_name: display,
    vendor: "self-hosted",
    version: "1",
    status: "active",
    deployment_type: "local",
    context_max: ctxMax,
    context_effective: Math.min(ctxEff, ctxMax),
    max_output_tokens: 8_192,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supports_tool_use: true,
    supports_strict_json: true,
    supports_streaming: true,
    local: {
      inference_engine: "vllm",
      endpoint,
      gpu_footprint: process.env.VLLM_GPU ?? "unknown",
      quantization: "fp16",
      throughput_tokens_per_sec: 60,
      max_concurrent_requests: 8,
    },
    compliance: {
      can_process_pii: true,
      can_process_confidential: true,
      data_egress_region: null,
      notes: "本地 vLLM，数据不出域。",
    },
    capability_scores: {
      instruction_following: 4.0,
      chinese_quality: 4.0,
      structured_output: 4.0,
      code: 4.0,
      long_form_coherence: 4.0,
      translation: 4.0,
      factual_accuracy: 3.8,
      math_reasoning: 4.0,
      critical_judgment: 3.8,
      tool_use: 4.0,
    },
    soft_labels: {
      free_description: "用户本机 vLLM，由环境变量注入。",
      strengths: [],
      weaknesses: [],
      prompt_recipes: ["保持回答简洁。"],
      avoid_patterns: [],
    },
  };
  return entry;
}
