ALTER TABLE review_checkpoint
ADD COLUMN review_threads_fingerprint TEXT NOT NULL DEFAULT '[]';
