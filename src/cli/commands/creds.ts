/**
 * `gbrain creds`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

// Generic credential vault surface (engine-free).
export async function run(args: string[]): Promise<void> {
  const { runCreds } = await import('../../commands/creds.ts');
  await runCreds(args);
}
