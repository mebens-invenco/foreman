CREATE TABLE learning_search_event (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind TEXT NOT NULL CHECK (kind IN ('search', 'get')),
  caller TEXT,
  queries TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(queries) AND json_type(queries) = 'array'),
  repos TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(repos) AND json_type(repos) = 'array'),
  requested_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(requested_ids) AND json_type(requested_ids) = 'array'),
  hit_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hit_ids) AND json_type(hit_ids) = 'array'),
  hit_scores TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hit_scores) AND json_type(hit_scores) = 'array'),
  zero_hit INTEGER NOT NULL DEFAULT 0 CHECK (zero_hit IN (0, 1))
);

CREATE INDEX idx_learning_search_event_created_at ON learning_search_event(created_at);
CREATE INDEX idx_learning_search_event_kind ON learning_search_event(kind);
