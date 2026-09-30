/**
 * `gbrain protocol`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */

// MEMORY_VERBS v1 (Cathedral 1): protocol introspection + conformance +
// local usage stats. No pre-bound engine — conformance spawns its own
// server; stats reads the local JSONL sidecar.
export async function run(args: string[]): Promise<void> {
  const { runProtocol } = await import('../../commands/protocol.ts');
  await runProtocol(args);
}
