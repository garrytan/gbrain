// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'move_body', sql: '', sqlFor: { postgres: 'UPDATE ONLY pages AS p SET (compiled_truth, timeline) = (p.timeline, p.compiled_truth);', pglite: 'SELECT 1;' } },
];
