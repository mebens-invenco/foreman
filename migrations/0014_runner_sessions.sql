CREATE TABLE runner_session (
  id TEXT PRIMARY KEY,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('implementation', 'reviewer')),
  runner_name TEXT NOT NULL CHECK (runner_name IN ('opencode', 'claude')),
  runner_model TEXT NOT NULL,
  runner_variant TEXT NOT NULL,
  native_session_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL,
  last_worktree_head_sha TEXT,
  last_review_head_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runner_session_target_role_config_active
  ON runner_session(task_target_id, role, runner_name, runner_model, runner_variant, is_active, updated_at DESC);

CREATE UNIQUE INDEX idx_runner_session_unique_active_config
  ON runner_session(task_target_id, role, runner_name, runner_model, runner_variant)
  WHERE is_active = 1;

ALTER TABLE execution_attempt ADD COLUMN runner_session_id TEXT REFERENCES runner_session(id) ON DELETE SET NULL;

CREATE INDEX idx_execution_attempt_runner_session_id
  ON execution_attempt(runner_session_id);
