import type { BrainEngine } from './engine.ts';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

type SignalProcess = Pick<NodeJS.Process, 'on' | 'removeListener'>;

export interface SignalShutdownOptions {
  process?: SignalProcess;
  exit?: (code: number) => never;
  log?: (message: string) => void;
}

export function signalExitCode(signal: ShutdownSignal): number {
  return signal === 'SIGINT' ? 130 : 143;
}

/**
 * Install CLI-level signal cleanup for DB-backed commands.
 *
 * Plain `finally { engine.disconnect() }` is not enough for SIGTERM/SIGINT:
 * once a process-level signal handler exists elsewhere (for example progress
 * reporting), the default process termination path no longer guarantees that
 * finally blocks run before an external supervisor escalates to SIGKILL.
 */
export function installEngineSignalShutdown(
  engine: Pick<BrainEngine, 'disconnect'>,
  opts: SignalShutdownOptions = {},
): () => void {
  const target = opts.process ?? process;
  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  const log = opts.log ?? ((message: string) => console.error(message));

  let shuttingDown = false;
  let uninstalled = false;

  const uninstall = () => {
    if (uninstalled) return;
    uninstalled = true;
    target.removeListener('SIGINT', onSigint);
    target.removeListener('SIGTERM', onSigterm);
  };

  const shutdown = (signal: ShutdownSignal) => {
    const code = signalExitCode(signal);
    if (shuttingDown) {
      exit(code);
      return;
    }
    shuttingDown = true;

    void (async () => {
      try {
        await engine.disconnect();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[gbrain] ${signal}: engine disconnect failed during shutdown: ${msg}`);
      } finally {
        uninstall();
        exit(code);
      }
    })();
  };

  const onSigint = () => shutdown('SIGINT');
  const onSigterm = () => shutdown('SIGTERM');

  target.on('SIGINT', onSigint);
  target.on('SIGTERM', onSigterm);

  return uninstall;
}
