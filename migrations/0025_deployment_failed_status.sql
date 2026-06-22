PRAGMA foreign_keys=OFF;

ALTER TABLE deployment RENAME TO deployment_old;

CREATE TABLE deployment (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  repo_key TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_head_branch TEXT NOT NULL,
  pr_base_branch TEXT NOT NULL,
  instruction_hash TEXT NOT NULL,
  instruction_body TEXT NOT NULL,
  latest_status TEXT NOT NULL CHECK (latest_status IN ('succeeded', 'in_progress', 'follow_up_created', 'blocked', 'failed')),
  latest_summary TEXT NOT NULL DEFAULT '',
  next_eligible_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  blocked_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_retry_count >= 0),
  created_follow_up_task_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(created_follow_up_task_ids_json) AND json_type(created_follow_up_task_ids_json) = 'array'),
  successful INTEGER NOT NULL DEFAULT 0 CHECK (successful IN (0, 1)),
  source_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_target_id, pr_url, instruction_hash)
);

INSERT INTO deployment(
  id, task_id, task_target_id, repo_key, pr_url, pr_number, pr_head_branch, pr_base_branch,
  instruction_hash, instruction_body, latest_status, latest_summary, next_eligible_at,
  retry_count, blocked_retry_count, created_follow_up_task_ids_json, successful, source_attempt_id,
  created_at, updated_at
)
SELECT id, task_id, task_target_id, repo_key, pr_url, pr_number, pr_head_branch, pr_base_branch,
       instruction_hash, instruction_body, latest_status, latest_summary, next_eligible_at,
       retry_count, blocked_retry_count, created_follow_up_task_ids_json, successful, source_attempt_id,
       created_at, updated_at
  FROM deployment_old;

DROP TABLE deployment_old;

PRAGMA foreign_keys=ON;
