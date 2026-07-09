ALTER TABLE learning ADD COLUMN duplicate_of TEXT REFERENCES learning(id);
ALTER TABLE learning ADD COLUMN source_task_id TEXT;
