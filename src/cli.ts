#!/usr/bin/env bun
/**
 * gbrain CLI entry point (`bun src/cli.ts`, the `gbrain` bin, the compiled
 * binary). Runs the process-level setup, then answers the engine-free fast
 * paths (`--version`, `version`, bare `gbrain`, `--help`, `-h`) itself, or
 * loads the dispatcher (src/cli/main.ts) with a dynamic import. The dispatcher
 * pulls in every operation and command module, so the fast paths skip that
 * import graph entirely. Every static import here is paid by every invocation:
 * keep them light.
 */
import { VERSION } from './version.ts';
import { exitOnUnsupportedBun } from './core/runtime-version.ts';
import { installCleanupSignalHandlers } from './core/serve-invocation.ts';
import { shouldForceExitAfterMain, flushThenExit, currentExitCode, installStdoutPipeDelivery } from './core/cli-force-exit.ts';
import { agentJsonGuardMode } from './cli/json-guard.ts';
import { parseGlobalFlags } from './core/cli-options.ts';
import { runCliPreflight } from './core/cli-preflight.ts';
import { printHelp } from './cli/top-help.ts';

/**
 * The fast path main() would take for `argv`, or null when the dispatcher must
 * run. Mirrors main()'s first branches after global-flag parsing; a parse
 * error falls through so the dispatcher reports it exactly as before.
 */
export function cliFastPath(argv: string[]): 'help' | 'version' | null {
  let command: string | undefined;
  try {
    command = parseGlobalFlags(argv).rest[0];
  } catch {
    return null;
  }
  if (!command || command === '--help' || command === '-h') return 'help';
  if (command === '--version' || command === 'version') return 'version';
  return null;
}

async function runFastPath(path: 'help' | 'version'): Promise<void> {
  await runCliPreflight();
  if (path === 'help') printHelp();
  else console.log(`gbrain ${VERSION}`);
}

if (import.meta.main) {
  exitOnUnsupportedBun(process.argv[2], VERSION);
  // v0.41.6.0 D5: cleanup registry + signal handlers for SIGTERM/SIGHUP/SIGPIPE/
  // uncaughtException. NOT SIGINT (the existing AbortController path owns SIGINT).
  // Installed before main() so locks acquired during boot (e.g. connectEngine's
  // schema-probe path) are covered. Gated on import.meta.main — nothing at module
  // scope acquires locks, and installing at module load leaked a process-wide
  // SIGTERM→exit(143) handler into any process that merely IMPORTS this module
  // (bun test runners died mid-suite when a test emitted a synthetic SIGTERM).
  // Spawned/compiled CLI processes are entrypoints, so they still install.
  installCleanupSignalHandlers();
  // #4383: CLI_ONLY payloads (console.log / bare process.stdout.write) get
  // delivery-exact serialized writes; `serve` keeps native streaming stdout.
  if (shouldForceExitAfterMain()) installStdoutPipeDelivery(agentJsonGuardMode(process.argv.slice(2)));
  const fastPath = cliFastPath(process.argv.slice(2));
  if (fastPath) {
    runFastPath(fastPath).then(
      () => flushThenExit(currentExitCode()),
      async (e) => (await import('./cli/main.ts')).exitOnFatalCliError(e),
    );
  } else {
    void import('./cli/main.ts').then((m) => m.runCli());
  }
}
