# Getting started — 把 router 当成 Claude Code 的"LLM 分发员"

## 你想要的形态

```
Claude Code（主驱动）
   │
   │  Bash 工具调用 `router run "请用中文翻译..."`
   ▼
router run                  ← 这个 CLI，本仓库构建
   │  analyze → 选模型 → 调用
   ▼
你的 vLLM / DeepSeek / Ollama / ...
   │  返回模型回答
   ▼
stdout → Claude Code 拿到结果，继续推进
```

不需要 Anthropic API key；不需要常驻服务；Claude Code 就把它当成一个普通命令调用即可。

## 前置

- Ubuntu，Node ≥ 20
- 一台 vLLM（或其它 OpenAI 兼容 endpoint）

## 第 1 步：安装

```bash
cd router
npm install
# 失败时：sudo apt install -y build-essential python3 && npm rebuild better-sqlite3
```

## 第 2 步：离线烟雾测试（不需要任何 LLM）

```bash
npx tsx src/index.ts smoke
```

`OK — pipeline ran end-to-end with mock provider.` 出现就说明安装、DB、流水线都正常。

## 第 3 步：注册你的 vLLM（并让它兼任 analyzer）

```bash
export VLLM_ENDPOINT=http://localhost:8000/v1
export VLLM_MODEL_ID=Qwen2.5-72B-Instruct          # 与 vLLM --served-model-name 一致

# 关键：让 analyzer 也走这台 vLLM（不再依赖 Claude）
export ANALYZER_VLLM_ENDPOINT=$VLLM_ENDPOINT
export ANALYZER_VLLM_MODEL_ID=$VLLM_MODEL_ID

npx tsx src/index.ts seed-fixtures --vllm-only
```

## 第 4 步：人手跑一次，确认能拿到模型输出

```bash
npx tsx src/index.ts run "请写一个 quicksort 函数。" --lang zh
# stdout 直接是 vLLM 返回的代码；exit 0 表示成功
```

如果想看完整决策细节（chosen_model、rationale、calibration 等）：

```bash
npx tsx src/index.ts run "..." --format json
```

## 第 5 步：把它接到 Claude Code

### 方式 A：当 shell 命令直接调（最简单）

把 `router` 装到 PATH 上：

```bash
cd RouterForCC
chmod +x bin/router
sudo ln -sf "$PWD/bin/router" /usr/local/bin/router

# 验证
router run "请翻译: hello world" --lang zh
```

`bin/router` 是个 shell wrapper，会自动定位项目目录、用 `tsx` 跑 `src/index.ts`，**不需要 `npm run build`**。改了源码立即生效。如果有 `dist/index.js` 且比源码新，会优先用 `node` 跑（冷启动更快）。

然后在 Claude Code 会话里随时：

```
请翻译这段：xxxxx
（Claude Code 决定该不该外包；如果该外包，它会自己跑 Bash:
   $ router run "翻译: xxxxx" --lang zh
 然后把 stdout 当结果用）
```

为了让 Claude Code **自觉地**把任务外包给 `router`，在你的项目根目录或 `~/.claude/CLAUDE.md` 加一段提示：

```markdown
## Router CLI

This workspace has a local LLM router at `router` on PATH. Use it for:

- Long-form Chinese writing or translation
- Bulk structured extraction
- Anything that doesn't require your own reasoning

Invoke it as:
  router run "<task description>" [--lang zh] [--cost-ceiling 0.05]

stdout is the model output. Exit code 0 = success, 1 = failed, 2 = needs human approval.
For approval flow: `router approve <token>` to continue.
Use `--format json` if you need the full envelope (rationale, chosen model, etc).
```

Claude Code 看到这个 CLAUDE.md 后会自己学会什么时候调用。

### 方式 B：作为 stdio MCP server（**推荐**，Claude Code 原生支持）

不需要常驻服务，Claude Code 自己 spawn 一个 `router mcp-stdio` 子进程跑 MCP 协议。

