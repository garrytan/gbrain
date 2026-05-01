import type { BrainEngine } from './engine.ts';

let installed = false;
let shuttingDown = false;

/**
 * Install signal + stdin-EOF handlers that disconnect the engine before exit.
 *
 * Without this, an ungraceful exit (Ctrl-C, SIGTERM from the MCP host shutting
 * down, OOM, etc.) skips PGLite's db.close(), leaving Postgres WAL mid-write.
 * That state is unrecoverable by PGLite itself — next open produces:
 *   PANIC: could not locate a valid checkpoint record
 * and requires `gbrain recover-wal` (pg_resetwal in a docker container).
 *
 * Idempotent: safe to call from multiple commands; only the first call wires
 * handlers.
 */
export function installShutdownHandlers(engine: BrainEngine): void {
  if (installed) return;
  installed = true;

  const shutdown = async (signal: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await engine.disconnect();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[shutdown] disconnect failed on ${signal}: ${msg}\n`);
    } finally {
      process.exit(exitCode);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.on('SIGINT',  () => { void shutdown('SIGINT', 130); });
  process.on('SIGHUP',  () => { void shutdown('SIGHUP', 129); });

  // MCP host (Claude Code, etc.) closes stdin = clean disconnect signal.
  // Critical for `gbrain serve` — that's the most common death case.
  process.stdin.on('end', () => { void shutdown('stdin-EOF', 0); });
}

/**
 * Test-only: reset module state between test cases. Not exported to consumers
 * via barrel files; only the test suite imports it directly.
 */
export function _resetForTesting(): void {
  installed = false;
  shuttingDown = false;
}
