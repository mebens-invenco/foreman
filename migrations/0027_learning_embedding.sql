CREATE TABLE learning_embedding (
  learning_id TEXT PRIMARY KEY REFERENCES learning(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_learning_embedding_model ON learning_embedding(model);
