-- down-mutate-pre-v0.18.sql
-- Strip the v0.18+ forward-referenced state from a fresh-LATEST brain to
-- simulate a pre-v0.18 brain shape. Covers issues #366, #375, #378 —
-- pre-v0.18 brains crashed on `column "source_id" does not exist`.
--
-- After this runs, `gbrain doctor` MUST walk forward via the bootstrap
-- (postgres-engine.ts:applyForwardReferenceBootstrap) and reach LATEST
-- without wedging. Bootstrap re-creates `sources` table + seeds 'default',
-- re-adds `pages.source_id`, then SCHEMA_SQL replay + migrations run clean.
--
-- Pattern mirrored from test/bootstrap.test.ts:102-139 (PGLite side).
-- Run via psql against $DATABASE_URL.

BEGIN;

-- Restore the pre-v0.18 unique constraint shape on pages.slug (v0.18 widened
-- this to (source_id, slug)).
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);

DROP INDEX IF EXISTS idx_pages_source_id;
ALTER TABLE pages DROP COLUMN IF EXISTS source_id;

-- DROP TABLE sources with CASCADE so any dangling FKs go too.
DROP TABLE IF EXISTS sources CASCADE;

-- Pre-v0.18 didn't have resolution_type on links either.
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_resolution_type_check;
ALTER TABLE links DROP COLUMN IF EXISTS resolution_type;

-- Mark the brain at a pre-v0.18 version so the migration runner walks forward.
UPDATE config SET value = '20' WHERE key = 'version';

COMMIT;
