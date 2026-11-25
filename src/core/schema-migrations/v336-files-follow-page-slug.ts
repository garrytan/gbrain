import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// A page rename (updateSlug: sync renames, `gbrain repair rename-identity`) now moves the page's attachments
// (moveSlugBindings in page-state/rename-alias.ts). This one-time backfill moves the attachments a past rename left
// under an old slug: a files row bound to a live page (page_id) takes that page's slug. A row bound to a retired
// (soft-deleted) row keeps the name it is listed under, and a row that names no page has no owner to follow; both stay. Data only, no DDL; re-running changes nothing.
export const v336: Migration = {
  version: 336,
  name: 'files_follow_page_slug',
  idempotent: true,
  sql: `
    UPDATE files f SET page_slug = p.slug
      FROM pages p
     WHERE f.page_id = p.id AND f.source_id = p.source_id AND p.deleted_at IS NULL AND f.page_slug IS DISTINCT FROM p.slug;
  `,
};
