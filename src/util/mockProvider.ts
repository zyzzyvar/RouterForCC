/**
 * MockProvider：测试 + smoke 子命令用。
 *
 * 不依赖任何外部服务；按 model_id 返回预设响应。
 */
import type { ModelEntry } from "../core/types.js";
import type {
  Provider,
  ProviderRegistry,
  InvokeArgs,
  InvokeResult,
} from "../providers/types.js";

export interface MockBehavior {
  text: string;
  throw_error?: string;
  tokens_in?: number;
  tokens_out?: number;
}

export class MockProvider implements Provider {
  readonly name = "mock";
  public calls: InvokeArgs[] = [];
  constructor(private behavior: MockBehavior) {}

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    this.calls.push(args);
    if (this.behavior.throw_error) throw new Error(this.behavior.throw_error);
    const text = this.behavior.text;
    return {
      text,
      tokens_in: this.behavior.tokens_in ?? Math.ceil((args.system.length + args.user.length) / 3),
      tokens_out: this.behavior.tokens_out ?? Math.ceil(text.length / 3),
      usd: null,
    };
  }
}

export class MockProviderRegistry implements ProviderRegistry {
  private byModel = new Map<string, MockProvider>();
  private fallback: MockProvider;
  constructor(fallback: MockBehavior) {
    this.fallback = new MockProvider(fallback);
  }
  set(model_id: string, behavior: MockBehavior): MockProvider {
    const p = new MockProvider(behavior);
    this.byModel.set(model_id, p);
    return p;
  }
  get(model: ModelEntry): Provider {
    return this.byModel.get(model.id) ?? this.fallback;
  }
}
