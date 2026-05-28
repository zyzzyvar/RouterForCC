/**
 * SecretsStore：通过 auth_ref 取 API key。
 *
 * Ubuntu 上默认走 libsecret（gnome-keyring / kwallet 的统一接口），
 * 通过 keytar 包访问；环境变量与文件方式作为回退。
 *
 * 三种 backend：
 *   - keytar：libsecret 后端（service = "router"）
 *   - env：从 process.env[AUTH_REF.toUpperCase()] 读
 *   - file：从 ~/.config/router/secrets.json 读 { [auth_ref]: value }
 *
 * 默认 backend='auto'：先 env，再 keytar，最后 file。
 * 取到 null/缺失则抛错 —— 由 provider 在调用前感知。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type SecretBackend = "auto" | "keytar" | "env" | "file";

export interface SecretsConfig {
  backend: SecretBackend;
  service?: string; // keytar service name
  file_path?: string; // file backend
}

export class SecretsStore {
  private cache = new Map<string, string>();

  constructor(private cfg: SecretsConfig) {}

  get(auth_ref: string): string {
    const cached = this.cache.get(auth_ref);
    if (cached) return cached;

    const value = this.tryAll(auth_ref);
    if (!value) {
      throw new Error(`Secret not found for auth_ref=${auth_ref} (backend=${this.cfg.backend})`);
    }
    this.cache.set(auth_ref, value);
    return value;
  }

  /** 从 env / file / keytar 顺次尝试 */
  private tryAll(auth_ref: string): string | null {
    const order: SecretBackend[] =
      this.cfg.backend === "auto" ? ["env", "keytar", "file"] : [this.cfg.backend];
    for (const b of order) {
      const v = this.tryOne(b, auth_ref);
      if (v) return v;
    }
    return null;
  }

  private tryOne(backend: SecretBackend, auth_ref: string): string | null {
    if (backend === "env") {
      return process.env[auth_ref.toUpperCase()] ?? null;
    }
    if (backend === "file") {
      const path = this.cfg.file_path ?? join(homedir(), ".config", "router", "secrets.json");
      if (!existsSync(path)) return null;
      try {
        const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
        return obj[auth_ref] ?? null;
      } catch {
        return null;
      }
    }
    if (backend === "keytar") {
      return tryKeytarSync(this.cfg.service ?? "router", auth_ref);
    }
    return null;
  }
}

/**
 * keytar 是异步 API；为了让 SecretsStore.get() 保持同步，
 * 我们在启动时一次性把命名条目预加载，运行期只读 cache。
 *
 * preloadKeytar() 由 bootstrap 显式调用；如果没调，keytar lane 会一直返回 null。
 */
let keytarCache: Map<string, string> | null = null;

export async function preloadKeytar(service: string, refs: readonly string[]): Promise<void> {
  let keytar: typeof import("keytar");
  try {
    keytar = await import("keytar");
  } catch {
    // keytar 不可用（缺 libsecret），静默跳过
    keytarCache = new Map();
    return;
  }
  keytarCache = new Map();
  for (const ref of refs) {
    const v = await keytar.getPassword(service, ref).catch(() => null);
    if (v) keytarCache.set(ref, v);
  }
}

function tryKeytarSync(_service: string, auth_ref: string): string | null {
  if (!keytarCache) return null;
  return keytarCache.get(auth_ref) ?? null;
}
