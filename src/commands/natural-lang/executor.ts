import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { ConsoleRun } from './types.ts';

// In-memory stores (module-level singletons, shared across all importers)
export const previews = new Map<string, import('./types.ts').IntentPreview>();
export const runs = new Map<string, ConsoleRun>();
const children = new Map<string, ChildProcess>();

export function sanitizeOutput(text: string): string {
  return text
    .replace(/(postgresql:\/\/[^:\s]+:)([^@\s]+)(@)/g, '$1***$3')
    .replace(/\b(gbrain_[A-Za-z0-9_-]{16,})\b/g, 'gbrain_***')
    .replace(/((?:api[_-]?key|token|secret|password|pwd)["']?\s*[:=]\s*["']?)([^"',\s]+)/gi, '$1***');
}

export function getRun(id: string): ConsoleRun | null {
  return runs.get(id) ?? null;
}

export function listRuns(): ConsoleRun[] {
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
    if (!child.killed) child.kill('SIGKILL');
  }, 3000).unref?.();
}

export async function cancelRun(id: string): Promise<ConsoleRun | null> {
  const run = runs.get(id);
  if (!run) return null;
  if (run.status !== 'running' && run.status !== 'queued') return run;

  run.status = 'cancelled';
  run.error = 'Run cancelled by admin user';
  run.completedAt = new Date().toISOString();
  run.durationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);

  const child = children.get(id);
  if (child) killProcessTree(child);
  return run;
}

export interface RunHooks {
  beforeSpawn?: () => Promise<void>;
  afterComplete?: () => Promise<void>;
}

export async function startRun(kind: string, command: string[], cwd: string, hooks?: RunHooks, timeoutMs?: number): Promise<ConsoleRun> {
  const id = randomUUID();
  const started = Date.now();
  const run: ConsoleRun = {
    id,
    kind,
    status: 'running',
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

  // PGLite lock coordination: release the engine lock before spawning a child
  // process so the child can acquire it; reconnect after the child completes.
  if (hooks?.beforeSpawn) {
    try {
      await hooks.beforeSpawn();
    } catch (e) {
      run.status = 'failed';
      run.error = sanitizeOutput(e instanceof Error ? e.message : String(e));
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - started;
      return run;
    }
  }

  const child = spawn(command[0], command.slice(1), {
    cwd,
    shell: false,
    windowsHide: true,
    env: process.env,
  });
  children.set(id, child);
  const cap = 120_000;
  const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
    run[key] = sanitizeOutput((run[key] + chunk.toString('utf8')).slice(-cap));
  };
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
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
  };

  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.on('error', (err) => {
    void finish(run.status === 'cancelled' ? 'cancelled' : 'failed', null, err.message);
  });
  child.on('close', (code) => {
    if (run.status === 'cancelled') {
      void finish('cancelled', code);
    } else {
      void finish(code === 0 ? 'completed' : 'failed', code);
    }
  });
  timeout = setTimeout(() => {
    if (run.status === 'running') {
      void finish('failed', null, 'Command timed out after ' + ((timeoutMs ?? 600000) / 1000 / 60).toFixed(0) + ' minutes');
      killProcessTree(child);
    }
  }, timeoutMs ?? 10 * 60 * 1000).unref?.();

  return run;
}
