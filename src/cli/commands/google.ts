/**
 * `gbrain google`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

// Google connector credential flows (engine-free: vault-only; status
// best-effort spawns its own engine for the linked-sources section).
export async function run(args: string[]): Promise<void> {
  const { runGoogle } = await import('../../commands/google.ts');
  await runGoogle(args);
}
