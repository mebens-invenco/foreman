CREATE TABLE learning (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  repo TEXT NOT NULL CHECK (length(trim(repo)) > 0),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  confidence TEXT NOT NULL CHECK (confidence IN ('emerging', 'established', 'proven')),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  read_count INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_learning_repo ON learning(repo);

CREATE TABLE history_step (
  step_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  stage TEXT NOT NULL,
  issue TEXT NOT NULL CHECK (length(trim(issue)) > 0),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0)
);

CREATE INDEX idx_history_step_created_at ON history_step(created_at);
CREATE INDEX idx_history_step_issue ON history_step(issue);
CREATE INDEX idx_history_step_stage ON history_step(stage);

CREATE TABLE history_step_repo (
  step_id TEXT NOT NULL REFERENCES history_step(step_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  path TEXT NOT NULL,
  before_sha TEXT NOT NULL,
  after_sha TEXT NOT NULL,
  PRIMARY KEY (step_id, position)
);

CREATE INDEX idx_history_step_repo_path ON history_step_repo(path);
