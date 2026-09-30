/**
 * `gbrain cache`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  // v0.32.x search-lite: semantic query cache management. Dispatch the
  // subcommand handler (stats / clear / prune); the handler opens its
  // own engine connection.
  const { runCache } = await import('../../commands/cache.ts');
  await runCache(args);
}
