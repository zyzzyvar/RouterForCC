/**
 * 阶段⑤：执行。
 *
 * 输入 Proposal + ModelEntry，调用对应的 provider，返回 ExecutionRecord 的原始字段。
 *
 * 重试策略：
 *   - 网络/瞬时错误：最多 2 次指数退避（200/600ms）
 *   - 空响应（reasoning 模型常因 max_tokens 太小返回空）：可重试错，每次翻倍预算
 *   - 显式 401/403/404：直接失败
 *   - max_tokens 地板 2048，避免 reasoning 模型把预算吃光后无输出
 */
import type { ModelEntry, Proposal } from "./types.js";
import type { ProviderRegistry, Provider } from "../providers/types.js";

export interface ExecuteArgs {
  proposal: Proposal;
  model: ModelEntry;
  registry: ProviderRegistry;
}

export interface ExecuteOutcome {
  raw_output: string;
  tokens_in: number;
  tokens_out: number;
  usd: number | null;
  latency_ms: number;
  retries: number;
  retry_history: Array<{ attempt: number; model_id: string; failure_reason: string }>;
  started_at: string;
  completed_at: string;
}

export async function execute(args: ExecuteArgs): Promise<ExecuteOutcome> {
  const { proposal, model, registry } = args;
  const provider: Provider = registry.get(model);

  const retry_history: ExecuteOutcome["retry_history"] = [];
  const max_attempts = 3;
  const backoffs = [0, 200, 600];

  const started_at = new Date().toISOString();
  const t0 = Date.now();

  const MIN_BUDGET = 2048;
  const baseBudget = Math.max(
    MIN_BUDGET,
    proposal.estimated_cost.tokens_out * 2 + 256,
  );

  for (let attempt = 1; attempt <= max_attempts; attempt++) {
    try {
      if (attempt > 1) await sleep(backoffs[attempt - 1] ?? 0);
      const budget = Math.min(
        model.max_output_tokens,
        baseBudget * attempt,
      );
      const r = await provider.invoke({
        model_id: model.id,
        system: proposal.prompt.system,
        user: proposal.prompt.user,
        max_output_tokens: budget,
      });
      if (!r.text || r.text.trim().length === 0) {
        throw new Error(`provider returned empty content (max_tokens=${budget})`);
      }
      const completed_at = new Date().toISOString();
      const latency_ms = Date.now() - t0;
      return {
        raw_output: r.text,
        tokens_in: r.tokens_in,
        tokens_out: r.tokens_out,
        usd: r.usd,
        latency_ms,
        retries: attempt - 1,
        retry_history,
        started_at,
        completed_at,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      retry_history.push({ attempt, model_id: model.id, failure_reason: reason });
      if (attempt === max_attempts || !isRetryable(err)) {
        throw new ExecuteError(
          `executor: ${model.id} failed after ${attempt} attempts: ${reason}`,
          retry_history,
        );
      }
    }
  }
  throw new ExecuteError(
    `executor: exhausted retries for ${model.id}`,
    retry_history,
  );
}

export class ExecuteError extends Error {
  constructor(
    message: string,
    public readonly retry_history: ExecuteOutcome["retry_history"],
  ) {
    super(message);
    this.name = "ExecuteError";
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const m = err.message.toLowerCase();
  if (/(401|403|404|invalid api key|unauthorized|forbidden)/.test(m)) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
