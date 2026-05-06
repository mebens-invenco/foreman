DROP INDEX IF EXISTS idx_task_provider_provider_id;
DROP INDEX IF EXISTS idx_task_state_updated_at_desc;

CREATE TABLE task_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('linear', 'file')),
  provider_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'in_progress', 'in_review', 'deployable', 'done', 'canceled')),
  provider_state TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'none', 'low')),
  assignee TEXT,
  url TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels_json) AND json_type(labels_json) = 'array')
);

INSERT INTO task_new(
  id, provider, provider_id, title, description, state, provider_state, priority,
  assignee, url, updated_at, synced_at, labels_json
)
SELECT
  id, provider, provider_id, title, description, state, provider_state, priority,
  assignee, url, updated_at, synced_at, labels_json
FROM task;

DROP TABLE task;
ALTER TABLE task_new RENAME TO task;

CREATE UNIQUE INDEX idx_task_provider_provider_id ON task(provider, provider_id);
CREATE INDEX idx_task_state_updated_at_desc ON task(state, updated_at DESC);
