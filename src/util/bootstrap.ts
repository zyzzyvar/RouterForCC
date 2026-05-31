/**
 * Bootstrap：把 config / db / stores / registry / providers / analyzerLlm / pipeline
 * 装配起来。
 *
 * Analyzer LLM 的挑选优先级（高到低）：
 *   1. env ANALYZER_VLLM_ENDPOINT + ANALYZER_VLLM_MODEL_ID → OpenAI 兼容 endpoint
 *   2. config.claude.auth_ref 在 secrets 里存在 → Claude
 *   3. 都没有 → undefined，analyzer 走启发式 fallback
 */
import { type Config } from "../config/schema.js";
import { openDatabase } from "../persistence/db.js";
import { TaskStore } from "../persistence/tasks.js";
import { ExecutionStore, PendingApprovalStore } from "../persistence/executions.js";
import { ModelRegistry } from "../registry/store.js";
import { DefaultProviderRegistry } from "../providers/types.js";
import { SecretsStore, preloadKeytar } from "../secrets/store.js";
import {
  AnthropicClaudeClient,
  OpenAICompatAnalyzerClient,
  type ClaudeClient,
} from "../claude/client.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { Pipeline } from "../core/pipeline.js";

export interface AppContext {
  config: Config;
  logger: Logger;
  registry: ModelRegistry;
  tasks: TaskStore;
  executions: ExecutionStore;
  pending: PendingApprovalStore;
  pipeline: Pipeline;
  secrets: SecretsStore;
  analyzer_llm?: ClaudeClient;
  analyzer_llm_source?: "vllm" | "claude" | "heuristic";
}

export async function bootstrap(config: Config): Promise<AppContext> {
  const logger = createLogger(config.logging);

  const db = openDatabase({ filepath: config.storage.sqlite_path });
  const tasks = new TaskStore(db);
  const executions = new ExecutionStore(db);
  const pending = new PendingApprovalStore(db);
  const registry = new ModelRegistry(db);

  const secrets = new SecretsStore({
    backend: config.secrets.backend,
    service: config.secrets.service,
    file_path: config.secrets.file_path,
  });

  const refs = new Set<string>([config.claude.auth_ref]);
  for (const m of registry.listActiveFull()) {
    if (m.deployment_type === "hosted" && m.hosted?.auth_ref) refs.add(m.hosted.auth_ref);
    if (m.deployment_type === "local" && m.local?.auth_ref) refs.add(m.local.auth_ref);
  }
  await preloadKeytar(config.secrets.service, [...refs]);

  const { client: analyzer_llm, source: analyzer_llm_source } = pickAnalyzerLlm(
    config,
    secrets,
    logger,
  );

  const providers = new DefaultProviderRegistry({ secrets });

  const pipeline = new Pipeline({
    registry,
    tasks,
    executions,
    pending,
    providers,
    claude: analyzer_llm,
    logger: logger.child({ component: "pipeline" }),
    config: {
      cost_ceiling_usd: config.router.cost_ceiling_usd,
      confidence_gap: config.router.confidence_gap,
      approval_ttl_hours: config.router.approval_ttl_hours,
      decay_half_life: config.calibration.decay_half_life,
    },
  });

  return {
    config,
    logger,
    registry,
    tasks,
    executions,
    pending,
    pipeline,
    secrets,
    analyzer_llm,
    analyzer_llm_source,
  };
}

function pickAnalyzerLlm(
  config: Config,
  secrets: SecretsStore,
  logger: Logger,
): { client?: ClaudeClient; source: "vllm" | "claude" | "heuristic" } {
  const vllmEndpoint = process.env.ANALYZER_VLLM_ENDPOINT;
  const vllmModel = process.env.ANALYZER_VLLM_MODEL_ID;
  if (vllmEndpoint && vllmModel) {
    logger.info(
      { endpoint: vllmEndpoint, model: vllmModel },
      "analyzer using OpenAI-compatible endpoint",
    );
    return {
      client: new OpenAICompatAnalyzerClient({
        endpoint: vllmEndpoint,
        model: vllmModel,
        api_key: process.env.ANALYZER_VLLM_API_KEY,
      }),
      source: "vllm",
    };
  }

  try {
    const key = secrets.get(config.claude.auth_ref);
    logger.info({ model: config.claude.model }, "analyzer using Claude");
    return {
      client: new AnthropicClaudeClient({ api_key: key, model: config.claude.model }),
      source: "claude",
    };
  } catch (e) {
    logger.info(
      { err: (e as Error).message },
      "no Claude key; analyzer falling back to heuristic",
    );
  }

  return { source: "heuristic" };
}
