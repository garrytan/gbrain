/**
 * `gbrain mounts`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  // No DB needed: mounts.json is a local config file. Registry will
  // connect mount engines lazily on first use by op dispatch.
  const { runMounts } = await import('../../commands/mounts.ts');
  await runMounts(args);
}
