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

const CANCEL_CONFIRM_TIMEOUT_MS = 15_000;
const CANCEL_CONFIRM_POLL_MS = 25;

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
  return [...runs.values()].sort((a, b) =>
    Date.parse(b.completedAt ?? b.startedAt) - Date.parse(a.completedAt ?? a.startedAt)
    || b.id.localeCompare(a.id),
  ).slice(0, 30);
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
    killer.on('close', (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
    });
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
  const deadline = Date.now() + CANCEL_CONFIRM_TIMEOUT_MS;
  while ((run.status === 'running' || run.status === 'queued') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, CANCEL_CONFIRM_POLL_MS));
  }
  if (run.status === 'running' || run.status === 'queued') {
    run.error = '取消指令已发出，但 Dream 子进程退出或数据库连接恢复尚未完成；任务仍标记为运行中，请勿把数据库视为已释放。';
  }
  return run;
}

export interface RunHooks {
  acquireExclusive?: () => Promise<() => void>;
  beforeSpawn?: () => Promise<void>;
  afterComplete?: () => Promise<void>;
  /** Capture a complete JSON stdout result before applying the bounded log tail. */
  captureJsonResult?: boolean;
  /**
   * Kill a child that already printed a finished-command result but has not
   * exited. Packaged PGLite CLI children can hang after embed JSON or
   * `Import complete` because disconnect never returns. Per-file import
   * imported/failed/skipped JSON is progress, not a finished command.
   * Default 15s.
   */
  hangAfterResultMs?: number;
}

export const CHILD_HANG_AFTER_RESULT_MS = 15_000;

const TERMINAL_RESULT_STATUSES = new Set([
  'ok',
  'clean',
  'partial',
  'failed',
  'error',
  'success',
  'completed',
  'imported',
]);

const SUCCESSFUL_TERMINAL_STATUSES = new Set([
  'ok',
  'clean',
  'partial',
  'success',
  'completed',
  'imported',
]);

function extractLastJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tryParse = (raw: string): unknown | null => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const lineStart = trimmed.lastIndexOf('\n{');
  if (lineStart >= 0) {
    const parsed = tryParse(trimmed.slice(lineStart + 1));
    if (parsed !== null) return parsed;
  }
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    const parsed = tryParse(trimmed.slice(firstBrace));
    if (parsed !== null) return parsed;
  }
  return null;
}

function isImportRunKind(kind?: string): boolean {
  return kind === 'import_path' || (typeof kind === 'string' && kind.startsWith('import_'));
}

function isImportSummaryResult(record: Record<string, unknown>): boolean {
  // Per-file progress always includes `path`. The folder/file command
  // summary is `{status, imported, skipped, errors, total_files, …}`.
  if (typeof record.path === 'string') return false;
  return 'total_files' in record
    || 'duration_s' in record
    || (
      typeof record.imported === 'number'
      && typeof record.skipped === 'number'
      && typeof record.errors === 'number'
    );
}

function isThinkTerminalResult(record: Record<string, unknown>): boolean {
  return typeof record.question === 'string'
    && typeof record.answer === 'string'
    && (typeof record.modelUsed === 'string' || typeof record.pagesGathered === 'number');
}

function isTerminalResultForRun(record: Record<string, unknown>, kind?: string): boolean {
  if (kind?.startsWith('dream_')) {
    // Dream may run import/embed internally. Their own terminal summaries are
    // intermediate results; only the root CycleReport completes the Dream run.
    return typeof record.schema_version === 'string' && Array.isArray(record.phases);
  }
  if (isImportRunKind(kind)) {
    // Folder import prints one imported/failed/skipped JSON per file. Those
    // are progress events; only Import complete / the final summary may arm
    // the hung-process watchdog.
    return isImportSummaryResult(record);
  }
  return true;
}

