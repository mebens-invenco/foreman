-- Add the deployment runner session role.
-- SQLite cannot ALTER a CHECK constraint in place, so recreate runner_session
-- and every table whose FK would otherwise be rewritten to the shadow table.

PRAGMA foreign_keys=OFF;

ALTER TABLE execution_attempt_event RENAME TO execution_attempt_event_old;
ALTER TABLE lease RENAME TO lease_old;
ALTER TABLE review_checkpoint RENAME TO review_checkpoint_old;
ALTER TABLE reviewer_checkpoint RENAME TO reviewer_checkpoint_old;
ALTER TABLE deployment RENAME TO deployment_old;
ALTER TABLE runner_session RENAME TO runner_session_old;
ALTER TABLE execution_attempt RENAME TO execution_attempt_old;

CREATE TABLE execution_attempt (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  worker_id TEXT REFERENCES worker(id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  runner_name TEXT NOT NULL,
  runner_model TEXT NOT NULL,
  runner_variant TEXT NOT NULL,
  runner_session_id TEXT REFERENCES runner_session(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'canceled', 'timed_out')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  summary TEXT NOT NULL DEFAULT '',
  error_message TEXT,
  tokens_used_json TEXT CHECK (tokens_used_json IS NULL OR json_valid(tokens_used_json)),
  FOREIGN KEY(worker_id) REFERENCES worker(id) ON DELETE SET NULL
);

CREATE TABLE runner_session (
  id TEXT PRIMARY KEY,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('implementation', 'reviewer', 'deployment')),
  runner_name TEXT NOT NULL,
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

CREATE TABLE execution_attempt_event (
  id TEXT PRIMARY KEY,
  execution_attempt_id TEXT NOT NULL REFERENCES execution_attempt(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE lease (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('job', 'task', 'branch', 'cron')),
  resource_key TEXT NOT NULL,
  worker_id TEXT NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
  execution_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);

CREATE TABLE review_checkpoint (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  latest_review_summary_id TEXT,
  latest_conversation_comment_id TEXT,
  checks_fingerprint TEXT NOT NULL DEFAULT '',
  merge_state TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  source_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL,
  review_threads_fingerprint TEXT NOT NULL DEFAULT '[]',
  task_target_id TEXT REFERENCES task_target(id) ON DELETE CASCADE
);

CREATE TABLE reviewer_checkpoint (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  latest_review_summary_id TEXT,
  latest_conversation_comment_id TEXT,
  review_threads_fingerprint TEXT NOT NULL DEFAULT '[]',
  checks_fingerprint TEXT NOT NULL DEFAULT '',
  merge_state TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  source_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL
);

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
  latest_status TEXT NOT NULL CHECK (latest_status IN ('succeeded', 'in_progress', 'follow_up_created', 'blocked')),
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

INSERT INTO execution_attempt(
  id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id, status, started_at,
  finished_at, exit_code, signal, summary, error_message, tokens_used_json
)
SELECT id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id, status, started_at,
       finished_at, exit_code, signal, summary, error_message, tokens_used_json
  FROM execution_attempt_old;

INSERT INTO runner_session(
  id, task_target_id, role, runner_name, runner_model, runner_variant, native_session_id, is_active,
  last_attempt_id, last_worktree_head_sha, last_review_head_sha, created_at, updated_at
)
SELECT id, task_target_id, role, runner_name, runner_model, runner_variant, native_session_id, is_active,
       last_attempt_id, last_worktree_head_sha, last_review_head_sha, created_at, updated_at
  FROM runner_session_old;

INSERT INTO execution_attempt_event(id, execution_attempt_id, event_type, message, payload_json, created_at)
SELECT id, execution_attempt_id, event_type, message, payload_json, created_at
  FROM execution_attempt_event_old;

INSERT INTO lease(id, resource_type, resource_key, worker_id, execution_attempt_id, acquired_at, heartbeat_at, expires_at, released_at, release_reason)
SELECT id, resource_type, resource_key, worker_id, execution_attempt_id, acquired_at, heartbeat_at, expires_at, released_at, release_reason
  FROM lease_old;

INSERT INTO review_checkpoint(
  id, task_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id, checks_fingerprint,
  merge_state, recorded_at, source_attempt_id, review_threads_fingerprint, task_target_id
)
SELECT id, task_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id, checks_fingerprint,
       merge_state, recorded_at, source_attempt_id, review_threads_fingerprint, task_target_id
  FROM review_checkpoint_old;

INSERT INTO reviewer_checkpoint(
  id, task_id, task_target_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id,
  review_threads_fingerprint, checks_fingerprint, merge_state, recorded_at, source_attempt_id
)
SELECT id, task_id, task_target_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id,
       review_threads_fingerprint, checks_fingerprint, merge_state, recorded_at, source_attempt_id
  FROM reviewer_checkpoint_old;

INSERT INTO deployment(
  id, task_id, task_target_id, repo_key, pr_url, pr_number, pr_head_branch, pr_base_branch, instruction_hash,
  instruction_body, latest_status, latest_summary, next_eligible_at, retry_count, blocked_retry_count,
  created_follow_up_task_ids_json, successful, source_attempt_id, created_at, updated_at
)
SELECT id, task_id, task_target_id, repo_key, pr_url, pr_number, pr_head_branch, pr_base_branch, instruction_hash,
       instruction_body, latest_status, latest_summary, next_eligible_at, retry_count, blocked_retry_count,
       created_follow_up_task_ids_json, successful, source_attempt_id, created_at, updated_at
  FROM deployment_old;

DROP TABLE deployment_old;
DROP TABLE reviewer_checkpoint_old;
DROP TABLE review_checkpoint_old;
DROP TABLE lease_old;
DROP TABLE execution_attempt_event_old;
DROP TABLE runner_session_old;
DROP TABLE execution_attempt_old;

CREATE UNIQUE INDEX idx_execution_attempt_job_attempt_number
  ON execution_attempt(job_id, attempt_number);
CREATE INDEX idx_execution_attempt_job_id_started_at_desc
  ON execution_attempt(job_id, started_at DESC);
CREATE INDEX idx_execution_attempt_status_started_at_desc
  ON execution_attempt(status, started_at DESC);
CREATE INDEX idx_execution_attempt_runner_session_id
  ON execution_attempt(runner_session_id);

CREATE INDEX idx_execution_attempt_event_attempt_id_created_at_asc
  ON execution_attempt_event(execution_attempt_id, created_at ASC);

CREATE UNIQUE INDEX idx_lease_unique_active_resource
  ON lease(resource_type, resource_key)
  WHERE released_at IS NULL;
CREATE INDEX idx_lease_expires_at ON lease(expires_at);

CREATE UNIQUE INDEX idx_review_checkpoint_task_pr
  ON review_checkpoint(task_id, pr_url);
CREATE INDEX idx_review_checkpoint_recorded_at_desc
  ON review_checkpoint(recorded_at DESC);
CREATE UNIQUE INDEX idx_review_checkpoint_task_target
  ON review_checkpoint(task_target_id);
CREATE INDEX idx_review_checkpoint_task_target_recorded_at_desc
  ON review_checkpoint(task_target_id, recorded_at DESC);

CREATE UNIQUE INDEX idx_reviewer_checkpoint_task_target
  ON reviewer_checkpoint(task_target_id);
CREATE UNIQUE INDEX idx_reviewer_checkpoint_task_pr
  ON reviewer_checkpoint(task_id, pr_url);
CREATE INDEX idx_reviewer_checkpoint_recorded_at_desc
  ON reviewer_checkpoint(recorded_at DESC);
CREATE INDEX idx_reviewer_checkpoint_task_target_recorded_at_desc
  ON reviewer_checkpoint(task_target_id, recorded_at DESC);

CREATE INDEX idx_runner_session_target_role_config_active
  ON runner_session(task_target_id, role, runner_name, runner_model, runner_variant, is_active, updated_at DESC);
CREATE UNIQUE INDEX idx_runner_session_unique_active_config
  ON runner_session(task_target_id, role, runner_name, runner_model, runner_variant)
  WHERE is_active = 1;

CREATE INDEX idx_deployment_task_target ON deployment(task_id, task_target_id);
CREATE INDEX idx_deployment_next_eligible ON deployment(next_eligible_at);

PRAGMA foreign_keys=ON;
