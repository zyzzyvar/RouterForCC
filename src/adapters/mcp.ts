/**
 * MCP adapter：暴露 5 个 tool，便于 Hermes / Claude Code 之类的 client 调用。
 *
 * 工具集合：
 *   - delegate_subtask
 *   - confirm_subtask
 *   - get_task
 *   - list_models
 *   - submit_feedback
 *
 * 传输形态：MCP-over-HTTP（不是 stdio）—— 在固定端口监听，方便共享后端。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  DelegateInputSchema,
  UserFeedbackSchema,
} from "../core/schemas.js";
import type { AppContext } from "../util/bootstrap.js";
import { createServer } from "node:http";

export interface ServeMcpOptions {
  port: number;
  bind: string;
  ctx: AppContext;
}

const ConfirmInputSchema = z.object({ continuation_token: z.string() });
const GetTaskInputSchema = z.object({ task_id: z.string() });
const ListModelsInputSchema = z.object({
  status: z.enum(["active", "deprecated", "experimental"]).optional(),
});
const FeedbackInputSchema = z.object({
  record_id: z.string(),
  feedback: UserFeedbackSchema,
});

/**
 * 构造一个 MCP server 实例，并注册全部 tool。
 */
export function buildMcpServer(ctx: AppContext): Server {
  const server = new Server(
    { name: "router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTool(server, {
    name: "delegate_subtask",
    description: "把一个子任务交给路由器：分析→选模型→执行→校验。",
    inputSchema: DelegateInputSchema,
    handler: async (input) => ctx.pipeline.runDelegate(input),
  });

  registerTool(server, {
    name: "confirm_subtask",
    description: "对挂起态任务给出批准后继续执行。",
    inputSchema: ConfirmInputSchema,
    handler: async ({ continuation_token }) =>
      ctx.pipeline.confirmAndExecute(continuation_token),
  });

  registerTool(server, {
    name: "get_task",
    description: "查询任务当前状态。",
    inputSchema: GetTaskInputSchema,
    handler: async ({ task_id }) => ctx.tasks.get(task_id),
  });

  registerTool(server, {
    name: "list_models",
    description: "列出注册的模型（默认仅 active）。",
    inputSchema: ListModelsInputSchema,
    handler: async ({ status }) => ctx.registry.list({ status }),
  });

  registerTool(server, {
    name: "submit_feedback",
    description: "为一条执行记录提交用户反馈，触发校准。",
    inputSchema: FeedbackInputSchema,
    handler: async ({ record_id, feedback }) =>
      ctx.pipeline.submitFeedback(record_id, feedback),
  });

  return server;
}

export async function serveMcp(opts: ServeMcpOptions): Promise<() => Promise<void>> {
  const server = buildMcpServer(opts.ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const http = createServer((req, res) => {
    transport.handleRequest(req, res).catch((e) => {
      opts.ctx.logger.error({ err: (e as Error).message }, "mcp transport error");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });
  http.listen(opts.port, opts.bind);

  return async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await server.close();
  };
}

// ----------------------------------------------------------------
// 工具注册（薄包装，吸收 SDK 不同版本的 setRequestHandler 形态差异）
// ----------------------------------------------------------------

interface ToolDef<T extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: T;
  handler: (input: z.infer<T>) => Promise<unknown>;
}

const TOOL_REGISTRY = new WeakMap<Server, Array<ToolDef<z.ZodTypeAny>>>();

function registerTool<T extends z.ZodTypeAny>(server: Server, def: ToolDef<T>): void {
  const list = TOOL_REGISTRY.get(server) ?? [];
  list.push(def as unknown as ToolDef<z.ZodTypeAny>);
  TOOL_REGISTRY.set(server, list);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).setRequestHandler({ method: "tools/list" }, async () => ({
    tools: (TOOL_REGISTRY.get(server) ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", additionalProperties: true },
    })),
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).setRequestHandler(
    { method: "tools/call" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (req: any) => {
      const tools = TOOL_REGISTRY.get(server) ?? [];
      const tool = tools.find((t) => t.name === req.params?.name);
      if (!tool) throw new Error(`Unknown tool: ${req.params?.name}`);
      const args = tool.inputSchema.parse(req.params?.arguments ?? {});
      const result = await tool.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
