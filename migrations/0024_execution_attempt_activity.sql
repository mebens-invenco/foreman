CREATE TABLE execution_attempt_activity (
  id TEXT PRIMARY KEY,
  execution_attempt_id TEXT NOT NULL REFERENCES execution_attempt(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_execution_attempt_activity_attempt_seq
  ON execution_attempt_activity(execution_attempt_id, seq);

CREATE INDEX idx_execution_attempt_activity_attempt_kind_seq_desc
  ON execution_attempt_activity(execution_attempt_id, kind, seq DESC);
