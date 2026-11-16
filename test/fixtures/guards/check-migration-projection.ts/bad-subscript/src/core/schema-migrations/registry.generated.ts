// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'frontmatter_key', sql: `UPDATE pages SET frontmatter['k'] = '"v"';` },
];
