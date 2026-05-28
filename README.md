# RouterForCC

把任务分配给最合适的 LLM。一个统一的 CLI 入口，给 Claude Code 之类的 agent 当
"LLM 分发员"用：你告诉它"做这个"，它自己决定该调哪个模型。

```
Claude Code ─── `router run "..."` ─── 你的 vLLM / DeepSeek / Ollama / ...
```

## 快速开始

完整的 5 步上手见 [GETTING_STARTED.md](./GETTING_STARTED.md)。

```bash
npm install
npx tsx src/index.ts smoke               # 离线烟雾测试
export VLLM_ENDPOINT=http://localhost:8000/v1
export VLLM_MODEL_ID=Qwen2.5-72B-Instruct
export ANALYZER_VLLM_ENDPOINT=$VLLM_ENDPOINT
export ANALYZER_VLLM_MODEL_ID=$VLLM_MODEL_ID
npx tsx src/index.ts seed-fixtures --vllm-only
npx tsx src/index.ts run "请写一个 quicksort 函数。" --lang zh
```

## 工作流程

```
DelegateInput
    │
    ▼
①  Analyzer       —— 推断 task_type / 语言 / 风险 / token 估算（用你的 LLM 或启发式）
    │
    ▼
②  HardFilter     —— 按模态、context、合规、avoid_patterns 剔除不能用的模型
    │
    ▼
③  Scorer         —— 任务类型 × 能力维度权重 + 成本归一化 + preferred bonus
    │
    ▼
④  Decider        —— 产出 Proposal（chosen + alternates + rationale + decision_trace）
    │                 必要时返回 pending_approval + continuation_token
    ▼
⑤  Executor       —— 调用选中模型（OpenAI 兼容或 Ollama），带重试
    │
    ▼
⑥  Validator     —— rules / schema / llm_judge
    │
    ▼
⑦  Calibrator    —— 半衰 EMA 更新 ModelEntry.calibration
    │
    ▼
DelegateResult
```

## 三种 analyzer 模式

| 设了什么 | analyzer 用什么 |
|---|---|
| `ANALYZER_VLLM_ENDPOINT + ANALYZER_VLLM_MODEL_ID` | 任意 OpenAI 兼容 LLM（推荐） |
| `ANTHROPIC_API_KEY` (or keytar `claude_api_key`) | 官方 Claude |
| 都没有 | 启发式 fallback（关键词 + 字符数 + CJK 比例） |

## CLI 总览

| 命令 | 用途 |
|---|---|
| `router run "..."` | **subprocess 友好**：stdout 纯文本，静默 stderr，退出码 0/1/2/3 |
| `router approve <token>` | 继续 pending_approval 任务 |
| `router delegate "..."` | 给人看：完整 JSON envelope |
| `router smoke` | 离线烟雾测试（MockProvider，零依赖） |
| `router seed-fixtures [--vllm-only]` | 注册示例 / 用环境变量注册你的 vLLM |
| `router models list \| add <file> \| remove <id>` | 模型注册表管理 |
| `router tasks get <task_id>` | 查任务详情 |
| `router serve [--http] [--mcp]` | 启 HTTP API / MCP-over-HTTP |

## 三套适配器

- **CLI**（首选给 Claude Code 用）：`router run "..."`
- **HTTP** (Hono)：`POST /v1/delegate`
- **MCP-over-HTTP**：5 个工具自动发现（`delegate_subtask` / `confirm_subtask` / `get_task` / `list_models` / `submit_feedback`）

## 设计要点

- **10 个能力维度**：instruction_following / chinese_quality / structured_output / code / long_form_coherence / translation / factual_accuracy / math_reasoning / critical_judgment / tool_use
- **三层模型画像**：Layer 1 硬属性（hosted/local 分支）/ Layer 2 能力分（含校准）/ Layer 3 软标签（prompt_recipes + avoid_patterns 表达式）
- **挂起态**：高风险 / 高成本 / 低置信决策 → 返回 token，调用方批准后 `confirmAndExecute`
- **校准**：半衰 EMA（默认 half-life 50 样本），锚定初始分以避免抖动
- **幂等**：`idempotency_key` 命中已有任务

## 目录结构

```
src/
├── core/             # schemas、weights、analyzer、hardFilter、scorer、decider、executor、validator、calibrator、pipeline
├── persistence/      # SQLite + migrations + CRUD
├── registry/         # ModelRegistry
├── providers/        # OpenAI-compatible / Ollama
├── claude/           # analyzer LLM client（Claude 或 OpenAI-compat）
├── secrets/          # keytar / env / file 三回退
├── adapters/         # http.ts / mcp.ts / cli.ts
├── config/           # TOML loader + schema
├── logging/          # pino
└── util/             # bootstrap、fixtures、mockProvider
test/
├── unit/             # hardFilter / scorer / calibrator / exprEval
└── integration/      # pipeline_happy / pipeline_approval / pipeline_feedback
```

## 验证

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run (单测 + 集成)
```

## License

私有项目。
