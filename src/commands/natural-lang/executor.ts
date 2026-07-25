import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { ConsoleRun } from './types.ts';

// In-memory stores (module-level singletons, shared across all importers)
export const previews = new Map<string, import('./types.ts').IntentPreview>();
export const runs = new Map<string, ConsoleRun>();
const children = new Map<string, ChildProcess>();
const cancelRequested = new Set<string>();

export const MAX_STORED_RUNS = 100;
export const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;

export class PgliteRunCoordinator {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}

function pruneRuns(now = Date.now()): void {
  const terminal = [...runs.values()]
    .filter(run => run.status !== 'running' && run.status !== 'queued')
    .sort((a, b) => Date.parse(b.completedAt ?? b.startedAt) - Date.parse(a.completedAt ?? a.startedAt));

  for (const run of terminal) {
    const completedAt = Date.parse(run.completedAt ?? run.startedAt);
    if (Number.isFinite(completedAt) && now - completedAt > RUN_RETENTION_MS) {
      runs.delete(run.id);
    }
  }

  const retainedTerminal = terminal.filter(run => runs.has(run.id));
  for (const run of retainedTerminal.slice(MAX_STORED_RUNS)) {
    runs.delete(run.id);
  }
}

export function sanitizeOutput(text: string): string {
  return text
    .replace(/(postgresql:\/\/[^:\s]+:)([^@\s]+)(@)/g, '$1***$3')
    .replace(/\b(gbrain_[A-Za-z0-9_-]{16,})\b/g, 'gbrain_***')
    .replace(/((?:api[_-]?key|token|secret|password|pwd)["']?\s*[:=]\s*["']?)([^"',\s]+)/gi, '$1***');
}

export function getRun(id: string): ConsoleRun | null {
  pruneRuns();
  return runs.get(id) ?? null;
}

export function listRuns(): ConsoleRun[] {
  pruneRuns();
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 3000).unref?.();
}

export async function cancelRun(id: string): Promise<ConsoleRun | null> {
  const run = runs.get(id);
  if (!run) return null;
  if (run.status !== 'running' && run.status !== 'queued') return run;

  cancelRequested.add(id);
  run.error = 'Run cancelled by admin user';

  const child = children.get(id);
  if (child) {
    killProcessTree(child);
  } else if (run.status === 'queued') {
    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  }
  return run;
}

export interface RunHooks {
  acquireExclusive?: () => Promise<() => void>;
  beforeSpawn?: () => Promise<void>;
  afterComplete?: () => Promise<void>;
}

export async function startRun(kind: string, command: string[], cwd: string, hooks?: RunHooks, timeoutMs?: number): Promise<ConsoleRun> {
  const id = randomUUID();
  const started = Date.now();
  const run: ConsoleRun = {
    id,
    kind,
    status: hooks?.acquireExclusive ? 'queued' : 'running',
    command,
    stdout: '',
    stderr: '',
    exitCode: null,
    error: null,
    startedAt: new Date(started).toISOString(),
    completedAt: null,
    durationMs: null,
  };
  runs.set(id, run);
  pruneRuns();

  const launch = async () => {
    let releaseExclusive: (() => void) | null = null;
    let engineDisconnected = false;
    const completeWithoutChild = async (status: ConsoleRun['status'], error?: string) => {
      if (engineDisconnected && hooks?.afterComplete) {
        try {
          await hooks.afterComplete();
        } catch (hookError) {
          status = 'failed';
          error = hookError instanceof Error
            ? `Command did not start, and database reconnection failed: ${hookError.message}`
            : `Command did not start, and database reconnection failed: ${String(hookError)}`;
        }
      }
      if (error) run.error = sanitizeOutput(error);
      run.status = status;
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - started;
      cancelRequested.delete(id);
      releaseExclusive?.();
      pruneRuns();
    };

    try {
      releaseExclusive = await hooks?.acquireExclusive?.() ?? null;
      if (run.status === 'cancelled' || cancelRequested.has(id)) {
        await completeWithoutChild('cancelled', run.error ?? undefined);
        return;
      }
      run.status = 'running';

      // PGLite lock coordination: release the engine lock before spawning a
      // child process so the child can acquire it; reconnect only after the
      // child has fully exited.
      if (hooks?.beforeSpawn) {
        engineDisconnected = true;
        await hooks.beforeSpawn();
      }
      if (cancelRequested.has(id)) {
        await completeWithoutChild('cancelled', run.error ?? undefined);
        return;
      }
    } catch (e) {
      await completeWithoutChild('failed', e instanceof Error ? e.message : String(e));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        env: process.env,
      });
    } catch (e) {
      await completeWithoutChild('failed', e instanceof Error ? e.message : String(e));
      return;
    }
    children.set(id, child);
    const cap = 120_000;
    const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
      run[key] = sanitizeOutput((run[key] + chunk.toString('utf8')).slice(-cap));
    };
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timeoutError: string | null = null;
    const finish = async (status: ConsoleRun['status'], code: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      children.delete(id);
      run.exitCode = code;
      if (error) run.error = sanitizeOutput(error);
      if (hooks?.afterComplete) {
        try {
          await hooks.afterComplete();
        } catch (hookError) {
          status = 'failed';
          run.error = sanitizeOutput(
            hookError instanceof Error
              ? `Command finished, but database reconnection failed: ${hookError.message}`
              : `Command finished, but database reconnection failed: ${String(hookError)}`,
          );
        }
      }
      run.status = status;
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - started;
      cancelRequested.delete(id);
      releaseExclusive?.();
      pruneRuns();
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (err) => {
      void finish(cancelRequested.has(id) ? 'cancelled' : 'failed', null, err.message);
    });
    child.on('close', (code) => {
      if (cancelRequested.has(id)) {
        void finish('cancelled', code);
      } else if (timeoutError) {
        void finish('failed', code, timeoutError);
      } else {
        void finish(code === 0 ? 'completed' : 'failed', code);
      }
    });
    timeout = setTimeout(() => {
      if (run.status === 'running') {
        timeoutError = 'Command timed out after ' + ((timeoutMs ?? 600000) / 1000 / 60).toFixed(0) + ' minutes';
        killProcessTree(child);
      }
    }, timeoutMs ?? 10 * 60 * 1000).unref?.();
  };

  if (hooks?.acquireExclusive) {
    void launch();
  } else {
    await launch();
  }

  return run;
}
