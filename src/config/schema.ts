/**
 * 服务配置 schema（解析 TOML）+ 默认值合并。
 *
 * 来源优先级：env 覆盖 → toml 文件 → 默认。
 */
import { z } from "zod";

export const ConfigSchema = z.object({
  server: z.object({
    http_port: z.number().int().positive().default(7878),
    mcp_port: z.number().int().positive().default(7879),
    bind: z.string().default("127.0.0.1"),
  }),
  storage: z.object({
    sqlite_path: z.string().default("~/.local/share/router/router.db"),
  }),
  claude: z.object({
    model: z.string().default("claude-sonnet-4-6"),
    auth_ref: z.string().default("claude_api_key"),
    use_heuristic_fallback: z.boolean().default(true),
  }),
  router: z.object({
    cost_ceiling_usd: z.number().positive().default(0.1),
    confidence_gap: z.number().positive().default(0.3),
    approval_ttl_hours: z.number().int().positive().default(24),
  }),
  calibration: z.object({
    decay_half_life: z.number().int().positive().default(50),
    initial_anchor_weight: z.number().min(0).max(1).default(0.3),
  }),
  secrets: z.object({
    backend: z.enum(["auto", "keytar", "env", "file"]).default("auto"),
    service: z.string().default("router"),
    file_path: z.string().optional(),
  }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    pretty: z.boolean().default(false),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});
