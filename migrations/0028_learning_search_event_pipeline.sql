-- Which retriever answered a `learnings search`. NULL for `get` events, and for
-- search rows written before hybrid retrieval existed.
--
-- `hit_scores` is only comparable within one pipeline: hybrid writes fused RRF
-- scores (higher is better), fts writes raw bm25 (more negative is better).
ALTER TABLE learning_search_event
  ADD COLUMN pipeline TEXT CHECK (pipeline IS NULL OR pipeline IN ('hybrid', 'fts'));