/** Detect a finished CLI JSON result on stdout or stderr, ignoring progress events. */
export function parseTerminalChildResult(output: string, kind?: string): { status: string } | null {
  if (!kind?.startsWith('dream_') && /\bImport complete\b/i.test(output)) return { status: 'ok' };
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(brace)) as { event?: unknown; status?: unknown };
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (typeof parsed.event === 'string') continue;
      if (typeof parsed.status !== 'string') continue;
      if (!TERMINAL_RESULT_STATUSES.has(parsed.status)) continue;
      if (!isTerminalResultForRun(parsed as Record<string, unknown>, kind)) continue;
      return { status: parsed.status };
    } catch {
      continue;
    }
  }
  const parsed = extractLastJsonObject(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.event === 'string') return null;
  if (kind === 'search_brain' && isThinkTerminalResult(record)) return { status: 'ok' };
  if (typeof record.status !== 'string') return null;
  if (!TERMINAL_RESULT_STATUSES.has(record.status)) return null;
  if (!isTerminalResultForRun(record, kind)) return null;
  return { status: record.status };
}

function resolveHangAfterResultMs(hooks?: RunHooks): number {
  return typeof hooks?.hangAfterResultMs === 'number' && hooks.hangAfterResultMs >= 0
    ? hooks.hangAfterResultMs
    : CHILD_HANG_AFTER_RESULT_MS;
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

export function resolveRunTimeoutMs(timeoutMs: number | null | undefined, kind?: string): number | null {
  if (timeoutMs === undefined && (kind === 'embed_stale' || kind === 'sync_source' || kind === 'sync_all')) return null;
  return timeoutMs === null ? null : timeoutMs ?? 6 * 60 * 60 * 1000;
}

export async function startRun(kind: string, command: string[], cwd: string, hooks?: RunHooks, timeoutMs?: number | null): Promise<ConsoleRun> {
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
        env: {
          ...process.env,
          // The parent is a desktop sidecar, but this child is the temporary
          // CLI owner of PGLite. Do not let the sidecar's fail-fast startup
          // policy or owner label leak into maintenance children.
          PMBRAIN_PGLITE_OWNER_TYPE: 'cli',
          PMBRAIN_PGLITE_LOCK_FAIL_FAST: '0',
        },
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
    const armHangWatchdog = () => {
      if (hangWatchdog || finished) return;
      const terminalOutput = kind.startsWith('dream_')
        ? run.stdout
        : `${run.stdout}\n${run.stderr}`;
      const terminal = parseTerminalChildResult(terminalOutput, kind);
      if (!terminal) return;
      hangWatchdog = setTimeout(() => {
        if (finished || run.status !== 'running') return;
        const latestOutput = kind.startsWith('dream_')
          ? run.stdout
          : `${run.stdout}\n${run.stderr}`;
        hungAfterResult = parseTerminalChildResult(latestOutput, kind) ?? terminal;
        run.stderr = sanitizeOutput(
          `${run.stderr}\n[admin] child printed a terminal JSON result but did not exit within ${hangMs}ms; force-killing\n`,
        );
        killProcessTree(child);
      }, hangMs);
    };
    const append = (key: 'stdout' | 'stderr', chunk: Buffer) => {
      if (key === 'stdout' && resultFd !== null) writeSync(resultFd, chunk);
      run[key] = sanitizeOutput((run[key] + chunk.toString('utf8')).slice(-cap));
      armHangWatchdog();
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
    let hangWatchdog: ReturnType<typeof setTimeout> | null = null;
    let timeoutError: string | null = null;
    let hungAfterResult: { status: string } | null = null;
    const hangMs = resolveHangAfterResultMs(hooks);
    const finish = async (status: ConsoleRun['status'], code: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (hangWatchdog) clearTimeout(hangWatchdog);
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
      } else if (hungAfterResult) {
        const success = SUCCESSFUL_TERMINAL_STATUSES.has(hungAfterResult.status);
        void finish(
          success ? 'completed' : 'failed',
          code,
          success ? undefined : `Command printed status ${hungAfterResult.status} but did not exit`,
        );
      } else {
        void finish(code === 0 ? 'completed' : 'failed', code);
      }
    });
    const effectiveTimeoutMs = resolveRunTimeoutMs(timeoutMs, kind);
    if (effectiveTimeoutMs !== null) {
      timeout = setTimeout(() => {
        if (run.status === 'running') {
          timeoutError = 'Command timed out after ' + (effectiveTimeoutMs / 1000 / 60).toFixed(0) + ' minutes';
          killProcessTree(child);
        }
      }, effectiveTimeoutMs);
      timeout.unref?.();
    }
  };

  if (hooks?.acquireExclusive) {
    void launch();
  } else {
    await launch();
  }

  return run;
}
