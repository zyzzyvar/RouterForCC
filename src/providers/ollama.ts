/**
 * Ollama provider：POST /api/chat。
 * 本地零成本；返回 prompt_eval_count / eval_count 作为 tokens 计数。
 */
import type { Provider, InvokeArgs, InvokeResult } from "./types.js";

export interface OllamaConfig {
  endpoint: string; // 形如 http://localhost:11434
}

interface OllamaResp {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  constructor(private cfg: OllamaConfig) {}

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    const url = `${trimEnd(this.cfg.endpoint, "/")}/api/chat`;
    const body = {
      model: args.model_id,
      messages: [
        ...(args.system ? [{ role: "system", content: args.system }] : []),
        { role: "user", content: args.user },
      ],
      stream: false,
      options: { num_predict: args.max_output_tokens, temperature: 0 },
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`ollama ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await resp.json()) as OllamaResp;
    const text = data.message?.content ?? "";
    return {
      text,
      tokens_in: data.prompt_eval_count ?? Math.ceil((args.system.length + args.user.length) / 3),
      tokens_out: data.eval_count ?? Math.ceil(text.length / 3),
      usd: null,
    };
  }
}

function trimEnd(s: string, ch: string): string {
  while (s.endsWith(ch)) s = s.slice(0, -1);
  return s;
}
