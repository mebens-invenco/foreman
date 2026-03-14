CREATE TABLE IF NOT EXISTS schema_migration (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_provider TEXT NOT NULL CHECK (task_provider IN ('linear', 'file')),
  action TEXT NOT NULL CHECK (action IN ('execution', 'review', 'retry', 'consolidation')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'blocked', 'canceled')),
  priority_rank INTEGER NOT NULL CHECK (priority_rank >= 1 AND priority_rank <= 5),
  repo_key TEXT NOT NULL,
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

CREATE UNIQUE INDEX idx_job_unique_active_dedupe
  ON job(dedupe_key)
  WHERE status IN ('queued', 'leased', 'running');

CREATE INDEX idx_job_status_created_at ON job(status, created_at);
CREATE INDEX idx_job_task_id_created_at_desc ON job(task_id, created_at DESC);

CREATE TABLE worker (
  id TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'leased', 'running', 'stopping', 'offline')),
  process_id INTEGER,
  current_attempt_id TEXT,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_worker_slot ON worker(slot);
CREATE INDEX idx_worker_status ON worker(status);

CREATE TABLE execution_attempt (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  worker_id TEXT REFERENCES worker(id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  runner_name TEXT NOT NULL CHECK (runner_name IN ('opencode')),
  runner_model TEXT NOT NULL,
  runner_variant TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'canceled', 'timed_out')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  summary TEXT NOT NULL DEFAULT '',
  error_message TEXT,
  FOREIGN KEY(worker_id) REFERENCES worker(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_execution_attempt_job_attempt_number
  ON execution_attempt(job_id, attempt_number);
CREATE INDEX idx_execution_attempt_job_id_started_at_desc
  ON execution_attempt(job_id, started_at DESC);
CREATE INDEX idx_execution_attempt_status_started_at_desc
  ON execution_attempt(status, started_at DESC);

CREATE TABLE execution_attempt_event (
  id TEXT PRIMARY KEY,
  execution_attempt_id TEXT NOT NULL REFERENCES execution_attempt(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_execution_attempt_event_attempt_id_created_at_asc
  ON execution_attempt_event(execution_attempt_id, created_at ASC);

CREATE TABLE lease (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('job', 'task', 'branch')),
  resource_key TEXT NOT NULL,
  worker_id TEXT NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
  execution_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);

CREATE UNIQUE INDEX idx_lease_unique_active_resource
  ON lease(resource_type, resource_key)
  WHERE released_at IS NULL;
CREATE INDEX idx_lease_expires_at ON lease(expires_at);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('workspace', 'job', 'execution_attempt', 'scout_run')),
  owner_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN ('log', 'rendered_prompt', 'parsed_result', 'plan_prompt', 'plan_context')
  ),
  relative_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_artifact_relative_path ON artifact(relative_path);
