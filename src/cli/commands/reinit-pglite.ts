/**
 * `gbrain reinit-pglite`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

// v0.37 fix wave (deferred TODO, shipped): one-command wipe-and-reinit.
// Spawns its own engine internally so no pre-bound engine needed.
export async function run(args: string[]): Promise<void> {
  const { runReinitPglite } = await import('../../commands/reinit-pglite.ts');
  await runReinitPglite(args);
}
