import type { Migration } from './types.ts';

export const v113: Migration = {
  version: 113,
  name: 'links_link_source_widen_for_wikilink_basename',
  // Issue #972: opt-in global-basename wikilink resolution (bare [[name]]
  // resolved by slug tail) emits edges tagged
  // `link_source = 'wikilink-resolved'`. Widen the CHECK to admit it.
  //
  // The FULL set is enumerated here — not just the new value — because
  // DROP + re-ADD replaces the whole constraint. v95
  // (links_link_source_check_includes_mentions) added 'mentions'; since
  // this migration runs AFTER v95, omitting 'mentions' would silently
  // clobber that widening. Keep both branches in sync with src/schema.sql
  // and src/core/pglite-schema.ts.
  //
  // Renumbered v93 → v109 → v110 → v112 → v113 across successive master
  // merges (upstream claimed through v112 — pages_links_extracted_at — in
  // the interim). Idempotent via DROP ... IF EXISTS, so it no-ops on
  // installs that never created the constraint.
  idempotent: true,
  sql: `
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
      ALTER TABLE links ADD CONSTRAINT links_link_source_check
        CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual', 'mentions', 'wikilink-resolved'));
    `,
  sqlFor: {
    pglite: `
        ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
        ALTER TABLE links ADD CONSTRAINT links_link_source_check
          CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual', 'mentions', 'wikilink-resolved'));
      `,
  },
};
