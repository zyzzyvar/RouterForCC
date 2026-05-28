/**
 * 服务配置 schema（解析 TOML）+ 默认值合并。
 *
 * 来源优先级：env 覆盖 → toml 文件 → 默认。
 *
 * 每个顶层 section 都加了 .default({})，让 ConfigSchema.parse({}) 能
 * 一路下沉到子字段的 .default(...)，得到一个完整的 Config。
 */
import { z } from "zod";

export const ConfigSchema = z
  .object({
    server: z
      .object({
        http_port: z.number().int().positive().default(7878),
        mcp_port: z.number().int().positive().default(7879),
        bind: z.string().default("127.0.0.1"),
      })
      .default({}),
    storage: z
      .object({
        sqlite_path: z.string().default("~/.local/share/router/router.db"),
      })
      .default({}),
    claude: z
      .object({
        model: z.string().default("claude-sonnet-4-6"),
        auth_ref: z.string().default("claude_api_key"),
        use_heuristic_fallback: z.boolean().default(true),
      })
      .default({}),
    router: z
      .object({
        cost_ceiling_usd: z.number().positive().default(0.1),
        confidence_gap: z.number().positive().default(0.3),
        approval_ttl_hours: z.number().int().positive().default(24),
      })
      .default({}),
    calibration: z
      .object({
        decay_half_life: z.number().int().positive().default(50),
        initial_anchor_weight: z.number().min(0).max(1).default(0.3),
      })
      .default({}),
    secrets: z
      .object({
        backend: z.enum(["auto", "keytar", "env", "file"]).default("auto"),
        service: z.string().default("router"),
        file_path: z.string().optional(),
      })
      .default({}),
    logging: z
      .object({
        level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
        pretty: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});
