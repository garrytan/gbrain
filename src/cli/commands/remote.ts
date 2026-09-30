/**
 * `gbrain remote`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  // Multi-topology v1 (Tier B): thin-client-only convenience commands.
  // `runRemote` self-checks for remote_mcp config and exits 1 if local-only.
  const { runRemote } = await import('../../commands/remote.ts');
  await runRemote(args);
}
