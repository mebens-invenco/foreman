ALTER TABLE task
  ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(artifacts_json) AND json_type(artifacts_json) = 'array');

CREATE TABLE task_target_dependency_new (
  id TEXT PRIMARY KEY,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  depends_on_task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  source TEXT NOT NULL CHECK (source IN ('derived', 'metadata')),
  UNIQUE(task_target_id, depends_on_task_target_id)
);

INSERT INTO task_target_dependency_new(id, task_target_id, depends_on_task_target_id, position, source)
SELECT id, task_target_id, depends_on_task_target_id, position, source
  FROM task_target_dependency;

DROP TABLE task_target_dependency;

ALTER TABLE task_target_dependency_new RENAME TO task_target_dependency;

CREATE INDEX idx_task_target_dependency_target_id_position
  ON task_target_dependency(task_target_id, position ASC);
