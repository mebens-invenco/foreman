ALTER TABLE execution_attempt
  ADD COLUMN tokens_used_json TEXT
  CHECK (tokens_used_json IS NULL OR json_valid(tokens_used_json));
