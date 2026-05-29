/**
 * MCP adapter.
 *
 * 同一个 buildMcpServer 注册 5 个工具，两种 transport 共用：
 *   - serveMcp      → StreamableHTTPServerTransport（HTTP-based MCP）
 *   - serveMcpStdio → StdioServerTransport（Claude Code 原生集成走这条）
 *
 * 工具集合：
 *   - delegate_subtask    把任务交给路由器选模型 → 执行 → 校验
 *   - confirm_subtask     批准挂起态任务继续执行
 *   - get_task            查询任务状态
 *   - list_models         列出注册模型
 *   - submit_feedback     提交反馈，触发校准
 *
 * 关键点：
 *   - 所有工具调用都先查 enable/disable 开关；disabled 时返回 isError 并提示用户
 *   - stdio 模式时 logger 写 stderr，避免污染 MCP JSON-RPC 协议
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DelegateInputSchema, UserFeedbackSchema } from "../core/schemas.js";
import type { AppContext } from "../util/bootstrap.js";
import { createServer } from "node:http";
import { readState } from "../util/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJSONSchema = Record<string, any>;

interface ToolDef<I> {
  name: string;
  description: string;
  inputSchema: AnyJSONSchema;
  parser: z.ZodType<I>;
  handler: (input: I, ctx: AppContext) => Promise<unknown>;
}

function buildTools(): Array<ToolDef<unknown>> {
  return [
    {
      name: "delegate_subtask",
      description:
        "Delegate a subtask to the routed LLM (usually a local vLLM). Use this for: long Chinese writing/translation, boilerplate code, summaries, or mechanical tasks that don't need your own reasoning. The router analyzes the task, picks the best model, executes, and validates the output. Returns chosen model id, rationale, and the model's result text.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Task description for the LLM" },
          constraints: {
            type: "object",
            properties: {
              language: { type: "string", enum: ["zh", "en", "auto", "mixed"] },
              output_format: {
                type: "string",
                enum: ["text", "markdown", "json", "code"],
              },
              must_include: { type: "array", items: { type: "string" } },
              must_avoid: { type: "array", items: { type: "string" } },
            },
          },
          hints: {
            type: "object",
            properties: {
              cost_ceiling_usd: { type: "number" },
              preferred_models: { type: "array", items: { type: "string" } },
              excluded_models: { type: "array", items: { type: "string" } },
            },
          },
          caller_id: { type: "string", default: "mcp" },
          idempotency_key: { type: "string" },
        },
        required: ["description"],
      },
      parser: DelegateInputSchema,
      handler: async (input, ctx) => ctx.pipeline.runDelegate(input as never),
    } as ToolDef<unknown>,
    {
      name: "confirm_subtask",
      description: "Resume a pending-approval task by its continuation_token.",
      inputSchema: {
        type: "object",
        properties: { continuation_token: { type: "string" } },
        required: ["continuation_token"],
      },
      parser: z.object({ continuation_token: z.string() }),
      handler: async (input, ctx) =>
        ctx.pipeline.confirmAndExecute((input as { continuation_token: string }).continuation_token),
    },
    {
      name: "get_task",
      description: "Get the current state of a task by task_id.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
      parser: z.object({ task_id: z.string() }),
      handler: async (input, ctx) => ctx.tasks.get((input as { task_id: string }).task_id),
    },
    {
      name: "list_models",
      description: "List registered models (default: active only).",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "deprecated", "experimental"] },
        },
      },
      parser: z.object({
        status: z.enum(["active", "deprecated", "experimental"]).optional(),
      }),
      handler: async (input, ctx) =>
        ctx.registry.list({
          status: (input as { status?: "active" | "deprecated" | "experimental" }).status,
        }),
    },
    {
      name: "submit_feedback",
      description: "Submit user feedback on an execution record; triggers calibration.",
      inputSchema: {
        type: "object",
        properties: {
          record_id: { type: "string" },
          feedback: {
            type: "object",
            properties: {
              override: { type: "boolean" },
              rating: { type: "integer", minimum: 1, maximum: 5 },
              comment: { type: "string" },
            },
            required: ["override"],
          },
        },
        required: ["record_id", "feedback"],
      },
      parser: z.object({ record_id: z.string(), feedback: UserFeedbackSchema }),
      handler: async (input, ctx) => {
        const i = input as { record_id: string; feedback: z.infer<typeof UserFeedbackSchema> };
        return ctx.pipeline.submitFeedback(i.record_id, i.feedback);
      },
    },
  ];
}

/**
 * 给 client LLM 看的"使用手册"。
 * MCP initialize 响应里以 instructions 字段送给客户端 —— Claude Code 会把它
 * 当作可用工具的系统上下文，所以你不需要再在 CLAUDE.md 里写一遍。
 *
 * 原则：不要硬编码"什么场景该外包"——那是 router 内部 analyzer/decider 的事。
 * 这里只解释响应契约，让 client 知道怎么读返回值。
 */
