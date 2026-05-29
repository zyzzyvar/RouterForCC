/**
 * CLI adapter (commander).
 *
 * 命令：
 *   router serve [--http] [--mcp]
 *   router mcp-stdio                          stdio MCP server（Claude Code 用）
 *   router models list | add <file> | remove <id>
 *   router tasks get <task_id>
 *   router delegate <description>             完整 JSON envelope（给人看）
 *   router run [description]                  subprocess 友好（给程序看）
 *   router approve <continuation_token>
 *   router seed-fixtures [--vllm-only]
 *   router smoke                              离线烟雾测试
 *   router enable [--reason <text>]
 *   router disable [--reason <text>]
 *   router status [--json]
 *
 * 退出码：0=success, 1=failed, 2=pending_approval, 3=usage, 4=disabled
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DelegateInputSchema, ModelEntryInputSchema } from "../core/schemas.js";
import { loadConfig } from "../config/loader.js";
import { bootstrap } from "../util/bootstrap.js";
import { serveHttp } from "./http.js";
import { serveMcp, serveMcpStdio } from "./mcp.js";
import { buildSampleModels, buildVllmModelFromEnv } from "../util/fixtures.js";
import { openDatabase } from "../persistence/db.js";
import { TaskStore } from "../persistence/tasks.js";
import { ExecutionStore, PendingApprovalStore } from "../persistence/executions.js";
import { ModelRegistry } from "../registry/store.js";
import { Pipeline } from "../core/pipeline.js";
import { createLogger } from "../logging/logger.js";
import { MockProviderRegistry } from "../util/mockProvider.js";
import { readState, writeState, statePath } from "../util/state.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_PENDING_APPROVAL = 2;
const EXIT_USAGE = 3;
const EXIT_DISABLED = 4;

export function buildCli(): Command {
  const program = new Command()
    .name("router")
    .description("Controllable execution router: pick model, run subtask, validate.")
    .version("0.1.0");

  // ---- serve ----
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
        ctx.logger.info({ port: cfg.server.http_port }, "HTTP listening");
      }
      if (opts.mcp) {
        await serveMcp({ port: cfg.server.mcp_port, bind: cfg.server.bind, ctx });
        ctx.logger.info({ port: cfg.server.mcp_port }, "MCP-over-HTTP listening");
      }
    });

  // ---- mcp-stdio ----
  program
    .command("mcp-stdio")
    .description("Run as a stdio MCP server (Claude Code / native MCP clients).")
    .action(async () => {
      // 关键：stdout 必须只跑 MCP JSON-RPC，所有日志推到 stderr
      const cfg = loadConfig();
      cfg.logging.to_stderr = true;
      cfg.logging.pretty = false;
      const ctx = await bootstrap(cfg);
      const close = await serveMcpStdio(ctx);
      process.on("SIGINT", async () => {
        await close();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await close();
        process.exit(0);
      });
    });

  // ---- models ----
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

  // ---- tasks ----
  program
    .command("tasks")
    .command("get <task_id>")
    .action(async (task_id: string) => {
      const ctx = await bootstrap(loadConfig());
      process.stdout.write(JSON.stringify(ctx.tasks.get(task_id), null, 2) + "\n");
    });

  // ---- delegate ----
  program
    .command("delegate <description>")
    .option("--lang <lang>", "zh|en|auto|mixed")
    .option("--cost-ceiling <usd>", "cost ceiling in USD")
    .option("--caller-id <id>", "caller id", "cli")
    .action(async (description: string, opts: { lang?: string; costCeiling?: string; callerId: string }) => {
      const ctx = await bootstrap(loadConfig());
      const input = DelegateInputSchema.parse({
        description,
        caller_id: opts.callerId,
        constraints: opts.lang ? { language: opts.lang } : {},
        hints: opts.costCeiling ? { cost_ceiling_usd: Number(opts.costCeiling) } : {},
      });
      const result = await ctx.pipeline.runDelegate(input);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  // ---- run ----
  program
    .command("run [description]")
    .description("Run a subtask. text stdout / silent stderr / exit 0/1/2/4.")
    .option("--stdin", "read description from stdin", false)
    .option("--format <fmt>", "text|json", "text")
    .option("--lang <lang>", "zh|en|auto|mixed")
    .option("--cost-ceiling <usd>", "cost ceiling in USD")
    .option("--caller-id <id>", "caller id", "claude-code")
    .option("--idempotency <key>", "idempotency key")
    .option("--verbose", "show stderr logs (default silent)", false)
    .action(async (
      description: string | undefined,
      opts: {
        stdin: boolean; format: string; lang?: string; costCeiling?: string;
        callerId: string; idempotency?: string; verbose: boolean;
      },
    ) => {
      const desc = opts.stdin ? await readAllStdin() : description;
      if (!desc || !desc.trim()) {
        process.stderr.write("ERROR: missing description (pass as arg or use --stdin)\n");
        process.exit(EXIT_USAGE);
      }
      const st = readState();
      if (!st.enabled) {
        process.stderr.write(
          `[router] DISABLED (${st.reason ?? "user request"}). Use 'router enable' to turn back on.\n`,
        );
        process.exit(EXIT_DISABLED);
      }
      const cfg = loadConfig();
      if (!opts.verbose) cfg.logging.level = "error";
      const ctx = await bootstrap(cfg);
      const input = DelegateInputSchema.parse({
        description: desc,
        caller_id: opts.callerId,
        constraints: opts.lang ? { language: opts.lang } : {},
        hints: opts.costCeiling ? { cost_ceiling_usd: Number(opts.costCeiling) } : {},
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
          process.stderr.write(`[router] ${result.error.code}: ${result.error.message}\n`);
      }
      const code = result.status === "executed" ? EXIT_OK
        : result.status === "pending_approval" ? EXIT_PENDING_APPROVAL : EXIT_FAILED;
      if (code === EXIT_PENDING_APPROVAL && opts.format !== "json") {
        process.stdout.write(`\n[continuation_token=${result.continuation_token}]\n`);
      }
      process.exit(code);
    });

  // ---- approve ----
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

  // ---- seed-fixtures ----
  program
    .command("seed-fixtures")
    .description("Insert sample ModelEntry rows. If VLLM_ENDPOINT+VLLM_MODEL_ID set, also seeds your vLLM.")
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
        process.stdout.write(`seeded from env: ${vllm.id}  (endpoint=${vllm.local?.endpoint})\n`);
      } else if (opts.vllmOnly) {
        process.stderr.write("ERROR: --vllm-only set but VLLM_ENDPOINT / VLLM_MODEL_ID env not provided.\n");
        process.exitCode = EXIT_USAGE;
      }
    });

  // ---- smoke ----
  program
    .command("smoke")
    .description("Offline smoke test: in-memory DB + MockProvider.")
    .option("--task <desc>", "task description", "请写一个 quicksort 函数。")
    .action(async (opts: { task: string }) => {
      const logger = createLogger({ level: "info", pretty: true });
      const db = openDatabase({ filepath: ":memory:" });
      const tasks = new TaskStore(db);
      const executions = new ExecutionStore(db);
      const pending = new PendingApprovalStore(db);
      const registry = new ModelRegistry(db);
      for (const m of buildSampleModels()) registry.upsert({ ...m, calibration: undefined });
      const mockText = [
        "// [smoke mock] — pipeline 端到端跑通的伪造回答。",
        "function quicksort(arr) {",
        "  if (arr.length <= 1) return arr.slice();",
        "  const pivot = arr[0]; const left = [], right = [];",
        "  for (let i = 1; i < arr.length; i++) {",
        "    if (arr[i] < pivot) left.push(arr[i]); else right.push(arr[i]);",
        "  }",
        "  return [...quicksort(left), pivot, ...quicksort(right)];",
        "}",
      ].join("\n");
      const providers = new MockProviderRegistry({ text: mockText, tokens_in: 200, tokens_out: 120 });
      const pipeline = new Pipeline({
        registry, tasks, executions, pending, providers,
        claude: undefined,
        logger: logger.child({ component: "smoke" }),
        config: {
          cost_ceiling_usd: 10,
          confidence_gap: 0.0001,
          approval_ttl_hours: 24,
          decay_half_life: 50,
        },
      });
      const result = await pipeline.runDelegate({ description: opts.task, caller_id: "smoke-test" });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (result.status !== "executed") {
        process.stderr.write(`FAIL: status=${result.status}\n`);
        process.exitCode = EXIT_FAILED;
      } else {
        process.stderr.write("OK — pipeline ran end-to-end with mock provider.\n");
      }
    });

  // ---- enable / disable / status ----
  program
    .command("enable")
    .description("Enable the router globally.")
    .option("--reason <text>", "reason", "user request")
    .action((opts: { reason: string }) => {
      const st = writeState(true, opts.reason);
      process.stdout.write(`enabled  (state at ${statePath()})\n`);
      process.stdout.write(JSON.stringify(st, null, 2) + "\n");
    });

  program
    .command("disable")
    .description("Disable the router globally.")
    .option("--reason <text>", "reason", "user request")
    .action((opts: { reason: string }) => {
      const st = writeState(false, opts.reason);
      process.stdout.write(`disabled  (state at ${statePath()})\n`);
      process.stdout.write(JSON.stringify(st, null, 2) + "\n");
    });

  program
    .command("status")
    .description("Print router on/off state.")
    .option("--json", "print as JSON", false)
    .action((opts: { json: boolean }) => {
      const st = readState();
      if (opts.json) {
        process.stdout.write(JSON.stringify(st, null, 2) + "\n");
      } else {
        process.stdout.write(
          `${st.enabled ? "enabled" : "disabled"}  reason=${st.reason ?? "-"}  updated_at=${st.updated_at}\n`,
        );
      }
      process.exit(st.enabled ? EXIT_OK : EXIT_DISABLED);
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