**走 MCP 时不用动 CLAUDE.md** —— router 在 `initialize` 时通过 MCP 协议的 `instructions` 字段把"何时调用、如何读响应"的契约直接推给 Claude Code，Claude 会自动把它当作系统上下文。策略（什么时候外包、什么时候本地做）住在 router 的 analyzer + decider + 权重表里，不在提示词里。

```bash
# 一行注册（前提：router 已 link 到 PATH）
claude mcp add router router mcp-stdio

# 看一下是否注册成功
claude mcp list
```

或者手动编辑 `~/.claude.json` / `~/.config/claude/settings.json`：

```json
{
  "mcpServers": {
    "router": {
      "command": "router",
      "args": ["mcp-stdio"]
    }
  }
}
```

下次启动 Claude Code，5 个工具会自动出现：
- `delegate_subtask` — 主用，把任务外包给路由器
- `confirm_subtask` — 批准挂起态任务
- `get_task` — 查任务状态
- `list_models` — 列出可用模型
- `submit_feedback` — 提交反馈触发校准

Claude Code 的 `/mcp` 命令里能看到这个 server，可以直接 enable/disable 整个 server。**而 `router disable` 命令是更细粒度的 kill-switch**：MCP server 仍然注册着，但所有工具调用立即返回 `isError: true`（提示用户跑 `router enable`），Claude Code 看到 isError 会自动回退到自己做。两层开关组合使用。

### 方式 C：HTTP MCP（多个客户端共享同一个 router 进程）

```bash
router serve --mcp        # 默认 127.0.0.1:7879
```

```json
{ "mcpServers": { "router": { "url": "http://127.0.0.1:7879" } } }
```

适合多个工具/agent 同时调用一个 router 实例的场景。

### 选哪个？

| 用法 | 推荐 |
|---|---|
| 单人 / 单个 Claude Code 实例 | **方式 B（stdio）** —— 零配置，open/close 干净 |
| 多个 agent 共享 | 方式 C（HTTP） |
| 不喜欢 MCP 想保持简单 | 方式 A（shell 命令 + CLAUDE.md） |

## `router run` CLI 速查

| 参数 | 默认 | 说明 |
|------|------|------|
| `<description>` 或 `--stdin` | — | 任务描述 |
| `--format text\|json` | `text` | text=只输出模型回答；json=完整 envelope |
| `--lang zh\|en\|auto\|mixed` | — | 输出语言提示 |
| `--cost-ceiling <usd>` | config | 超过则要求审批 |
| `--caller-id <id>` | `claude-code` | 记录到执行记录里 |
| `--idempotency <key>` | — | 相同 key 不会重复执行 |
| `--verbose` | off | stderr 出日志（默认静默，避免污染 subprocess stdout） |

退出码：

- `0` executed —— `result` 已写入 stdout
- `1` failed —— stderr 有错误信息
- `2` pending_approval —— stdout 末尾会带 `[continuation_token=...]`；用 `router approve` 继续
- `3` usage error

## 三种 analyzer 模式

| 设了什么 | analyzer 用什么 | 准确度 |
|---|---|---|
| `ANALYZER_VLLM_ENDPOINT + ANALYZER_VLLM_MODEL_ID` | 本机/任意 OpenAI 兼容 LLM | 高 ✅ |
| `ANTHROPIC_API_KEY`（不设上面） | 官方 Claude | 高，但需 key + 网络 |
| 都没设 | 启发式（关键词 + 字符数 + CJK 比例） | 中等，但够用 |

## 常见坑

- **vLLM 报 model not found**：`VLLM_MODEL_ID` 必须等于 vLLM 启动时的 `--served-model-name`。
- **Claude Code 不知道该用 router**：在 CLAUDE.md 里写明上文那段提示。
- **subprocess 看到 stderr 噪音**：默认就静默；除非加了 `--verbose`。
- **多次同样的请求重复跑了**：用 `--idempotency <key>`。
