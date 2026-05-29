/**
 * 统一日志接口。用 pino —— 结构化 JSON，性能好，支持 child logger。
 *
 * to_stderr=true 时把日志写到 fd=2，避免污染 stdio MCP 协议的 stdout。
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
  pretty?: boolean;
  to_stderr?: boolean;
}

export function createLogger(cfg: LoggerConfig): Logger {
  const opts: LoggerOptions = { level: cfg.level };
  if (cfg.pretty) {
    opts.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        destination: cfg.to_stderr ? 2 : 1,
      },
    };
    return wrap(pino(opts));
  }
  const dest = pino.destination(cfg.to_stderr ? 2 : 1);
  return wrap(pino(opts, dest));
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
