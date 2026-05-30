/**
 * MCP adapter.
 *
 * 同一个 buildMcpServer 注册 5 个工具，两种 transport 共用：
 *   - serveMcp      → StreamableHTTPServerTransport
 *   - serveMcpStdio → StdioServerTransport（Claude Code 走这条）
 *
 * - 工具调用前查 enable/disable
 * - delegate_subtask 在 client 支持 sampling 时让 analyzer 反向走 client 的 Claude
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
import { McpSamplingAnalyzerClient, type ClaudeClient } from "../claude/client.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJSONSchema = Record<string, any>;

interface ToolSessionCtx {
  server: Server;
  client_supports_sampling: boolean;
  app: AppContext;
}

interface ToolDef<I> {
  name: string;
  description: string;
  inputSchema: AnyJSONSchema;
  parser: z.ZodType<I>;
  handler: (input: I, session: ToolSessionCtx) => Promise<unknown>;
}

function buildTools(): Array<ToolDef<unknown>> {
  return [
    {
      name: "delegate_subtask",
      description:
        "Delegate a subtask to the routed LLM. The router analyzes the task, picks the best model, executes, and validates. Returns chosen model, rationale, and result text.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Task description for the LLM" },
          constraints: {
            type: "object",
            properties: {
              language: { type: "string", enum: ["zh", "en", "auto", "mixed"] },
              output_format: { type: "string", enum: ["text", "markdown", "json", "code"] },
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
      handler: async (input, session) => {
        let analyzerLlm: ClaudeClient | undefined;
        if (session.client_supports_sampling) {
          analyzerLlm = new McpSamplingAnalyzerClient(session.server);
        }
        return session.app.pipeline.runDelegate(
          input as never,
          analyzerLlm ? { analyzerLlm } : undefined,
        );
      },
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
      handler: async (input, session) =>
        session.app.pipeline.confirmAndExecute(
          (input as { continuation_token: string }).continuation_token,
        ),
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
      handler: async (input, session) =>
        session.app.tasks.get((input as { task_id: string }).task_id),
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
      handler: async (input, session) =>
        session.app.registry.list({
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
      handler: async (input, session) => {
        const i = input as { record_id: string; feedback: z.infer<typeof UserFeedbackSchema> };
        return session.app.pipeline.submitFeedback(i.record_id, i.feedback);
      },
    },
  ];
}

const SERVER_INSTRUCTIONS = `Router MCP server.

This server delegates subtasks to whichever LLM the router judges best. Default
to calling delegate_subtask for tasks and let the router decide.

Response semantics for delegate_subtask:

- status: "executed" — Use result as output. Optionally surface
  proposal.chosen_model_id and a short proposal.rationale.

- status: "pending_approval" — Router thinks this needs a second look. Common
  reasons: high_risk_task, cost_over_threshold, low_confidence_decision. Show
  user proposal.rationale + approval_reasons, then call confirm_subtask with
  continuation_token to proceed, or drop the task.

- status: "failed" — Router or model failed. Read error.message; retry with
  refined constraints or do the work yourself.

- Tool response isError: true with "Router is disabled" — Do the task yourself;
  do not retry.

Avoid second-guessing the router based on surface features like task length or
language. Tune behavior via hints (cost_ceiling_usd / preferred_models /
excluded_models / sensitivity_level / risk_level).

When NOT to call delegate_subtask: when you're mid-conversation with established
context that would be expensive to re-transmit through the tool boundary.

Other tools: confirm_subtask, get_task, list_models, submit_feedback.`;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caps = (server as any).getClientCapabilities?.();
      const client_supports_sampling = !!caps && caps.sampling !== undefined;
      const session: ToolSessionCtx = {
        server,
        client_supports_sampling,
        app: ctx,
      };
      const args = tool.parser.parse(req.params.arguments ?? {});
      const result = await tool.handler(args, session);
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

export async function serveMcpStdio(ctx: AppContext): Promise<() => Promise<void>> {
  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return async () => {
    await server.close();
  };
}
