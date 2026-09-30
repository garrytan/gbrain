// Guard self-test fixture (known-BAD): the shared engine SQL (refactor wave 1) dropping source_id.
declare const sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
export async function listPages(): Promise<unknown[]> {
  return sql`SELECT id, slug, type, title FROM pages ORDER BY slug`;
}
