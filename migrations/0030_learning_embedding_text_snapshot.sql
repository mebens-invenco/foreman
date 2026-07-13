-- Vector freshness was keyed on `learning.updated_at`, which is not a proxy for
-- "the text changed": `updateLearning` stamps it for every field, including
-- `applied_count`. So `markApplied: true` — which Foreman's own learning-review
-- step emits on most worker runs — declared a vector stale whose text nobody
-- touched. `worker-result-applier` already knows better ("a tags/confidence/
-- markApplied-only update leaves the vector valid") and skips re-embedding
-- those, so the two sites contradicted each other: a handful of applies dropped
-- hybrid retrieval below its coverage gate and sent the operator to a backfill
-- that re-embedded text which had never changed.
--
-- Key freshness on the embedded text itself. These columns are the snapshot the
-- vector was computed from — the same pair `upsertLearningEmbedding` already
-- guards its write on — so the applier, `listLearningIdsMissingEmbedding`, and
-- the coverage gate finally share one rule. Comparing the text exactly also
-- retires the millisecond-resolution hole in the timestamp comparison.
ALTER TABLE learning_embedding ADD COLUMN embedded_title TEXT;
ALTER TABLE learning_embedding ADD COLUMN embedded_content TEXT;

-- Backfill only where the old timestamps say the vector is UNAMBIGUOUSLY newer
-- than its learning. Strictly newer, not `>=`: equal timestamps are precisely the
-- millisecond-resolution ambiguity this migration exists to retire. A learning
-- edited in the same millisecond as its embedding write is indistinguishable here
-- from one that was never touched — and copying the learning's current text
-- beside a vector computed from the previous text would make the snapshot check
-- agree with itself forever, so no backfill would ever repair it. Leaving the
-- columns NULL costs one re-embed and cannot be wrong.
--
-- Rows already stale under the old rule likewise keep NULL columns and stay
-- stale. So no vector silently becomes current, and the only rows that lose their
-- usable status are the ones whose status was never knowable.
UPDATE learning_embedding
   SET embedded_title = (SELECT learning.title FROM learning WHERE learning.id = learning_embedding.learning_id),
       embedded_content = (SELECT learning.content FROM learning WHERE learning.id = learning_embedding.learning_id)
 WHERE learning_embedding.updated_at > (SELECT learning.updated_at FROM learning WHERE learning.id = learning_embedding.learning_id);
