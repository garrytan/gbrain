import type { Migration } from './types.ts';

// Life Chronicle ontology dedup keyed per stint: the observation's valid_from
// joins (source, entity, dimension, value, provenance), so returning to an
// earlier value with the same provenance (A → B → A) records a new interval
// instead of colliding with the first stint. A crash-retry of the same
// observation still conflicts; a same-stint repeat is a noop in
// mergeOntologyFact. The new key is strictly finer than the old one, so
// existing rows always satisfy it.
export const v188: Migration = {
  version: 188,
  name: 'facts_ontology_stint_dedup',
  idempotent: true,
  sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_ontology_stint_dedup
        ON facts(source_id, entity_slug, dimension, value_hash, source_markdown_slug, valid_from)
        WHERE dimension IS NOT NULL;
      DROP INDEX IF EXISTS idx_facts_ontology_dedup;
    `,
};
