-- `learning.updated_at` is the repo's proxy for "the text changed": both
-- `listLearningIdsMissingEmbedding` and the hybrid-search coverage gate compare
-- it against `learning_embedding.updated_at` to decide whether a stored vector
-- still describes the row it belongs to.
--
-- The original trigger fired on ANY update that left `updated_at` alone, and
-- `incrementReadCount` is exactly such an update. So merely *retrieving* a
-- learning marked its vector stale: one `learnings search` was enough to make
-- every hit look un-embedded, which re-embedded the whole read corpus on the
-- next backfill and would drive the coverage gate to permanent FTS fallback.
--
-- Read counters are retrieval telemetry, not content. Skip them.
DROP TRIGGER learning_touch_updated_at;

CREATE TRIGGER learning_touch_updated_at
AFTER UPDATE ON learning
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
 AND NEW.read_count = OLD.read_count
BEGIN
  UPDATE learning
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE rowid = OLD.rowid;
END;
