// Guard self-test fixture (known-GOOD): the safe text-hop spelling — binds as
// text, the cast parses it (no direct )}::jsonb adjacency).
declare const sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;
declare const obj: { get: () => unknown };
export async function good(): Promise<void> {
  await sql`UPDATE pages SET frontmatter = ${JSON.stringify(obj.get())}::text::jsonb WHERE id = 1`;
}

// Multi-interpolation line: a SAFE ::text::jsonb stringify followed by a
// separate paren-bearing non-stringify ::jsonb interpolation on the SAME
// line. A greedy argument matcher spans from stringify( to the second
// interpolation's `)}::jsonb` and false-positives; the bracket-bounded
// pattern must not (ship-review edge case, proven by repro).
declare function getRaw(): unknown;
export async function goodMultiInterpolation(): Promise<void> {
  await sql`UPDATE pages SET a = ${JSON.stringify(obj.get())}::text::jsonb, b = ${getRaw()}::jsonb WHERE id = 2`;
}
