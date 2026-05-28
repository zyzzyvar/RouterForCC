/**
 * 集成测试公用 helper：buildTestContext() 用 :memory: SQLite 直接装配 Pipeline。
 * MockProvider 已搬到 src/util/mockProvider.ts，方便 smoke 命令复用。
 */
import type { ExecutionRecord } from "../../src/core/types.js";
import { openDatabase } from "../../src/persistence/db.js";
import { TaskStore } from "../../src/persistence/tasks.js";
import {
  ExecutionStore,
  PendingApprovalStore,
} from "../../src/persistence/executions.js";
import { ModelRegistry } from "../../src/registry/store.js";
import { Pipeline, type PipelineDeps } from "../../src/core/pipeline.js";
import { NULL_LOGGER } from "../../src/logging/logger.js";
import { buildSampleModels } from "../../src/util/fixtures.js";
import { MockProviderRegistry } from "../../src/util/mockProvider.js";

export { MockProvider, MockProviderRegistry } from "../../src/util/mockProvider.js";

export interface TestContext {
  pipeline: Pipeline;
  registry: ModelRegistry;
  tasks: TaskStore;
  executions: ExecutionStore;
  pending: PendingApprovalStore;
  providers: MockProviderRegistry;
}

export function buildTestContext(opts?: {
  providers?: MockProviderRegistry;
  seed?: boolean;
}): TestContext {
  const db = openDatabase({ filepath: ":memory:" });
  const tasks = new TaskStore(db);
  const executions = new ExecutionStore(db);
  const pending = new PendingApprovalStore(db);
  const registry = new ModelRegistry(db);

  if (opts?.seed !== false) {
    for (const m of buildSampleModels()) {
      registry.upsert({ ...m, calibration: undefined });
    }
  }

  const providers =
    opts?.providers ??
    new MockProviderRegistry({ text: "OK", tokens_in: 100, tokens_out: 50 });

  const deps: PipelineDeps = {
    registry,
    tasks,
    executions,
    pending,
    providers,
    claude: undefined,
    logger: NULL_LOGGER,
    config: {
      cost_ceiling_usd: 10,
      confidence_gap: 0.0001,
      approval_ttl_hours: 24,
      decay_half_life: 50,
    },
  };
  return {
    pipeline: new Pipeline(deps),
    registry,
    tasks,
    executions,
    pending,
    providers,
  };
}

export function findRecordByTask(
  executions: ExecutionStore,
  task_id: string,
): ExecutionRecord | undefined {
  return executions.list({ task_id }).at(0);
}
