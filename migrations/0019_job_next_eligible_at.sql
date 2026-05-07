ALTER TABLE job
ADD COLUMN next_eligible_at TEXT;

CREATE INDEX idx_job_next_eligible_at ON job(next_eligible_at);
