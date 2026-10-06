import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// normalizeAlias now folds ё → е and drops a Cyrillic stress mark (U+0301)
// after lowercasing, on both the write and the read side. Rows written
// before that would never match a query again, so re-key them with the
// same two folds (alias_norm is already NFKC + lowercase). Rows that
// collapse onto a sibling of the same page lose the duplicate first (keeping
// an already-folded row, else the oldest), so the (source_id, alias_norm,
// slug) unique key cannot fire. Idempotent.
// test/cyrillic-slug-grammar.test.ts pins this SQL to normalizeAlias.
//
// page_aliases carries the managed-writer trigger (v156); on a brain with
// enforcement enabled a write needs the coordinator's per-transaction source
// grant. A schema migration runs quiesced, so grant every source for this
// transaction only (is_local = true), exactly as the coordinator would, or
// the upgrade stops here.
export const v216: Migration = {
  version: 216,
  name: 'page_aliases_cyrillic_fold',
  idempotent: true,
  sql: `
    SELECT set_config('gbrain.write_sources',
      (SELECT COALESCE(jsonb_agg(DISTINCT sid), '[]'::jsonb)::text
         FROM (SELECT id AS sid FROM sources UNION SELECT source_id FROM page_aliases) s), true);
    WITH f AS (
      SELECT id, source_id, slug, alias_norm, regexp_replace(replace(alias_norm, 'ё', 'е'), '([Ѐ-ӿ])́+', '\\1', 'g') AS k FROM page_aliases
    ), dup AS (
      SELECT fa.id FROM f fa JOIN f fb
        ON fb.id <> fa.id AND fb.source_id = fa.source_id AND fb.slug = fa.slug AND fb.k = fa.k
       WHERE fa.k <> fa.alias_norm AND (fb.k = fb.alias_norm OR fb.id < fa.id)
    )
    DELETE FROM page_aliases WHERE id IN (SELECT id FROM dup);
    UPDATE page_aliases SET alias_norm = f.k
      FROM (SELECT id, regexp_replace(replace(alias_norm, 'ё', 'е'), '([Ѐ-ӿ])́+', '\\1', 'g') AS k FROM page_aliases) f
     WHERE f.id = page_aliases.id AND f.k <> page_aliases.alias_norm;
  `,
};
