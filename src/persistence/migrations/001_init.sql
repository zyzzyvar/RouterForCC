-- ============================================================================
-- 001_init: 建表
-- ============================================================================
-- 设计原则：
--   - 复杂字段（嵌套对象、数组）统一序列化为 JSON 文本存 TEXT 列
--   - 索引最小化：只为常用查询路径加索引
--   - 时间戳一律 ISO 8601 字符串（SQLite 没原生时间类型）
--   - 状态字段都加索引（task.status、model_entry.status）

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ============================================================================
-- 模型注册表
-- ============================================================================
CREATE TABLE IF NOT EXISTS model_entries (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  deployment_type TEXT NOT NULL,             -- 'hosted' | 'local'
  registered_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  -- 完整 ModelEntry 序列化为 JSON，避免列爆炸
  entry_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_entries_status ON model_entries(status);
CREATE INDEX IF NOT EXISTS idx_model_entries_deployment ON model_entries(deployment_type);
CREATE INDEX IF NOT EXISTS idx_model_entries_vendor ON model_entries(vendor);

-- ============================================================================
-- 任务
-- ============================================================================
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  parent_task_id TEXT,
  caller_id TEXT NOT NULL,
  caller_session_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL,                      -- analyzing | pending_approval | executing | executed | failed | cancelled
  raw_description TEXT NOT NULL,
  spec_json TEXT NOT NULL,                   -- 完整 TaskSpec
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(caller_id, idempotency_key) ON CONFLICT IGNORE
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_caller ON tasks(caller_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

-- ============================================================================
-- 执行记录
-- ============================================================================
CREATE TABLE IF NOT EXISTS execution_records (
  record_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  chosen_model_id TEXT NOT NULL,
  validation_passed INTEGER NOT NULL,        -- bool 0/1
  cost_usd REAL,                             -- nullable for local
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  record_json TEXT NOT NULL,                 -- 完整 ExecutionRecord
  FOREIGN KEY(task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_records_task ON execution_records(task_id);
CREATE INDEX IF NOT EXISTS idx_records_model ON execution_records(chosen_model_id);
CREATE INDEX IF NOT EXISTS idx_records_passed ON execution_records(validation_passed);
CREATE INDEX IF NOT EXISTS idx_records_started ON execution_records(started_at);

-- ============================================================================
-- 挂起态（continuation token）
-- ============================================================================
CREATE TABLE IF NOT EXISTS pending_approvals (
  token TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  approval_reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_approvals(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_task ON pending_approvals(task_id);
