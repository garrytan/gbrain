import type { Migration } from './types.ts';

export const v161: Migration = {
  version: 161,
  name: 'index_pending_text_projections',
  idempotent: true,
  sql: `CREATE INDEX IF NOT EXISTS idx_pages_projection_pending
      ON pages(source_id, page_kind, slug)
      WHERE deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision;`,
  sqlFor: {
    postgres: `SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '2s';
        CREATE INDEX IF NOT EXISTS idx_pages_projection_pending
        ON pages(source_id, page_kind, slug)
        WHERE deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision;`,
  },
};
