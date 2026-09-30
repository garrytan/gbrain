// Guard self-test fixture (known-BAD, refactor wave 1 module dir): template-
// interpolated stringify into a direct ::jsonb cast inside a new module dir.
declare const sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;
declare const obj: { get: () => unknown };
export async function bad(): Promise<void> {
  await sql`UPDATE pages SET frontmatter = ${JSON.stringify(obj.get())}::jsonb WHERE id = 1`;
}
