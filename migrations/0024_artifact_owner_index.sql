-- Artifact lookups by owner (listArtifacts(ownerType, ownerId)) previously full-scanned
-- the table: the only index was the unique one on relative_path. Per-attempt readers
-- (HTTP attempt detail, eval-harvest) query by owner once per attempt, so give them an
-- index that also covers the created_at DESC ordering the query uses.
CREATE INDEX idx_artifact_owner_created_at_desc ON artifact(owner_type, owner_id, created_at DESC);
