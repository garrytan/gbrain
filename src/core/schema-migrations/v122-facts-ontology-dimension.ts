import type { Migration } from './types.ts';

export const v122: Migration = {
  version: 122,
  name: 'facts_ontology_dimension',
  // v0.42.x — Life Chronicle (#2390): the per-entity ontology rides the
  // existing `facts` table. facts already gives bi-temporal validity
  // (valid_from/valid_until/expired_at), supersession (superseded_by),
  // remote redaction (visibility), confidence, provenance (source_markdown_slug),
  // embedding, and corroboration (consolidated_into). The ONLY genuinely-new
  // concept is a typed `dimension` (e.g. role, risk_tolerance) carrying a
  // resolved `value` + a deterministic `value_hash` dedup key, plus a
  // `dim_status` for quarantining novel/LLM-proposed dimensions. Plain facts
  // keep dimension NULL → unchanged behavior. The partial UNIQUE is
  // deterministic (no timestamp) so a crash-retry is idempotent. Additive;
  // facts is migration-created (absent from static schema), so this migration
  // is the single source for fresh + migrated brains.
  idempotent: true,
  sql: `
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS dimension  TEXT;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS value      TEXT;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS value_hash TEXT;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS dim_status TEXT;

      CREATE INDEX IF NOT EXISTS idx_facts_dimension
        ON facts(source_id, entity_slug, dimension, valid_from DESC)
        WHERE expired_at IS NULL AND dimension IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_ontology_dedup
        ON facts(source_id, entity_slug, dimension, value_hash, source_markdown_slug)
        WHERE dimension IS NOT NULL;
    `,
};
