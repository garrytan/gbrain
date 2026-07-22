-- down-mutate-pre-v0.13.sql
-- Strip the v0.13+ forward-referenced state from a fresh-LATEST brain to
-- simulate a pre-v0.13 brain shape. Covers issues #266, #357 — pre-v0.13
-- brains had `links` without `link_source` / `origin_page_id`, and the
-- schema blob's `CREATE INDEX idx_links_source` would crash before v11 ran.
--
-- After this runs, `gbrain doctor` MUST walk forward via the bootstrap
-- (postgres-engine.ts:applyForwardReferenceBootstrap) and reach LATEST
-- without wedging.
--
-- Pattern mirrored from test/bootstrap.test.ts:164-198 (PGLite side).
-- Run via psql against $DATABASE_URL.

BEGIN;

DROP INDEX IF EXISTS idx_links_source;
DROP INDEX IF EXISTS idx_links_origin;
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique;
ALTER TABLE links DROP COLUMN IF EXISTS link_source;
ALTER TABLE links DROP COLUMN IF EXISTS origin_page_id;

-- Mark the brain at a pre-v0.13 version so the migration runner walks forward.
UPDATE config SET value = '10' WHERE key = 'version';

COMMIT;
