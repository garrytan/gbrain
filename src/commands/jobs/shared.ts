/**
 * Argument parsing, formatting and context shared by the `gbrain jobs`
 * subcommand modules (moved out of src/commands/jobs.ts, which re-exports the
 * public helpers).
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { MinionQueue } from '../../core/minions/queue.ts';
import type { MinionJob } from '../../core/minions/types.ts';
import type { OperationError } from '../../core/ops/contract.ts';
import type { SelectionSummary } from '../../core/minions/legacy-selection.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { parseNiceValue } from '../../core/minions/niceness.ts';
import { defaultTimeoutMsFor, defaultLockDurationMsFor } from '../../core/minions/handler-timeouts.ts';

/** What runJobs hands every subcommand. `engine` is `engineOrNull` narrowed; only the thin-client `list`/`get` and local `supervisor status` paths see null. */
export interface JobsCommandContext {
  args: string[];
  engine: BrainEngine;
  engineOrNull: BrainEngine | null;
  queue: MinionQueue;
}


export function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Parse `--max-waiting N` from CLI args. Returns undefined if absent.
 *  Throws on malformed input (caller should surface the error and exit).
 *  Clamps to [1, 100] to match the queue-layer clamp in MinionQueue.add.
 *  Exported for unit tests; the CLI handler at `jobs submit` wraps this
 *  with process.exit(1) on throw so operators see 'must be positive integer'. */
export function parseMaxWaitingFlag(args: string[]): number | undefined {
  const raw = parseFlag(args, '--max-waiting');
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('--max-waiting must be a positive integer (will be clamped to [1, 100])');
  }
  return Math.max(1, Math.min(100, parsed));
}

/** Parse `--max-rss N` (MB). Returns:
 *  - undefined if the flag is absent (caller decides the default)
 *  - 0 if `--max-rss 0` (explicit disable)
 *  - the value if >= 256
 *  Errors and exits the process if the flag is non-numeric, negative, or
 *  positive but < 256 (likely a GB-vs-MB unit-confusion typo). */
