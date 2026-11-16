import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2687: gbrain_concept_inputs_private(page_id) is the concept-input arm of the read-time privacy rule
// (derivedOriginPrivateSql in src/core/search/private-visibility.ts): a synthesized concept or question is private when
// one of its concept-provenance inputs is private by its own field (an atom with no visibility counts as private), or
// the page at the input's source_slug or at that slug's rename alias is private, or, new here, a page that
// slug_rename_history moved the input's source_slug to is private. The last arm is the moved-origin probe #9325 added
// for atoms only (atomMovedOriginPrivateSql, #8920): a later rename onto the old slug drops the rename alias, so the
// alias arm alone read the concept by whatever page took the slug. The body is today's inline EXISTS with that arm
// added, so it hides everything the inline form hid. Only the privacy part calls it, so the owner, the operator hatches
// and granted_sources relax it exactly as before. A SQL function with SET is never inlined: the planner prices one call
// per page instead of the subplans, which kept the rule under jit_above_cost once links are analyzed. Reads only.
// No schema.sql mirror: like v282-v310, it exists only through migrations. Provisional number: renumbered at the
// merge slot.
export const v311: Migration = {
  version: 311,
  name: 'concept_inputs_private',
  idempotent: true,
  sql: `
CREATE OR REPLACE FUNCTION gbrain_concept_inputs_private(p_id INTEGER) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM links derived_input_link
    JOIN pages derived_input ON derived_input.id = derived_input_link.to_page_id
    WHERE derived_input_link.from_page_id = p_id AND derived_input_link.link_source = 'concept-provenance'
      AND derived_input_link.link_type = 'synthesized_from'
      AND (COALESCE(derived_input.frontmatter->>'visibility', CASE WHEN derived_input.type = 'atom' THEN 'private' ELSE 'world' END) = 'private'
        OR EXISTS (SELECT 1 FROM pages derived_input_origin WHERE derived_input_origin.source_id = derived_input.source_id
          AND derived_input_origin.slug = ANY(ARRAY[derived_input.frontmatter->>'source_slug', (SELECT renamed.canonical_slug FROM slug_aliases renamed
            WHERE renamed.source_id = derived_input.source_id AND renamed.alias_slug = derived_input.frontmatter->>'source_slug' AND renamed.notes = 'rename')])
          AND derived_input_origin.frontmatter->>'visibility' = 'private')
        OR EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id = moved.source_id AND moved_to.slug = moved.new_slug
          WHERE moved.source_id = derived_input.source_id AND moved.old_slug = derived_input.frontmatter->>'source_slug'
            AND moved_to.frontmatter->>'visibility' = 'private')))
$fn$;
`,
};
