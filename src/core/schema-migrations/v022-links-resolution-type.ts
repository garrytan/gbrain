import type { Migration } from './types.ts';

export const v022: Migration = {
  version: 22,
  name: 'links_resolution_type',
  // v0.18.0 Step 4 (Lane B) — adds links.resolution_type column so
  // each edge records whether its target source was pinned at
  // extraction time via `[[source:slug]]` (qualified) or resolved
  // via local-first fallback (unqualified). Unqualified edges are
  // candidates for re-resolution via `gbrain extract
  // --refresh-unqualified` when the source topology changes.
  //
  // Nullable because legacy edges (pre-v0.17) have no resolution
  // concept. `frontmatter` and `manual` edges remain NULL — they're
  // not subject to staleness under source churn.
  sql: `
      ALTER TABLE links ADD COLUMN IF NOT EXISTS resolution_type TEXT;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'links_resolution_type_check'
        ) THEN
          ALTER TABLE links ADD CONSTRAINT links_resolution_type_check
            CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified'));
        END IF;
      END $$;
    `,
};