export function parseMaxRssFlag(args: string[]): number | undefined {
  const raw = parseFlag(args, '--max-rss');
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Error: --max-rss must be a non-negative integer (MB), got "${raw}"`);
    process.exit(1);
  }
  if (parsed === 0) return 0;
  if (parsed < 256) {
    console.error(
      `Error: --max-rss ${parsed} is too low for production (likely a unit confusion: ` +
      `--max-rss takes megabytes, not gigabytes). Use --max-rss 0 to disable, ` +
      `or set a value >= 256.`
    );
    process.exit(1);
  }
  return parsed;
}

/** Parse `--nice N` (then `GBRAIN_NICE` env). Returns:
 *  - undefined if absent (no priority change — inherit)
 *  - the validated integer in [-20, 19] otherwise
 *  Errors and exits the process on non-integer / out-of-range input (mirrors
 *  parseMaxRssFlag's fail-fast). Flag wins over env. (issue #1815) */
export function parseNiceFlag(args: string[], env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = parseFlag(args, '--nice') ?? env.GBRAIN_NICE;
  if (raw === undefined || raw === '') return undefined;
  try {
    return parseNiceValue(raw);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function resolveWorkerConcurrency(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFlag(args, '--concurrency') ?? env.GBRAIN_WORKER_CONCURRENCY ?? '1';
  const parsed = parseInt(raw, 10);
  // Without validation, NaN / 0 / negative values flow through to the worker
  // loop where `inFlight.size < concurrency` is always false → the worker
  // claims zero jobs and the queue silently wedges. One typo in a systemd
  // unit reproduces the original production incident. Clamp to ≥1 and surface
  // the misconfig loudly so operators see it at worker startup.
  if (!Number.isFinite(parsed) || parsed < 1) {
    const source = parseFlag(args, '--concurrency') !== undefined
      ? '--concurrency flag'
      : 'GBRAIN_WORKER_CONCURRENCY env';
    process.stderr.write(
      `[gbrain jobs] invalid concurrency from ${source} (${JSON.stringify(raw)}); ` +
      `falling back to 1. Set a positive integer.\n`
    );
    return 1;
  }
  return parsed;
}

export type JobIsolationMode = 'inline' | 'process';

/**
 * issue #5: `--job-isolation <inline|process>` (space or `=` form), env
 * fallback GBRAIN_JOB_ISOLATION, default inline. `process` runs each claimed
 * job in a SIGKILL-able child process — blast radius 1 job instead of N.
 * Env injected as a param so tests never mutate process.env (rule R1).
 * Invalid values fail fast (parseMaxRssFlag convention).
 */
export function parseJobIsolationFlag(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): JobIsolationMode {
  let raw: string | undefined;
  const eqForm = args.find((a) => a.startsWith('--job-isolation='));
  if (eqForm !== undefined) raw = eqForm.slice('--job-isolation='.length);
  if (raw === undefined) raw = parseFlag(args, '--job-isolation');
  if (raw === undefined || raw === '') raw = env.GBRAIN_JOB_ISOLATION;
  if (raw === undefined || raw === '') return 'inline';
  if (raw === 'inline' || raw === 'process') return raw;
  console.error(
    `Error: invalid job isolation mode ${JSON.stringify(raw)}. Valid: inline, process.`,
  );
  process.exit(1);
}

/**
 * #3026: the thin-client `list`/`get` branches receive jobs as parsed JSON
 * off the MCP wire, where every timestamp is an ISO string — but formatJob /
 * formatJobDetail (and the stalled-detection comparison) hold a Date
 * contract, hydrated locally by MinionQueue.rowToJob. Rehydrate once at the
 * unpack boundary so both paths hand the formatters real Dates. Exported for
 * unit tests.
 */
const JOB_DATE_FIELDS = [
  'created_at', 'updated_at', 'started_at', 'finished_at', 'lock_until', 'delay_until',
  'timeout_at',
] as const;

export function rehydrateJobDates<T>(job: T): T {
  if (!job || typeof job !== 'object') return job;
  const rec = job as { [k: string]: unknown };
  for (const field of JOB_DATE_FIELDS) {
    const v = rec[field];
    if (typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) rec[field] = d;
    }
  }
  return job;
}

export function formatJob(job: MinionJob): string {
  const dur = job.finished_at && job.started_at
    ? `${((job.finished_at.getTime() - job.started_at.getTime()) / 1000).toFixed(1)}s`
    : '—';
  const stalled = job.status === 'active' && job.lock_until && job.lock_until < new Date()
    ? ' (stalled?)' : '';
  return `  ${String(job.id).padEnd(6)} ${job.name.padEnd(14)} ${(job.status + stalled).padEnd(20)} ${job.queue.padEnd(10)} ${dur.padEnd(8)} ${job.created_at.toISOString().slice(0, 19)}`;
}

/** Render a timestamp that is a Date locally but may arrive as an ISO string
 *  on the thin-client path against an OLDER server (rehydrateJobDates only
 *  converts fields it knows about; a field the peer predates stays a string).
 *  Never call .toISOString() unguarded on wire-shaped job fields. */
function formatWhen(v: Date | string | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? '');
}

/** The effective wall-clock budget line for `jobs get`. Wording matters: the
 *  1x deadline (handleTimeouts, stamped at claim) is the NORMAL kill; the 2x
 *  wall-clock sweep is the lock-state-agnostic backstop. */
function formatTimeoutLines(job: MinionJob): string[] {
  const lines: string[] = [];
  if (job.timeout_ms != null) {
    lines.push(`  Timeout: ${job.timeout_ms}ms (deadline kill at 1x when claimed; wall-clock backstop at 2x)`);
    if (job.timeout_at) lines.push(`  Deadline: ${formatWhen(job.timeout_at)}`);
  } else {
    const d = defaultTimeoutMsFor(job.name);
    if (d != null) {
      lines.push(`  Timeout: (unset) — handler default ${d}ms stamps at claim`);
    } else {
      lines.push(`  Timeout: (unset) — null-default wall-clock sweep applies (2 x lock lease x max_stalled, ~5m at 30s-lease defaults)`);
    }
  }
  // #4145: the lock lease line mirrors the timeout line — row value when
  // stamped, otherwise the handler-map default that WILL stamp at claim.
  if (job.lock_duration_ms != null) {
    lines.push(`  Lock lease: ${job.lock_duration_ms}ms (renewed at min(lease/2, 60s) cadence)`);
  } else {
    const lease = defaultLockDurationMsFor(job.name);
    if (lease != null) {
      lines.push(`  Lock lease: (unset) — handler default ${lease}ms stamps at claim`);
    }
  }
  return lines;
}

export function formatJobDetail(job: MinionJob): string {
  const lines = [
    `Job #${job.id}: ${job.name} (${job.status.toUpperCase()}${job.status === 'dead' ? ` after ${job.attempts_made} attempts` : ''})`,
    `  Queue: ${job.queue} | Priority: ${job.priority}`,
    `  Attempts: ${job.attempts_made}/${job.max_attempts} (started: ${job.attempts_started}, stalled: ${job.stalled_counter}/${job.max_stalled})`,
    `  Backoff: ${job.backoff_type} ${job.backoff_delay}ms (jitter: ${job.backoff_jitter})`,
    ...formatTimeoutLines(job),
  ];
  if (job.started_at) lines.push(`  Started: ${job.started_at.toISOString()}`);
  if (job.finished_at) lines.push(`  Finished: ${job.finished_at.toISOString()}`);
  if (job.lock_token) lines.push(`  Lock: ${job.lock_token} (until ${job.lock_until?.toISOString()})`);
  if (job.delay_until) lines.push(`  Delayed until: ${job.delay_until.toISOString()}`);
  if (job.parent_job_id) lines.push(`  Parent: job #${job.parent_job_id} (on_child_fail: ${job.on_child_fail})`);
  if (job.error_text) lines.push(`  Error: ${job.error_text}`);
  if (job.stacktrace.length > 0) {
    lines.push(`  History:`);
    for (const entry of job.stacktrace) lines.push(`    - ${entry}`);
  }
  if (job.progress != null) lines.push(`  Progress: ${JSON.stringify(job.progress)}`);
  if (job.result != null) lines.push(`  Result: ${JSON.stringify(job.result)}`);
  lines.push(`  Data: ${JSON.stringify(job.data)}`);
  return lines.join('\n');
}

