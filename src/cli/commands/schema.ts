/**
 * `gbrain schema`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

// Commands that don't need a database connection
export async function run(args: string[]): Promise<void> {
  const { runSchema } = await import('../../commands/schema.ts');
  await runSchema(args);
}
