-- Down migration for 0004: revert the comment to null.
COMMENT ON COLUMN sources.config IS NULL;
