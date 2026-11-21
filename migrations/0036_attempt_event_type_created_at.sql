CREATE INDEX IF NOT EXISTS idx_execution_attempt_event_type_created_at
  ON execution_attempt_event(event_type, created_at DESC);
