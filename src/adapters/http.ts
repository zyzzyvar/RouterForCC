/**
 * HTTP adapter：用 Hono 暴露 REST 接口。
 *
 * 端点：
 *   POST /v1/delegate           → Pipeline.runDelegate
 *   POST /v1/delegate/confirm   → Pipeline.confirmAndExecute
 *   POST /v1/feedback/:record_id → Pipeline.submitFeedback
 *   GET  /v1/models             → registry.list / get
 *   POST /v1/models             → registry.upsert
 *   GET  /v1/tasks/:task_id
 *   GET  /v1/healthz
 *
 * 全部 JSON。错误统一 { error: { code, message } }。
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { DelegateInputSchema, UserFeedbackSchema, ModelEntryInputSchema } from "../core/schemas.js";
import type { AppContext } from "../util/bootstrap.js";

export function buildHttpApp(ctx: AppContext) {
  const app = new Hono();

  app.get("/v1/healthz", (c) => c.json({ ok: true }));

  app.post("/v1/delegate", async (c) => {
    try {
      const body = DelegateInputSchema.parse(await c.req.json());
      const result = await ctx.pipeline.runDelegate(body);
      return c.json(result);
    } catch (e) {
      return errorResponse(c, "delegate_failed", e);
    }
  });

  const ConfirmSchema = z.object({ continuation_token: z.string() });
  app.post("/v1/delegate/confirm", async (c) => {
    try {
      const { continuation_token } = ConfirmSchema.parse(await c.req.json());
      const result = await ctx.pipeline.confirmAndExecute(continuation_token);
      return c.json(result);
    } catch (e) {
      return errorResponse(c, "confirm_failed", e);
    }
  });

  app.post("/v1/feedback/:record_id", async (c) => {
    try {
      const body = UserFeedbackSchema.parse(await c.req.json());
      const rec = ctx.pipeline.submitFeedback(c.req.param("record_id"), body);
      return c.json(rec);
    } catch (e) {
      return errorResponse(c, "feedback_failed", e);
    }
  });

  app.get("/v1/models", (c) => {
    const status = c.req.query("status");
    const list = ctx.registry.list({
      status: status === "active" || status === "deprecated" || status === "experimental" ? status : undefined,
    });
    return c.json(list);
  });
  app.get("/v1/models/:id", (c) => {
    const m = ctx.registry.tryGet(c.req.param("id"));
    if (!m) return c.json({ error: { code: "not_found", message: "model not found" } }, 404);
    return c.json(m);
  });
  app.post("/v1/models", async (c) => {
    try {
      const body = ModelEntryInputSchema.parse(await c.req.json());
      const entry = ctx.registry.upsert(body);
      return c.json(entry);
    } catch (e) {
      return errorResponse(c, "registry_failed", e);
    }
  });

  app.get("/v1/tasks/:task_id", (c) => {
    const t = ctx.tasks.tryGet(c.req.param("task_id"));
    if (!t) return c.json({ error: { code: "not_found", message: "task not found" } }, 404);
    return c.json(t);
  });

  return app;
}

export interface ServeHttpOptions {
  port: number;
  bind: string;
  ctx: AppContext;
}

export function serveHttp(opts: ServeHttpOptions) {
  const app = buildHttpApp(opts.ctx);
  return serve({ fetch: app.fetch, port: opts.port, hostname: opts.bind });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorResponse(c: any, code: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return c.json({ error: { code, message: msg } }, 400);
}
