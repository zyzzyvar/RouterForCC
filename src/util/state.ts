/**
 * 全局 enable/disable 开关状态。
 *
 * 设计：
 *   - 状态存到 ~/.config/router/state.toml （单一字段 enabled = true/false）
 *   - 默认是 enabled（首次启动无文件 = enabled）
 *   - env 优先级：ROUTER_DISABLED=1 强制 off；ROUTER_ENABLED=1 强制 on
 *
 * 这样 Claude Code 可以：
 *   - 每次 session 开始前查 `router status`
 *   - 看到 `disabled` 就不调 router，自己干
 *   - 用户用 `router disable` 一行命令关闭整个体系，不重启 Claude Code 也生效
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";

const STATE_PATH = join(homedir(), ".config", "router", "state.toml");

export interface RouterState {
  enabled: boolean;
  updated_at: string;
  reason?: string;
}

export function readState(): RouterState {
  // env override 最高优先级
  if (process.env.ROUTER_DISABLED === "1") {
    return { enabled: false, updated_at: new Date().toISOString(), reason: "env:ROUTER_DISABLED=1" };
  }
  if (process.env.ROUTER_ENABLED === "1") {
    return { enabled: true, updated_at: new Date().toISOString(), reason: "env:ROUTER_ENABLED=1" };
  }
  if (!existsSync(STATE_PATH)) {
    return { enabled: true, updated_at: new Date(0).toISOString(), reason: "default" };
  }
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = parseToml(raw) as { enabled?: boolean; updated_at?: string; reason?: string };
    return {
      enabled: parsed.enabled !== false,
      updated_at: parsed.updated_at ?? new Date().toISOString(),
      reason: parsed.reason,
    };
  } catch {
    return { enabled: true, updated_at: new Date().toISOString(), reason: "default (parse failed)" };
  }
}

export function writeState(enabled: boolean, reason?: string): RouterState {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state: RouterState = {
    enabled,
    updated_at: new Date().toISOString(),
    reason,
  };
  // 简单 TOML 序列化（避免引入额外依赖）
  const lines: string[] = [
    `enabled = ${state.enabled}`,
    `updated_at = "${state.updated_at}"`,
  ];
  if (state.reason) lines.push(`reason = "${state.reason.replace(/"/g, '\\"')}"`);
  writeFileSync(STATE_PATH, lines.join("\n") + "\n");
  return state;
}

export function statePath(): string {
  return STATE_PATH;
}
