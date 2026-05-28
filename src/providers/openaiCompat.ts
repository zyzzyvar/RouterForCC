/**
 * OpenAI Chat Completions 兼容 provider。
 *
 * 适配范围（这一个 provider 能覆盖大半江山）：
 *   - OpenAI / DeepSeek / Kimi / 智谱 (glm-4) / OpenRouter / SiliconFlow
 *   - 本地 vLLM、TGI、llama.cpp server
 *
 * 不处理流式：当前服务以"完整结果"为契约。
 * usage 字段（input_tokens/output_tokens）若服务端返回则用；否则保守估算。
 */
import type { Provider, InvokeArgs, InvokeResult } from "./types.js";

export interface OpenAICompatConfig {
  endpoint: string; // 形如 https://api.openai.com/v1
  model_id_in_request: string;
  api_key?: string;
  pricing: { in_per_million: number; out_per_million: number } | null;
}

interface ChatResp {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatProvider implements Provider {
  readonly name = "openai-compat";
  constructor(private cfg: OpenAICompatConfig) {}

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    const url = `${trimEnd(this.cfg.endpoint, "/")}/chat/completions`;
    const body = {
      model: this.cfg.model_id_in_request,
      messages: [
        ...(args.system ? [{ role: "system", content: args.system }] : []),
        { role: "user", content: args.user },
      ],
      max_tokens: args.max_output_tokens,
      temperature: 0,
      stream: false,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.api_key) headers["Authorization"] = `Bearer ${this.cfg.api_key}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`openai-compat ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await resp.json()) as ChatResp;
    const text = data.choices?.[0]?.message?.content ?? "";
    const tokens_in = data.usage?.prompt_tokens ?? estimateTokens(args.system + args.user);
    const tokens_out = data.usage?.completion_tokens ?? estimateTokens(text);
    const usd = this.cfg.pricing
      ? (tokens_in / 1_000_000) * this.cfg.pricing.in_per_million +
        (tokens_out / 1_000_000) * this.cfg.pricing.out_per_million
      : null;
    return { text, tokens_in, tokens_out, usd };
  }
}

function trimEnd(s: string, ch: string): string {
  while (s.endsWith(ch)) s = s.slice(0, -1);
  return s;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3);
}
