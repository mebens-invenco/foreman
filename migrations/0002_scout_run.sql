CREATE TABLE scout_run (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (
    trigger_type IN ('startup', 'poll', 'worker_finished', 'task_mutation', 'lease_change', 'manual')
  ),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  selected_job_id TEXT REFERENCES job(id) ON DELETE SET NULL,
  selected_action TEXT CHECK (selected_action IN ('execution', 'review', 'retry', 'consolidation')),
  selected_task_id TEXT,
  selected_reason TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  terminal_count INTEGER NOT NULL DEFAULT 0 CHECK (terminal_count >= 0),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  error_message TEXT
);

CREATE INDEX idx_scout_run_started_at_desc ON scout_run(started_at DESC);
