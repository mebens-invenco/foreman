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
  source_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_review_checkpoint_task_pr
  ON review_checkpoint(task_id, pr_url);
CREATE INDEX idx_review_checkpoint_recorded_at_desc
  ON review_checkpoint(recorded_at DESC);