/** Renders a coded jobs refusal: the `toJSON()` envelope on stdout with --json, the human lines on stderr, exit 1. */
export function reportJobsError(error: OperationError, json: boolean): void {
  if (json) console.log(JSON.stringify(error.toJSON(), null, 2));
  console.error(`Error [${error.code}]: ${error.message}`);
  if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
  if (error.docs) console.error(`Docs: ${error.docs}`);
  setCliExitVerdict(1);
}

/** Handlers outside the gateway-refresh set that can still spend: embedding by default, or the subagent and optimizer loops. */
const OTHER_PAID_JOB_NAMES = new Set(['subagent', 'skillopt', 'import', 'reindex', 'sync', 'ingest_capture']);

/** Job names whose handlers can make paid model-provider calls (DX-O3(d) marks them in a legacy preview). */
export async function paidJobNames(names: Iterable<string>): Promise<string[]> {
  const { GATEWAY_REFRESH_JOB_NAMES } = await import('../jobs.ts');
  return [...new Set(names)].filter(name => GATEWAY_REFRESH_JOB_NAMES.has(name) || OTHER_PAID_JOB_NAMES.has(name)).sort();
}

/** DX-O3(d) human preview lines: counts by job name and status, the first 20 ids, paid markers. */
export function selectionSummaryLines(summary: SelectionSummary, paid: readonly string[]): string[] {
  const lines = Object.entries(summary.by_name).sort(([a], [b]) => a.localeCompare(b)).map(([name, counts]) =>
    `  ${name}: ${Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(', ')}${paid.includes(name) ? '  [may make paid provider calls]' : ''}`);
  if (summary.total) lines.push(`  First ${summary.first_ids.length} ids: ${summary.first_ids.join(', ')}${summary.total > summary.first_ids.length ? ' …' : ''}`);
  return lines;
}
