import type { Migration } from './types.ts';

export const v086: Migration = {
  version: 86,
  name: 'page_links_view_alias',
  // v0.39.0.0 schema-cathedral wave. Renumbered v81→v86 during the
  // master-merge of v0.38.0.0 ingestion cathedral + v0.38.1.0 agent loop
  // (master claimed v81-v85). page_links view alias is idempotent so
  // brains that already ran it under shanghai-v3's v81 number are safe.
  //
  // pglite-engine.ts and postgres-engine.ts both query a relation named
  // `page_links` (see pglite-engine.ts:896 / postgres-engine.ts:959). The
  // canonical table has always been `links`. This view aliases the table
  // so brains initialized before the v0.38 schema bundle pick up the
  // alias on upgrade.
  //
  // Narrow projection (id, from_page_id, to_page_id) so the view doesn't
  // depend on later-added columns — keeps DROP COLUMN + bootstrap probes
  // unblocked on legacy brains.
  sql: `
      CREATE OR REPLACE VIEW page_links AS
        SELECT id, from_page_id, to_page_id FROM links;
    `,
};
