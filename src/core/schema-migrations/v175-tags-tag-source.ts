import type { Migration } from './types.ts';

export const v175: Migration = {
  // Frontmatter tags were add-only because a tag row carried no provenance:
  // removing a tag from frontmatter never removed it. The importer stamps
  // 'frontmatter' and deletes only those rows; explicit adds stamp 'added'
  // and legacy rows stay NULL — neither is ever deleted by an import.
  version: 175,
  name: 'tags_tag_source',
  idempotent: true,
  sql: `ALTER TABLE tags ADD COLUMN IF NOT EXISTS tag_source TEXT;`,
};
