-- SET NULL, not the default NO ACTION: deleting an original must un-flag its
-- duplicates, not block the delete. SQLite cannot alter a foreign key after the
-- fact, so this action is fixed at creation.
ALTER TABLE learning ADD COLUMN duplicate_of TEXT REFERENCES learning(id) ON DELETE SET NULL;
ALTER TABLE learning ADD COLUMN source_task_id TEXT;
