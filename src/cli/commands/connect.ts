/**
 * `gbrain connect`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

export async function run(args: string[]): Promise<void> {
  // No local DB: connect generates/wires a Claude Code MCP connection to a
  // REMOTE gbrain over HTTP from a bearer token. Print mode touches nothing;
  // --install talks to the remote, not the local engine.
  const { runConnect } = await import('../../commands/connect.ts');
  await runConnect(args);
}
