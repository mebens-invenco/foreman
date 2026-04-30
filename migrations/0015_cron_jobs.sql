PRAGMA foreign_keys=OFF;

ALTER TABLE execution_attempt_event RENAME TO execution_attempt_event_old;
ALTER TABLE lease RENAME TO lease_old;
ALTER TABLE artifact RENAME TO artifact_old;
ALTER TABLE review_checkpoint RENAME TO review_checkpoint_old;
ALTER TABLE reviewer_checkpoint RENAME TO reviewer_checkpoint_old;
ALTER TABLE runner_session RENAME TO runner_session_old;
ALTER TABLE execution_attempt RENAME TO execution_attempt_old;
ALTER TABLE scout_run RENAME TO scout_run_old;
ALTER TABLE job RENAME TO job_old;

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL DEFAULT 'task' CHECK (job_kind IN ('task', 'cron')),
  task_id TEXT,
  task_target_id TEXT REFERENCES task_target(id) ON DELETE SET NULL,
  task_provider TEXT CHECK (task_provider IN ('linear', 'file')),
  cron_job_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('execution', 'review', 'reviewer', 'retry', 'consolidation', 'cron')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'blocked', 'canceled')),
  priority_rank INTEGER NOT NULL CHECK (priority_rank >= 1 AND priority_rank <= 5),
  repo_key TEXT,
  base_branch TEXT,
  dedupe_key TEXT NOT NULL,
  selection_reason TEXT NOT NULL DEFAULT '',
  selection_context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selection_context_json)),
  scout_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  leased_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT
);

CREATE TABLE execution_attempt (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  worker_id TEXT REFERENCES worker(id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  runner_name TEXT NOT NULL CHECK (runner_name IN ('opencode', 'claude')),
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
  FOREIGN KEY(worker_id) REFERENCES worker(id) ON DELETE SET NULL
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

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('workspace', 'job', 'execution_attempt', 'scout_run')),
  owner_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN ('log', 'rendered_prompt', 'parsed_result', 'runner_output', 'plan_prompt', 'plan_context')
  ),
  relative_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT,
  created_at TEXT NOT NULL
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

CREATE TABLE scout_run (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (
    trigger_type IN ('startup', 'poll', 'worker_finished', 'task_mutation', 'lease_change', 'manual')
  ),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  selected_job_id TEXT REFERENCES job(id) ON DELETE SET NULL,
  selected_action TEXT CHECK (selected_action IN ('execution', 'review', 'reviewer', 'retry', 'consolidation', 'cron')),
  selected_task_id TEXT,
  selected_reason TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  terminal_count INTEGER NOT NULL DEFAULT 0 CHECK (terminal_count >= 0),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  error_message TEXT
);

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

INSERT INTO job(
  id, job_kind, task_id, task_target_id, task_provider, cron_job_id, action, status, priority_rank, repo_key,
  base_branch, dedupe_key, selection_reason, selection_context_json, scout_run_id, created_at, updated_at,
  leased_at, started_at, finished_at, error_message
)
SELECT id, 'task', task_id, task_target_id, task_provider, NULL, action, status, priority_rank, repo_key,
       base_branch, dedupe_key, selection_reason, selection_context_json, scout_run_id, created_at, updated_at,
       leased_at, started_at, finished_at, error_message
  FROM job_old;

INSERT INTO execution_attempt(
  id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id, status, started_at,
  finished_at, exit_code, signal, summary, error_message
)
SELECT id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id, status, started_at,
       finished_at, exit_code, signal, summary, error_message
  FROM execution_attempt_old;

INSERT INTO execution_attempt_event(id, execution_attempt_id, event_type, message, payload_json, created_at)
SELECT id, execution_attempt_id, event_type, message, payload_json, created_at
  FROM execution_attempt_event_old;

INSERT INTO lease(id, resource_type, resource_key, worker_id, execution_attempt_id, acquired_at, heartbeat_at, expires_at, released_at, release_reason)
SELECT id, resource_type, resource_key, worker_id, execution_attempt_id, acquired_at, heartbeat_at, expires_at, released_at, release_reason
  FROM lease_old;

INSERT INTO artifact(id, owner_type, owner_id, artifact_type, relative_path, media_type, size_bytes, sha256, created_at)
SELECT id, owner_type, owner_id, artifact_type, relative_path, media_type, size_bytes, sha256, created_at
  FROM artifact_old;

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

INSERT INTO scout_run(
  id, trigger_type, status, started_at, finished_at, selected_job_id, selected_action, selected_task_id,
  selected_reason, candidate_count, active_count, terminal_count, summary_json, error_message
)
SELECT id, trigger_type, status, started_at, finished_at, selected_job_id, selected_action, selected_task_id,
       selected_reason, candidate_count, active_count, terminal_count, summary_json, error_message
  FROM scout_run_old;

INSERT INTO runner_session(
  id, task_target_id, role, runner_name, runner_model, runner_variant, native_session_id, is_active,
  last_attempt_id, last_worktree_head_sha, last_review_head_sha, created_at, updated_at
)
SELECT id, task_target_id, role, runner_name, runner_model, runner_variant, native_session_id, is_active,
       last_attempt_id, last_worktree_head_sha, last_review_head_sha, created_at, updated_at
  FROM runner_session_old;

DROP TABLE runner_session_old;
DROP TABLE scout_run_old;
DROP TABLE reviewer_checkpoint_old;
DROP TABLE review_checkpoint_old;
DROP TABLE artifact_old;
DROP TABLE lease_old;
DROP TABLE execution_attempt_event_old;
DROP TABLE execution_attempt_old;
DROP TABLE job_old;

CREATE UNIQUE INDEX idx_job_unique_active_dedupe
  ON job(dedupe_key)
  WHERE status IN ('queued', 'leased', 'running');
CREATE INDEX idx_job_status_created_at ON job(status, created_at);
CREATE INDEX idx_job_task_id_created_at_desc ON job(task_id, created_at DESC);
CREATE INDEX idx_job_task_target_id_created_at_desc ON job(task_target_id, created_at DESC);
CREATE INDEX idx_job_cron_job_id_created_at_desc ON job(cron_job_id, created_at DESC);

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

CREATE UNIQUE INDEX idx_artifact_relative_path ON artifact(relative_path);

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

CREATE INDEX idx_scout_run_started_at_desc ON scout_run(started_at DESC);

CREATE INDEX idx_runner_session_target_role_config_active
  ON runner_session(task_target_id, role, runner_name, runner_model, runner_variant, is_active, updated_at DESC);
CREATE UNIQUE INDEX idx_runner_session_unique_active_config
  ON runner_session(task_target_id, role, runner_name, runner_model, runner_variant)
  WHERE is_active = 1;

PRAGMA foreign_keys=ON;
