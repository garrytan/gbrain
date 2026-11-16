// Fixture registry for scripts/check-migration-projection.ts.
export const MIGRATIONS = [
  { version: 1, name: 'retag', sql: '', handler: async (engine: { executeRaw(sql: string): Promise<unknown> }) => { await engine.executeRaw('INSERT INTO tags(page_id, tag) SELECT id, \'x\' FROM pages'); } },
];
