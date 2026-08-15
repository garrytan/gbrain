// Guard self-test fixture (known-BAD): template-interpolated stringify into a
// direct ::jsonb cast, WITH nested parens (the pre-W0 regex hole).
declare const sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;
declare const obj: { get: () => unknown };
export async function bad(): Promise<void> {
  await sql`UPDATE pages SET frontmatter = ${JSON.stringify(obj.get())}::jsonb WHERE id = 1`;
}
