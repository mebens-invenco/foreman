ALTER TABLE task_target_dependency RENAME TO task_target_dependency_old;

CREATE TABLE task_target_dependency (
  id TEXT PRIMARY KEY,
  task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  depends_on_task_target_id TEXT NOT NULL REFERENCES task_target(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  source TEXT NOT NULL CHECK (source IN ('derived', 'metadata')),
  UNIQUE(task_target_id, depends_on_task_target_id)
);

INSERT INTO task_target_dependency(id, task_target_id, depends_on_task_target_id, position, source)
SELECT id, task_target_id, depends_on_task_target_id, position, source
  FROM task_target_dependency_old;

DROP TABLE task_target_dependency_old;

CREATE INDEX idx_task_target_dependency_target_id_position
  ON task_target_dependency(task_target_id, position ASC);
