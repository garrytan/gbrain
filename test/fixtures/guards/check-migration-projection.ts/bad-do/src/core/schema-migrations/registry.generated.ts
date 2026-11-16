// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'do_block', sql: 'DO $$ BEGIN UPDATE pages SET frontmatter = frontmatter || \'{}\'::jsonb; END $$;' },
];
