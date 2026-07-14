-- Task-scoped provenance for learning usage. `learning.read_count` /
-- `learning.applied_count` stay honest touch-counts, but a touch is not
-- usefulness: learning-policy makes every stage of one task search, so one deep
-- ticket bumps the same learning 3-6x, and a learning extracted mid-task can be
-- read and applied by later stages of the very task that created it. These rows
-- carry the task dimension the counters lack, so M5 can count DISTINCT tasks and
-- subtract the self-echo (`task_id = learning.source_task_id`).
--
-- No CHECK on `action`: unlike `learning_injection_event`, which only three
-- actions are eligible for, any action whose worker result carries a
-- `markApplied` mutation lands here. A CHECK enumerating today's actions would
-- reject a future one, and the never-fail insert would swallow that into a
-- warning -- losing the signal silently, which is the failure this table exists
-- to prevent.
CREATE TABLE learning_applied_event (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempt(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  learning_id TEXT NOT NULL REFERENCES learning(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_learning_applied_event_learning_id ON learning_applied_event(learning_id);
CREATE INDEX idx_learning_applied_event_task_id ON learning_applied_event(task_id);

-- The attempt a `learnings search` / `learnings get` ran inside, stamped from the
-- runner env. Nullable, and NOT a foreign key: ad-hoc human CLI use has no
-- attempt, rows written before this migration have no task dimension, and a
-- cascade would delete honest touch records that `read_count` has already
-- counted. Both columns are written together or not at all -- the repo takes one
-- optional source object, so neither can be stamped without the other.
ALTER TABLE learning_search_event ADD COLUMN attempt_id TEXT;
ALTER TABLE learning_search_event ADD COLUMN task_id TEXT;

CREATE INDEX idx_learning_search_event_task_id ON learning_search_event(task_id);
