CREATE TABLE task_pull_request (
  id TEXT PRIMARY KEY,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  source TEXT NOT NULL CHECK (source IN ('local', 'provider', 'provider_inferred', 'branch_inferred')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_target_id)
);

CREATE INDEX idx_task_pull_request_task_target_id
  ON task_pull_request(task_target_id);
