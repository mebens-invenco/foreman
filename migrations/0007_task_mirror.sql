CREATE TABLE task (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('linear', 'file')),
  provider_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'in_progress', 'in_review', 'done', 'canceled')),
  provider_state TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'none', 'low')),
  assignee TEXT,
  url TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels_json) AND json_type(labels_json) = 'array')
);

CREATE UNIQUE INDEX idx_task_provider_provider_id ON task(provider, provider_id);
CREATE INDEX idx_task_state_updated_at_desc ON task(state, updated_at DESC);

CREATE TABLE task_target (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  repo_key TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, repo_key)
);

CREATE INDEX idx_task_target_task_id_position ON task_target(task_id, position ASC);

CREATE TABLE task_dependency (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  is_base_dependency INTEGER NOT NULL DEFAULT 0 CHECK (is_base_dependency IN (0, 1)),
  UNIQUE(task_id, depends_on_task_id)
);

CREATE INDEX idx_task_dependency_task_id_position ON task_dependency(task_id, position ASC);
CREATE INDEX idx_task_dependency_depends_on_task_id ON task_dependency(depends_on_task_id);

CREATE TABLE task_target_dependency (
  id TEXT PRIMARY KEY,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  depends_on_task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  source TEXT NOT NULL CHECK (source IN ('derived')),
  UNIQUE(task_target_id, depends_on_task_target_id)
);

CREATE INDEX idx_task_target_dependency_target_id_position
  ON task_target_dependency(task_target_id, position ASC);
