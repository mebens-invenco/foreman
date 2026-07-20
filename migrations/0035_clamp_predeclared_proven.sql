-- Only the curation pass mints `proven` (the worker-declared clamp): any `proven`
-- row existing when this migration first runs was declared by a worker before the
-- clamp existed — the pass has never demoted and never will, so without this the
-- stray tier is permanent. Store each such row as the clamp would have: `established`.
--
-- `updated_at` is captured and restored because `learning_touch_updated_at` stamps
-- it on any non-read UPDATE; a bookkeeping correction is not a content update
-- (migration 0029 semantics), and the consolidation tiebreak reads recency. The
-- restore escapes the trigger because it changes `updated_at`, which the trigger's
-- WHEN clause treats as the caller having set it deliberately.
CREATE TEMP TABLE predeclared_proven AS
  SELECT id, updated_at FROM learning WHERE confidence = 'proven';

UPDATE learning SET confidence = 'established' WHERE confidence = 'proven';

UPDATE learning
   SET updated_at = (SELECT updated_at FROM predeclared_proven WHERE predeclared_proven.id = learning.id)
 WHERE id IN (SELECT id FROM predeclared_proven);

DROP TABLE predeclared_proven;
