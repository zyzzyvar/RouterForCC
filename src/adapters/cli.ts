/**
 * CLI adapter (commander).
 *
 * A. 给"人"看的（开发/排错）
 *    router serve [--http] [--mcp]
 *    router models list | add <file> | remove <id>
 *    router tasks get <task_id>
 *    router delegate <description>     // 完整 JSON envelope
 *    router seed-fixtures [--vllm-only]
 *    router smoke
 *
 * B. 给"程序"看的（Claude Code / 其它 agent 当 subprocess 调用）
 *    router run "task description"
 *      默认：stdout 只输出模型回答；stderr 静默；exit 0=success / 1=fail / 2=pending / 3=usage
 *      --format json | --stdin | --lang | --cost-ceiling | --caller-id | --idempotency | --verbose
 *    router approve <continuation_token>
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DelegateInputSchema, ModelEntryInputSchema } from "../core/schemas.js";
import { loadConfig } from "../config/loader.js";
import { bootstrap } from "../util/bootstrap.js";
import { serveHttp } from "./http.js";
import { serveMcp } from "./mcp.js";
import { buildSampleModels, buildVllmModelFromEnv } from "../util/fixtures.js";
import { openDatabase } from "../persistence/db.js";
import { TaskStore } from "../persistence/tasks.js";
import { ExecutionStore, PendingApprovalStore } from "../persistence/executions.js";
import { ModelRegistry } from "../registry/store.js";
import { Pipeline } from "../core/pipeline.js";
import { createLogger } from "../logging/logger.js";
import { MockProviderRegistry } from "../util/mockProvider.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_PENDING_APPROVAL = 2;
const EXIT_USAGE = 3;

export function buildCli(): Command {
  const program = new Command()
    .name("router")
    .description("Controllable execution router: pick model, run subtask, validate.")
    .version("0.1.0");

  // serve
  program
    .command("serve")
    .description("Start service (HTTP and/or MCP-over-HTTP).")
    .option("--http", "enable HTTP API", false)
    .option("--mcp", "enable MCP-over-HTTP", false)
    .option("--config <path>", "path to TOML config")
    .action(async (opts: { http: boolean; mcp: boolean; config?: string }) => {
      const cfg = loadConfig({ override_path: opts.config });
      const ctx = await bootstrap(cfg);
      const enableHttp = opts.http || (!opts.http && !opts.mcp);
      if (enableHttp) {
        serveHttp({ port: cfg.server.http_port, bind: cfg.server.bind, ctx });
        ctx.logger.info({ port: cfg.server.http_port, bind: cfg.server.bind }, "HTTP listening");
      }
      if (opts.mcp) {
        await serveMcp({ port: cfg.server.mcp_port, bind: cfg.server.bind, ctx });
        ctx.logger.info({ port: cfg.server.mcp_port }, "MCP-over-HTTP listening");
      }
    });

  // models
  const models = program.command("models").description("Manage model registry");
  models.command("list").action(async () => {
    const ctx = await bootstrap(loadConfig());
    process.stdout.write(JSON.stringify(ctx.registry.list(), null, 2) + "\n");
  });
  models
    .command("add <file>")
    .description("Register/upsert a ModelEntry from JSON file")
    .action(async (file: string) => {
      const ctx = await bootstrap(loadConfig());
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const entry = ctx.registry.upsert(ModelEntryInputSchema.parse(raw));
      process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
    });
  models.command("remove <id>").action(async (id: string) => {
    const ctx = await bootstrap(loadConfig());
    ctx.registry.remove(id);
    process.stdout.write(`removed: ${id}\n`);
  });

  // tasks
  program
    .command("tasks")
    .command("get <task_id>")
    .action(async (task_id: string) => {
      const ctx = await bootstrap(loadConfig());
      process.stdout.write(JSON.stringify(ctx.tasks.get(task_id), null, 2) + "\n");
    });

  // delegate (full JSON envelope)
  program
    .command("delegate <description>")
    .option("--lang <lang>", "zh|en|auto|mixed")
    .option("--cost-ceiling <usd>", "cost ceiling in USD")
    .option("--caller-id <id>", "caller id", "cli")
    .action(
      async (
        description: string,
        opts: { lang?: string; costCeiling?: string; callerId: string },
      ) => {
        const ctx = await bootstrap(loadConfig());
        const input = DelegateInputSchema.parse({
          description,
          caller_id: opts.callerId,
          constraints: opts.lang ? { language: opts.lang } : {},
          hints: opts.costCeiling
            ? { cost_ceiling_usd: Number(opts.costCeiling) }
            : {},
        });
        const result = await ctx.pipeline.runDelegate(input);
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      },
    );

  // run (subprocess-friendly)
  program
    .command("run [description]")
    .description(
      "Run a subtask. Default: prints model output text to stdout, silent stderr, exit 0/1/2.",
    )
    .option("--stdin", "read description from stdin", false)
    .option("--format <fmt>", "text|json", "text")
    .option("--lang <lang>", "zh|en|auto|mixed")
    .option("--cost-ceiling <usd>", "cost ceiling in USD")
    .option("--caller-id <id>", "caller id", "claude-code")
    .option("--idempotency <key>", "idempotency key to dedupe repeated calls")
    .option("--verbose", "show stderr logs (default silent)", false)
    .action(
      async (
        description: string | undefined,
        opts: {
          stdin: boolean;
          format: string;
          lang?: string;
          costCeiling?: string;
          callerId: string;
          idempotency?: string;
          verbose: boolean;
        },
      ) => {
        const desc = opts.stdin ? await readAllStdin() : description;
        if (!desc || !desc.trim()) {
          process.stderr.write(
            "ERROR: missing description (pass as arg or use --stdin)\n",
          );
          process.exit(EXIT_USAGE);
        }

        const cfg = loadConfig();
        if (!opts.verbose) cfg.logging.level = "error";
        const ctx = await bootstrap(cfg);

        const input = DelegateInputSchema.parse({
          description: desc,
          caller_id: opts.callerId,
          constraints: opts.lang ? { language: opts.lang } : {},
          hints: opts.costCeiling
            ? { cost_ceiling_usd: Number(opts.costCeiling) }
            : {},
          idempotency_key: opts.idempotency,
        });

        const result = await ctx.pipeline.runDelegate(input);

        if (opts.format === "json") {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          if (opts.verbose) {
            process.stderr.write(
              `[router] chosen=${result.proposal?.chosen_model_id ?? "-"} status=${result.status}\n`,
            );
          }
          if (result.result) process.stdout.write(result.result);
          else if (result.error)
            process.stderr.write(
              `[router] ${result.error.code}: ${result.error.message}\n`,
            );
        }

        const code =
          result.status === "executed"
            ? EXIT_OK
            : result.status === "pending_approval"
              ? EXIT_PENDING_APPROVAL
              : EXIT_FAILED;
        if (code === EXIT_PENDING_APPROVAL && opts.format !== "json") {
          process.stdout.write(`\n[continuation_token=${result.continuation_token}]\n`);
        }
        process.exit(code);
      },
    );

  // approve
  program
    .command("approve <continuation_token>")
    .description("Resume a pending-approval task")
    .option("--format <fmt>", "text|json", "text")
    .action(async (token: string, opts: { format: string }) => {
      const ctx = await bootstrap(loadConfig());
      const result = await ctx.pipeline.confirmAndExecute(token);
      if (opts.format === "json") {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else if (result.result) {
        process.stdout.write(result.result);
      }
      process.exit(result.status === "executed" ? EXIT_OK : EXIT_FAILED);
    });

  // seed-fixtures
  program
    .command("seed-fixtures")
    .description(
      "Insert sample ModelEntry rows. If VLLM_ENDPOINT+VLLM_MODEL_ID set, also seeds your vLLM.",
    )
    .option("--vllm-only", "only seed env-driven vLLM entry, skip samples", false)
    .action(async (opts: { vllmOnly: boolean }) => {
      const ctx = await bootstrap(loadConfig());
      if (!opts.vllmOnly) {
        for (const m of buildSampleModels()) {
          ctx.registry.upsert({ ...m, calibration: undefined });
          process.stdout.write(`seeded: ${m.id}\n`);
        }
      }
      const vllm = buildVllmModelFromEnv();
      if (vllm) {
        ctx.registry.upsert(vllm);
        process.stdout.write(
          `seeded from env: ${vllm.id}  (endpoint=${vllm.local?.endpoint})\n`,
        );
      } else if (opts.vllmOnly) {
        process.stderr.write(
          "ERROR: --vllm-only set but VLLM_ENDPOINT / VLLM_MODEL_ID env not provided.\n",
        );
        process.exitCode = EXIT_USAGE;
      }
    });

  // smoke
  program
    .command("smoke")
    .description("Offline smoke test: in-memory DB + MockProvider, no API keys needed.")
    .option("--task <desc>", "task description", "请写一个 quicksort 函数。")
    .action(async (opts: { task: string }) => {
      const logger = createLogger({ level: "info", pretty: true });
      const db = openDatabase({ filepath: ":memory:" });
      const tasks = new TaskStore(db);
      const executions = new ExecutionStore(db);
      const pending = new PendingApprovalStore(db);
      const registry = new ModelRegistry(db);
      for (const m of buildSampleModels()) {
        registry.upsert({ ...m, calibration: undefined });
      }
      const mockText = [
        "// [smoke mock] — pipeline 端到端跑通的伪造回答。",
        "// 真实场景里这里会是你 vLLM 生成的 quicksort 实现。",
        "function quicksort(arr) {",
        "  if (arr.length <= 1) return arr.slice();",
        "  const pivot = arr[0];",
        "  const left = [];",
        "  const right = [];",
        "  for (let i = 1; i < arr.length; i++) {",
        "    if (arr[i] < pivot) left.push(arr[i]); else right.push(arr[i]);",
        "  }",
        "  return [...quicksort(left), pivot, ...quicksort(right)];",
        "}",
      ].join("\n");
      const providers = new MockProviderRegistry({
        text: mockText,
        tokens_in: 200,
        tokens_out: 120,
      });
      const pipeline = new Pipeline({
        registry,
        tasks,
        executions,
        pending,
        providers,
        claude: undefined,
        logger: logger.child({ component: "smoke" }),
        config: {
          cost_ceiling_usd: 10,
          confidence_gap: 0.0001,
          approval_ttl_hours: 24,
          decay_half_life: 50,
        },
      });
      const result = await pipeline.runDelegate({
        description: opts.task,
        caller_id: "smoke-test",
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (result.status !== "executed") {
        process.stderr.write(`FAIL: status=${result.status}\n`);
        process.exitCode = EXIT_FAILED;
      } else {
        process.stderr.write("OK — pipeline ran end-to-end with mock provider.\n");
      }
    });

  return program;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
