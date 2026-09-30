// Guard self-test fixture (known-GOOD): the shared engine SQL keeps source_id.
declare const sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
export async function listPages(): Promise<unknown[]> {
  return sql`SELECT id, source_id, slug, type, title FROM pages ORDER BY slug`;
}
