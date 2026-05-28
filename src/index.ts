/**
 * 包入口 + CLI 启动器。
 *
 * 用法：
 *   $ router serve --http --mcp
 *   $ router models list
 *   $ router seed-fixtures
 *
 * 包内默认导出 buildCli，方便嵌入式使用。
 */
import { buildCli } from "./adapters/cli.js";

export { buildCli } from "./adapters/cli.js";
export { bootstrap } from "./util/bootstrap.js";
export { loadConfig } from "./config/loader.js";
export { Pipeline } from "./core/pipeline.js";
export type { AppContext } from "./util/bootstrap.js";

// 直接执行时跑 CLI
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("router/dist/index.js") ?? false);
if (isMain) {
  buildCli().parseAsync(process.argv).catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
