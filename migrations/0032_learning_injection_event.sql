CREATE TABLE learning_injection_event (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempt(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('execution', 'retry', 'review')),
  learning_id TEXT NOT NULL REFERENCES learning(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  cosine_similarity REAL NOT NULL,
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_learning_injection_event_attempt_id ON learning_injection_event(attempt_id);
CREATE INDEX idx_learning_injection_event_learning_id ON learning_injection_event(learning_id);
