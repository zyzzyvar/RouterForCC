/**
 * Analyzer 用的 LLM 客户端。
 *
 * 接口设计上跟"Claude"无关 —— 名字只是历史遗留。
 * 凡是能实现 `complete({system, user, ...}) → string` 的实现都可以喂给 analyzer。
 *
 * 当前提供两种实现：
 *   - AnthropicClaudeClient    经由官方 SDK 调 Claude API（需 ANTHROPIC_API_KEY）
 *   - OpenAICompatAnalyzerClient  通过 fetch 调任何 OpenAI 兼容 /v1/chat/completions
 *                                  —— 包括用户本机 vLLM、Ollama、DeepSeek 等
 *
 * bootstrap 决定用哪一个；都不可用时 analyzer 自动走启发式 fallback。
 */
import Anthropic from "@anthropic-ai/sdk";

export interface ClaudeCompleteArgs {
  system: string;
  user: string;
  max_tokens?: number;
  temperature?: number;
}

export interface ClaudeClient {
  complete(args: ClaudeCompleteArgs): Promise<string>;
}

export interface ClaudeConfig {
  api_key: string;
  model: string; // 如 "claude-sonnet-4-6"
}

export class AnthropicClaudeClient implements ClaudeClient {
  private sdk: Anthropic;
  constructor(private cfg: ClaudeConfig) {
    this.sdk = new Anthropic({ apiKey: cfg.api_key });
  }

  async complete(args: ClaudeCompleteArgs): Promise<string> {
    const resp = await this.sdk.messages.create({
      model: this.cfg.model,
      max_tokens: args.max_tokens ?? 1024,
      temperature: args.temperature ?? 0,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    });
    const block = resp.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return "";
    return block.text;
  }
}

// ============================================================================
// OpenAI 兼容版（vLLM / Ollama / DeepSeek / OpenRouter 都能用）
// ============================================================================

export interface OpenAICompatAnalyzerConfig {
  endpoint: string; // 如 http://localhost:8000/v1
  model: string;    // vLLM /v1/models 暴露的 id
  api_key?: string; // 本机 vLLM 一般不需要
}

interface ChatResp {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAICompatAnalyzerClient implements ClaudeClient {
  constructor(private cfg: OpenAICompatAnalyzerConfig) {}

  async complete(args: ClaudeCompleteArgs): Promise<string> {
    const url = `${trimEnd(this.cfg.endpoint, "/")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.api_key) headers["Authorization"] = `Bearer ${this.cfg.api_key}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          ...(args.system ? [{ role: "system", content: args.system }] : []),
          { role: "user", content: args.user },
        ],
        max_tokens: args.max_tokens ?? 1024,
        temperature: args.temperature ?? 0,
        stream: false,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`analyzer LLM ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await resp.json()) as ChatResp;
    return data.choices?.[0]?.message?.content ?? "";
  }
}

function trimEnd(s: string, ch: string): string {
  while (s.endsWith(ch)) s = s.slice(0, -1);
  return s;
}

// ============================================================================
// MCP Sampling 版（client 用自己的 Claude 帮 server 跑推理）
// ============================================================================
//
// 适用场景：router 作为 MCP server，无法 / 不想直连 Anthropic API；但 MCP
// client 端（Claude Code）已经登录了 Claude。通过 sampling/createMessage 反向
// 请求 client 跑一次 LLM 推理。Server 不持有 API key，token 走 client 订阅。
//
// 前提：MCP client 在 initialize 时声明了 capabilities.sampling。否则该实现
// 会抛错，由 analyzer.ts 的 try-catch 自动降级到 heuristic fallback。

// 用 any 包一下 Server，避免依赖 SDK 内部细节 / 不同版本 API 变化
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMcpServer = any;

export interface McpSamplingConfig {
  /**
   * 给 client 看的偏好（client 决定用哪个模型）。
   * 默认偏好 intelligence > cost > speed，因为 analyzer 输出 JSON，准确比速度重要。
   */
  model_preferences?: {
    intelligence_priority?: number;
    speed_priority?: number;
    cost_priority?: number;
  };
}

export class McpSamplingAnalyzerClient implements ClaudeClient {
  constructor(
    private server: AnyMcpServer,
    private cfg: McpSamplingConfig = {},
  ) {}

  async complete(args: ClaudeCompleteArgs): Promise<string> {
    const pref = this.cfg.model_preferences;
    const result = await this.server.createMessage({
      messages: [
        {
          role: "user",
          content: { type: "text", text: args.user },
        },
      ],
      systemPrompt: args.system || undefined,
      maxTokens: args.max_tokens ?? 1024,
      temperature: args.temperature ?? 0,
      modelPreferences: {
        intelligencePriority: pref?.intelligence_priority ?? 0.8,
        speedPriority: pref?.speed_priority ?? 0.3,
        costPriority: pref?.cost_priority ?? 0.4,
      },
      // 不要求 client 用任何特定模型 hint
    });

    // result.content 一般是 { type: "text", text: "..." }
    if (result && typeof result === "object") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content = (result as any).content;
      if (content && typeof content === "object") {
        if (content.type === "text" && typeof content.text === "string") return content.text;
        if (typeof content.text === "string") return content.text;
      }
    }
    return "";
  }
}
