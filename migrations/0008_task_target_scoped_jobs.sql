ALTER TABLE job
ADD COLUMN task_target_id TEXT REFERENCES task_target(id) ON DELETE SET NULL;

UPDATE job
   SET task_target_id = (
     SELECT task_target.id
       FROM task_target
      WHERE task_target.task_id = job.task_id
        AND task_target.repo_key = job.repo_key
      LIMIT 1
   )
 WHERE task_target_id IS NULL;

CREATE INDEX idx_job_task_target_id_created_at_desc
  ON job(task_target_id, created_at DESC);

ALTER TABLE review_checkpoint
ADD COLUMN task_target_id TEXT REFERENCES task_target(id) ON DELETE CASCADE;

UPDATE review_checkpoint
   SET task_target_id = (
     SELECT single_target.id
       FROM (
         SELECT MIN(task_target.id) AS id,
                task_target.task_id AS task_id
           FROM task_target
          GROUP BY task_target.task_id
         HAVING COUNT(*) = 1
       ) AS single_target
      WHERE single_target.task_id = review_checkpoint.task_id
   )
 WHERE task_target_id IS NULL;

CREATE UNIQUE INDEX idx_review_checkpoint_task_target
  ON review_checkpoint(task_target_id);

CREATE INDEX idx_review_checkpoint_task_target_recorded_at_desc
  ON review_checkpoint(task_target_id, recorded_at DESC);
