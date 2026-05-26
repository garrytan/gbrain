/**
 * v0.41.8.0 — narrow force-exit gate for the cli.ts op-dispatch finally.
 *
 * The cli.ts caller fires `process.exit(0)` ONLY when:
 *   1. The op-dispatch drain timed out (drainResult.outcome === 'timeout')
 *   2. AND this function returns true (i.e. the command is NOT a daemon)
 *
 * The function lives in its own module — not inline in cli.ts — so tests
 * can import + drive it without triggering cli.ts's top-level main() side
 * effect (cli.ts is a script entrypoint). Mirrors PR #1337's
 * `shouldForceExitAfterMain` guard, but narrower in scope: this wave
 * only force-exits after the drain timed out, NOT unconditionally for
 * every non-serve command.
 *
 * Daemon list is currently just `serve` (both stdio and HTTP forms use
 * the same command). If a future long-running command is added (e.g.
 * `gbrain watch` or `gbrain daemon`), add it here.
 */

const DAEMON_COMMANDS: ReadonlySet<string> = new Set(['serve']);

export function shouldForceExitAfterMain(
  argv: string[] = process.argv.slice(2),
): boolean {
  const command = argv.find((arg) => !arg.startsWith('-'));
  if (!command) return true;
  return !DAEMON_COMMANDS.has(command);
}