const SERVER_INSTRUCTIONS = `Router MCP server.

This server delegates subtasks to whichever LLM the router judges best. It has
its own analyzer, capability-scoring, and approval logic — so as a client,
default to calling \`delegate_subtask\` for tasks and let the router decide.

Response semantics for \`delegate_subtask\`:

- \`status: "executed"\` — Use \`result\` as the subtask's output. Optionally
  surface \`proposal.chosen_model_id\` and a short version of
  \`proposal.rationale\` so the user can see who did it.

- \`status: "pending_approval"\` — The router thinks this needs a second look.
  Common reasons: \`high_risk_task\`, \`cost_over_threshold\`,
  \`low_confidence_decision\`. Show the user \`proposal.rationale\` +
  \`approval_reasons\`, then either call \`confirm_subtask\` with
  \`continuation_token\` to proceed, or drop the task.

- \`status: "failed"\` — Router or model failed. Read \`error.message\`; either
  retry with refined constraints (e.g. tighter \`cost_ceiling_usd\`,
  \`excluded_models\`) or do the work yourself.

- Tool response \`isError: true\` with text "Router is disabled" — the user
  globally turned off router. Do the task yourself; do not retry.

Avoid second-guessing the router based on surface features like task length or
language. Its analyzer already sees those. The places to tune behavior are:
- \`hints.cost_ceiling_usd\` — lower it to force approval gate on expensive routes
- \`hints.preferred_models\` / \`excluded_models\` — soft / hard model preference
- \`hints.sensitivity_level\` / \`hints.risk_level\` — explicit override of analyzer

When NOT to call delegate_subtask: when you're in the middle of a conversation
and re-transmitting the context through the tool boundary would lose more than
the routing saves.

Other tools:
- \`confirm_subtask\` — resume a pending-approval task
- \`get_task\` — inspect a task by id
- \`list_models\` — show registered models
- \`submit_feedback\` — log user satisfaction; triggers calibration`;

export function buildMcpServer(ctx: AppContext): Server {
  const server = new Server(
    { name: "router", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  const tools = buildTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // 全局开关：disabled 时所有 tool 调用直接返回 isError，让 caller 自己 fallback
    const state = readState();
    if (!state.enabled) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Router is disabled (${state.reason ?? "user request"}). Run 'router enable' to turn back on.`,
          },
        ],
        isError: true,
      };
    }

    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const args = tool.parser.parse(req.params.arguments ?? {});
      const result = await tool.handler(args, ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ----------------------------------------------------------------
// HTTP transport
// ----------------------------------------------------------------
export interface ServeMcpHttpOptions {
  port: number;
  bind: string;
  ctx: AppContext;
}

export async function serveMcp(opts: ServeMcpHttpOptions): Promise<() => Promise<void>> {
  const server = buildMcpServer(opts.ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const http = createServer((req, res) => {
    transport.handleRequest(req, res).catch((e) => {
      opts.ctx.logger.error({ err: (e as Error).message }, "mcp http transport error");
    });
  });
  http.listen(opts.port, opts.bind);

  return async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await server.close();
  };
}

// ----------------------------------------------------------------
// Stdio transport（给 Claude Code 这类原生 MCP client 用）
// ----------------------------------------------------------------
export async function serveMcpStdio(ctx: AppContext): Promise<() => Promise<void>> {
  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return async () => {
    await server.close();
  };
}
