PRAGMA foreign_keys=OFF;

ALTER TABLE execution_attempt_event RENAME TO execution_attempt_event_old;
ALTER TABLE lease RENAME TO lease_old;
ALTER TABLE review_checkpoint RENAME TO review_checkpoint_old;
ALTER TABLE reviewer_checkpoint RENAME TO reviewer_checkpoint_old;
ALTER TABLE execution_attempt RENAME TO execution_attempt_old;

CREATE TABLE execution_attempt (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  worker_id TEXT REFERENCES worker(id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  runner_name TEXT NOT NULL CHECK (runner_name IN ('opencode', 'claude')),
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

INSERT INTO execution_attempt(
  id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, status, started_at,
  finished_at, exit_code, signal, summary, error_message
)
SELECT id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, status, started_at,
       finished_at, exit_code, signal, summary, error_message
  FROM execution_attempt_old;

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

DROP TABLE reviewer_checkpoint_old;
DROP TABLE review_checkpoint_old;
DROP TABLE lease_old;
DROP TABLE execution_attempt_event_old;
DROP TABLE execution_attempt_old;

CREATE UNIQUE INDEX idx_execution_attempt_job_attempt_number
  ON execution_attempt(job_id, attempt_number);
CREATE INDEX idx_execution_attempt_job_id_started_at_desc
  ON execution_attempt(job_id, started_at DESC);
CREATE INDEX idx_execution_attempt_status_started_at_desc
  ON execution_attempt(status, started_at DESC);

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

PRAGMA foreign_keys=ON;
