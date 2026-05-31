/**
 * Provider 抽象：所有外包模型（hosted/local）共用一套调用接口。
 *
 * Provider.invoke() 返回的字段统一为：text / tokens_in / tokens_out / usd。
 *
 * ProviderRegistry：按 ModelEntry 决定走哪个 provider。
 *   - hosted → openai-compat（OpenAI、DeepSeek、Kimi、OpenRouter 等）
 *   - local + ollama → ollama
 *   - local + vllm/tgi/llamacpp → openai-compat
 */
import type { ModelEntry } from "../core/types.js";

export interface InvokeArgs {
  model_id: string;
  system: string;
  user: string;
  max_output_tokens: number;
}

export interface InvokeResult {
  text: string;
  tokens_in: number;
  tokens_out: number;
  /** local 时为 null；hosted 时按 price * tokens 估算 */
  usd: number | null;
}

export interface Provider {
  name: string;
  invoke(args: InvokeArgs): Promise<InvokeResult>;
}

export interface ProviderRegistry {
  get(model: ModelEntry): Provider;
}

// ----------------------------------------------------------------
// 默认实现：根据 ModelEntry 字段选 provider
// ----------------------------------------------------------------

import { OpenAICompatProvider } from "./openaiCompat.js";
import { OllamaProvider } from "./ollama.js";
import { SecretsStore } from "../secrets/store.js";

export interface DefaultRegistryConfig {
  secrets: SecretsStore;
}

export class DefaultProviderRegistry implements ProviderRegistry {
  constructor(private cfg: DefaultRegistryConfig) {}

  get(model: ModelEntry): Provider {
    if (model.deployment_type === "local") {
      if (model.local?.inference_engine === "ollama") {
        return new OllamaProvider({ endpoint: model.local.endpoint });
      }
      if (!model.local) throw new Error(`Local model ${model.id} missing local attributes`);
      // 若本地端点声明了 auth_ref（如 vLLM --api-key），从 SecretsStore 拿
      let localKey: string | undefined;
      if (model.local.auth_ref) {
        try {
          localKey = this.cfg.secrets.get(model.local.auth_ref);
        } catch {
          localKey = undefined;
        }
      }
      return new OpenAICompatProvider({
        endpoint: model.local.endpoint,
        model_id_in_request: model.id,
        api_key: localKey,
        pricing: null,
      });
    }
    // hosted
    if (!model.hosted) throw new Error(`Hosted model ${model.id} missing hosted attributes`);
    const api_key = this.cfg.secrets.get(model.hosted.auth_ref);
    return new OpenAICompatProvider({
      endpoint: model.hosted.endpoint,
      model_id_in_request: model.id,
      api_key,
      pricing: {
        in_per_million: model.hosted.price_per_million_input_usd,
        out_per_million: model.hosted.price_per_million_output_usd,
      },
    });
  }
}
