/**
 * `gbrain frontmatter`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  const { runFrontmatter } = await import('../../commands/frontmatter.ts');
  await runFrontmatter(args);
}
