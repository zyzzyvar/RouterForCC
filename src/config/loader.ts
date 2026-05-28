/**
 * 加载 TOML 配置；尝试顺序：
 *   1. 命令行 --config <path>
 *   2. 环境变量 ROUTER_CONFIG
 *   3. ./config/default.toml
 *   4. 内置默认
 *
 * 解析后用 zod 校验；缺字段走 schema 默认。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ConfigSchema, type Config } from "./schema.js";

export interface LoadOptions {
  override_path?: string;
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const candidates = [opts.override_path, process.env.ROUTER_CONFIG, "config/default.toml"].filter(
    Boolean,
  ) as string[];

  for (const p of candidates) {
    const abs = resolve(p);
    if (existsSync(abs)) {
      const raw = readFileSync(abs, "utf8");
      const parsed = parseToml(raw) as unknown;
      return ConfigSchema.parse(parsed);
    }
  }
  return ConfigSchema.parse({});
}
