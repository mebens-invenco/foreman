CREATE VIRTUAL TABLE learning_fts USING fts5(
  id UNINDEXED,
  title,
  tags,
  content,
  tokenize = 'unicode61'
);

CREATE TRIGGER learning_fts_after_insert
AFTER INSERT ON learning
FOR EACH ROW
BEGIN
  INSERT INTO learning_fts(rowid, id, title, tags, content)
  VALUES (NEW.rowid, NEW.id, NEW.title, NEW.tags, NEW.content);
END;

CREATE TRIGGER learning_fts_after_update
AFTER UPDATE ON learning
FOR EACH ROW
BEGIN
  DELETE FROM learning_fts WHERE rowid = OLD.rowid;
  INSERT INTO learning_fts(rowid, id, title, tags, content)
  VALUES (NEW.rowid, NEW.id, NEW.title, NEW.tags, NEW.content);
END;

CREATE TRIGGER learning_fts_after_delete
AFTER DELETE ON learning
FOR EACH ROW
BEGIN
  DELETE FROM learning_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER learning_touch_updated_at
AFTER UPDATE ON learning
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE learning
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE rowid = OLD.rowid;
END;

INSERT INTO learning_fts(rowid, id, title, tags, content)
SELECT rowid, id, title, tags, content FROM learning;
