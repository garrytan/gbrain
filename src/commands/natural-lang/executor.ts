import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** Capture a complete JSON stdout result before applying the bounded log tail. */
  captureJsonResult?: boolean;
}

const DREAM_DETAIL_KEYS = new Set([
  'added', 'modified', 'deleted', 'failedFiles', 'fixed', 'issues',
  'linksCreated', 'timelineCreated', 'pagesScanned', 'factsInserted',
  'batches', 'pages_processed', 'proposals_inserted', 'cache_hits',
  'pages_failed', 'remaining', 'chunks_walked', 'edges_resolved',
  'edges_ambiguous', 'embedded', 'skipped', 'total_chunks',
  'total_orphans', 'total_pages', 'model_id', 'verdict_model_id',
  'input_tokens', 'output_tokens', 'dryRun', 'dry_run', 'pages_written',
  'transcripts_processed', 'transcripts_discovered', 'written_slugs',
  'duplicate_skips', 'child_outcomes', 'affected_slugs', 'concepts_written',
  'concept_slugs', 'failures', 'proposal_samples', 'duplicates_skipped',
  'stopped',
]);

function boundedDetailValue(key: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const limit = key === 'proposal_samples' || key === 'failures' ? 20 : 100;
  return value.slice(0, limit);
}

/** Convert the complete Dream JSON into the bounded result consumed by Admin. */
export function compactDreamResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  const phases = Array.isArray(report.phases)
    ? report.phases.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const phase = raw as Record<string, unknown>;
      const rawDetails = phase.details && typeof phase.details === 'object' && !Array.isArray(phase.details)
        ? phase.details as Record<string, unknown>
        : {};
      const details: Record<string, unknown> = {};
      for (const [key, detailValue] of Object.entries(rawDetails)) {
        if (DREAM_DETAIL_KEYS.has(key)) details[key] = boundedDetailValue(key, detailValue);
      }
      if (Array.isArray(rawDetails.errors)) details.errors_count = rawDetails.errors.length;
      if (
        typeof rawDetails.total_chunks === 'number'
        && typeof rawDetails.embedded === 'number'
      ) {
        details.pending = Math.max(0, rawDetails.total_chunks - rawDetails.embedded);
      }
      return {
        phase: phase.phase,
        status: phase.status,
        summary: phase.summary,
        error: phase.error,
        details,
        pagesAffected: Array.isArray(phase.pagesAffected) ? phase.pagesAffected.slice(0, 100) : undefined,
        pagesAffectedCount: Array.isArray(phase.pagesAffected) ? phase.pagesAffected.length : undefined,
      };
    }).filter(Boolean)
    : [];
  return {
    schema_version: report.schema_version,
    status: report.status,
    reason: report.reason,
    duration_ms: report.duration_ms,
    totals: report.totals,
    phases,
  };
}

export function parseCapturedDreamResult(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return compactDreamResult(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return compactDreamResult(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
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
    const resultDir = hooks?.captureJsonResult
      ? mkdtempSync(join(tmpdir(), 'pmbrain-admin-run-'))
      : null;
    const resultPath = resultDir ? join(resultDir, 'stdout.json') : null;
    let resultFd = resultPath ? openSync(resultPath, 'w') : null;
    const cap = 120_000;
    const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
      if (key === 'stdout' && resultFd !== null) writeSync(resultFd, chunk);
      run[key] = sanitizeOutput((run[key] + chunk.toString('utf8')).slice(-cap));
    };
    const captureResult = () => {
      if (resultFd !== null) {
        closeSync(resultFd);
        resultFd = null;
      }
      if (!resultPath || !resultDir) return;
      try {
        run.result = parseCapturedDreamResult(readFileSync(resultPath, 'utf8'));
      } catch {
        run.result = null;
      } finally {
        rmSync(resultDir, { recursive: true, force: true });
      }
    };
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timeoutError: string | null = null;
    const finish = async (status: ConsoleRun['status'], code: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      children.delete(id);
      captureResult();
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
