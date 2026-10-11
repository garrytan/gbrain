import type { BrainEngine } from './engine.ts';

export const CLI_DISCONNECT_DEADLINE_MS = 10_000;

/** Packaged Windows PGLite can hang or crash inside db.close() after bulk writers. */
export const PGLITE_SKIP_CLOSE_COMMANDS: ReadonlySet<string> = new Set([
  'import',
  'embed',
  'dream',
  'sync',
  'extract',
  'models',
  'think',
  'sources',
]);

export interface CliDisconnectOptions {
  deadlineMs?: number;
  exitCode?: number;
  forceExit?: (code: number) => never | void;
  warn?: (message: string) => void;
}

type OneShotEngine = Pick<BrainEngine, 'disconnect'> & {
  kind?: BrainEngine['kind'];
};

function resolvedExitCode(options: CliDisconnectOptions): number {
  const rawExitCode = options.exitCode ?? process.exitCode ?? 0;
  return typeof rawExitCode === 'number' ? rawExitCode : Number.parseInt(String(rawExitCode), 10) || 0;
}

function flushStdioBestEffort(): void {
  try { process.stdout.write(''); } catch { /* ignore */ }
  try { process.stderr.write(''); } catch { /* ignore */ }
}

function forceProcessExit(code: number): void {
  const reallyExit = (process as NodeJS.Process & { reallyExit?: (exitCode?: number) => never }).reallyExit;
  if (typeof reallyExit === 'function') reallyExit.call(process, code);
  process.exit(code);
}

/**
 * Close a one-shot CLI engine without allowing a wedged PGLite close to keep
 * an already-completed command alive forever. The timeout is deliberately
 * installed only around disconnect, never around the import itself.
 *
 * Packaged Windows Bun can freeze the JS thread inside PGLite `db.close()`,
 * so a Promise.race timer never fires. Calling `db.close()` or dropping the
 * WASM handle before `process.exit` can also crash the child with a non-zero
 * Windows status. PGLite one-shot commands therefore flush stdio and exit
 * without touching the database handle; the lock file's dead PID is stale.
 */
export async function disconnectCliEngine(
  engine: OneShotEngine,
  command: string,
  options: CliDisconnectOptions = {},
): Promise<'disconnected' | 'forced_exit'> {
  const deadlineMs = options.deadlineMs ?? CLI_DISCONNECT_DEADLINE_MS;
  const forceExit = options.forceExit ?? forceProcessExit;
  const warn = options.warn ?? console.warn;
  const exitCode = resolvedExitCode(options);

  if (engine.kind === 'pglite' && PGLITE_SKIP_CLOSE_COMMANDS.has(command)) {
    // Never await stdout drain: a piped Admin parent can deadlock the callback
    // and the hang watchdog will SIGKILL, leaving PGLite locked for minutes.
    flushStdioBestEffort();
    forceExit(exitCode);
    return 'forced_exit';
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const outcome = await Promise.race([
    engine.disconnect().then(() => 'disconnected' as const),
    new Promise<'forced_exit'>((resolve) => {
      timer = setTimeout(() => resolve('forced_exit'), deadlineMs);
    }),
  ]);

  if (timer) clearTimeout(timer);
  if (outcome === 'forced_exit') {
    warn(`[cli] ${command} completed, but engine.disconnect() did not return within ${deadlineMs}ms - force-exiting`);
    forceExit(exitCode);
  }
  return outcome;
}
