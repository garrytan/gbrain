/**
 * `gbrain import`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runImport, ImportAbortError } = await import('../../commands/import.ts');
  // v0.41 (Codex r2 #3 fix): honor errors counter for exit code.
  // runImport's per-file catch already records failures, but the
  // CLI was discarding the result so the process exited 0 even
  // when files failed (e.g. content-sanity hard-block throws,
  // size-cap throws, parse errors). Surface non-zero on errors > 0
  // so wrappers (sync, CI scripts, `&& gbrain doctor`) propagate.
  try {
    const importResult = await runImport(engine, args);
    if (importResult.errors > 0) {
      setCliExitVerdict(1);
    }
  } catch (e) {
    // W0 (Tier-1 #5): runImport throws typed aborts instead of
    // process.exit(1) so in-process callers (sync_brain MCP op,
    // autopilot, minion handler) survive a preflight failure. The CLI
    // keeps the exact pre-fix behavior: message already printed at the
    // throw site, exit non-zero here.
    if (e instanceof ImportAbortError) process.exit(e.exitCode);
    throw e;
  }
}
