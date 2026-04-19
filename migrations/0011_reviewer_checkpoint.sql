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

CREATE UNIQUE INDEX idx_reviewer_checkpoint_task_target
  ON reviewer_checkpoint(task_target_id);
CREATE UNIQUE INDEX idx_reviewer_checkpoint_task_pr
  ON reviewer_checkpoint(task_id, pr_url);
CREATE INDEX idx_reviewer_checkpoint_recorded_at_desc
  ON reviewer_checkpoint(recorded_at DESC);
CREATE INDEX idx_reviewer_checkpoint_task_target_recorded_at_desc
  ON reviewer_checkpoint(task_target_id, recorded_at DESC);
