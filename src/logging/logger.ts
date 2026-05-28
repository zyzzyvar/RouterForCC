/**
 * 统一日志接口。用 pino —— 结构化 JSON，性能好，支持 child logger。
 *
 * Logger interface 是 pino 的子集，方便后续替换 / mock。
 */
import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";

export interface Logger {
  trace(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerConfig {
  level: "trace" | "debug" | "info" | "warn" | "error";
  pretty?: boolean; // 终端友好（仅开发用）
}

export function createLogger(cfg: LoggerConfig): Logger {
  const opts: LoggerOptions = { level: cfg.level };
  if (cfg.pretty) {
    opts.transport = {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l" },
    };
  }
  return wrap(pino(opts));
}

function wrap(p: PinoLogger): Logger {
  return {
    trace: (o, m) => p.trace(o as object, m),
    debug: (o, m) => p.debug(o as object, m),
    info: (o, m) => p.info(o as object, m),
    warn: (o, m) => p.warn(o as object, m),
    error: (o, m) => p.error(o as object, m),
    child: (b) => wrap(p.child(b)),
  };
}

/** 测试/适配器 fallback：把日志吞掉 */
export const NULL_LOGGER: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NULL_LOGGER,
};
