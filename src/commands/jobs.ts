/**
 * CLI handler for `gbrain jobs` subcommands.
 * Thin wrapper around MinionQueue and MinionWorker.
 */

import type { BrainEngine } from '../core/engine.ts';
import type { FactsBackstopResult } from '../core/facts/backstop.ts';
// Leaf module (no flag surface of its own) — see that file for why this
// isn't imported from extract-conversation-facts.ts directly (#4135).
import { ALLOWED_TYPES, type AllowedType } from '../core/facts/conversation-types.ts';
import { assertEmbedNotStalled } from '../core/embed-stall.ts';
import { assertEmbedBackfillQueueAdmission } from '../core/minions/embed-backfill-admission.ts';
import { isProtectedJobName } from '../core/minions/protected-names.ts';
import { MinionQueue, deriveWedgeSignal } from '../core/minions/queue.ts';
import { MinionWorker } from '../core/minions/worker.ts';
import {
  WORKER_EXIT_RSS_WATCHDOG,
  JOB_CHILD_EXIT_USAGE,
} from '../core/minions/worker-exit-codes.ts';
import { CHILD_ENV, resolveChildCliInvocation } from '../core/minions/job-isolation.ts';
import { withFactsAbsorbHaltCooldown } from '../core/minions/llm-halt-cooldown.ts';
import { runChildJobEntry } from '../core/minions/run-child.ts';
import type { MinionHandler, MinionJob, MinionJobStatus } from '../core/minions/types.ts';
import type { PaceKeyOverrides } from '../core/pace-mode.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { parseNiceValue, applyNiceness, getEffectiveNiceness, formatNice } from '../core/minions/niceness.ts';
import { defaultTimeoutMsFor, defaultLockDurationMsFor, clampLockDurationMs } from '../core/minions/handler-timeouts.ts';

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Resolve the canonical positive-polarity pull flag while preserving queued
 * jobs that still carry the legacy inverse `noPull` key.
 */
export function resolveJobPull(data: Record<string, unknown>): boolean {
  if (typeof data.pull === 'boolean') return data.pull;
  if (typeof data.noPull === 'boolean') return !data.noPull;
  return true;
}

/**
 * Long-lived workers outlive operator config changes. Re-stamp the AI gateway
 * from DB-backed model config immediately before queued jobs enter gateway-backed
 * paths, so a stale process-level default cannot route new work to the wrong
 * provider.
 *
 * Three staleness tiers (documented in KEY_FILES's refreshGatewayForJob entry):
 *   - DB-plane model config: re-resolved here (reconfigureGatewayWithEngine).
 *   - FILE-plane config (`~/.gbrain/config.json` — incl. provider API keys):
 *     re-folded here, so a key added to config.json reaches the worker at the
 *     next job. NOTE `gbrain config set *_api_key` writes the DB plane, which
 *     loadConfigWithEngine deliberately never merges for key fields — routing
 *     those writes to the file plane is a filed TODO.
 *   - True process env vars: fixed at worker start; need a restart.
 */
export async function refreshGatewayForJob(engine: BrainEngine): Promise<void> {
  // Env-only refresh: a full configureGateway(buildGatewayConfig(loadConfig()))
  // would clobber the DB-plane-merged fields the worker's boot fold installed
  // (provider_base_urls, chat options, …) with file-plane-only values.
  const { refreshGatewayEnvFromFilePlane, reconfigureGatewayWithEngine } = await import('../core/ai/gateway.ts');
  refreshGatewayEnvFromFilePlane();
  await reconfigureGatewayWithEngine(engine);
}

/** Shared predicate: an inline result reporting execution-time unavailability. */
export function factsAbsorbUnavailable(result: FactsBackstopResult): boolean {
  return (
    result.mode === 'inline' &&
    (result.skipped === 'extraction_unavailable' || result.skipped_reason === 'chat_unavailable')
  );
}

/**
 * The facts-absorb retry decision (@internal exported for tests). A job that
 * finds chat unavailable at EXECUTION in a KEYED worker is config drift — it
 * must throw (retry/backoff → visible, re-runnable failure), never return
 * success and silently consume the job. A KEYLESS worker executing a job
 * enqueued by some other process is the steady expected state — completing
 * as a calm skip (the execution-time gate already printed the keyless note)
 * beats a retry loop that parks every page write as a failed job.
 */
export function factsAbsorbShouldRetry(
  result: FactsBackstopResult,
  classification: 'keyed' | 'keyless',
): boolean {
  return classification === 'keyed' && factsAbsorbUnavailable(result);
}

// Job names whose handlers call the LLM gateway: registerBuiltinJob wraps
// them with refreshGatewayForJob so file-plane keys + DB-plane model config
// reach a long-lived worker. Drift guard: test/jobs-gateway-refresh-set.test.ts
// pins this set against the registerBuiltinJob call sites — a gateway-using
// handler registered via bare worker.register() runs with a stale gateway
// (the #3387 chronicle_extract silent-no_events class).
const GATEWAY_REFRESH_JOB_NAMES = new Set([
  'embed',
  'extract-conversation-facts',
  'enrich',
  'facts-absorb',
  'contextual_reindex_per_chunk',
  'autopilot-cycle',
  'synthesize',
  'patterns',
  'consolidate',
  'extract_facts',
  'extract-atoms-drain',
  'embed-backfill',
  // connector-sync's PGLite embed kickoff calls runEmbedCore inline (the
  // embedding gateway), so it must see a refreshed gateway config like the
  // other embed jobs — otherwise a worker booted before `config set` embeds
  // nothing on the catch-up.
  'connector-sync',
  'extract-takes-from-pages',
  'embed-catch-up',
  // #3387: chronicle_extract's judge is a gateway chat call — without the
  // refresh a worker booted before `config set` never saw the DB-plane chat
  // model and every extraction silently returned no_events.
  'chronicle_extract',
  // Open-loop commitment extraction (google source kind): same judge shape
  // as chronicle_extract, same stale-gateway failure class.
  'loops_extract',
]);

function registerBuiltinJob(
  worker: MinionWorker,
  engine: BrainEngine,
  name: string,
  handler: MinionHandler,
): void {
  if (!GATEWAY_REFRESH_JOB_NAMES.has(name)) {
    worker.register(name, handler);
    return;
  }
  worker.register(name, async (job) => {
    await refreshGatewayForJob(engine);
    return await handler(job);
  });
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

function formatJob(job: MinionJob): string {
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

/**
 * The full jobs help block. Hoisted to a constant so `gbrain jobs --help`
 * (routed engine-free via cli.ts SELF_HELP_WITHOUT_ENGINE) and bare
 * `gbrain jobs` print the same text. Issue: jobs --help used to print the
 * generic CLI stub because 'jobs' was missing from CLI_ONLY_SELF_HELP.
 */
const JOBS_HELP = `gbrain jobs — Minions job queue

USAGE
  gbrain jobs submit <name> [--params JSON] [--follow] [--priority N]
                            [--delay Nms] [--max-attempts N] [--max-stalled N]
                            [--max-waiting N]
                            [--backoff-type fixed|exponential] [--backoff-delay Nms]
                            [--backoff-jitter 0..1] [--timeout-ms Nms]
                            [--lock-duration-ms Nms]
                            [--idempotency-key K] [--queue Q] [--dry-run]
                            [--redact-secrets]   (shell only; scrubs inherit
                                                  values from stdout/stderr)
  gbrain jobs list [--status S] [--queue Q] [--limit N] [--json]
  gbrain jobs get <id> [--json]
  gbrain jobs cancel <id>
  gbrain jobs retry <id>
  gbrain jobs prune [--older-than 30d] [--dry-run]
  gbrain jobs delete <id>
  gbrain jobs stats [--queue Q] [--cluster-errors] [--json]
                    (dream-inline-* queues report ABANDONED/live only with an
                     explicit --queue; use \`gbrain doctor\` to discover them)
  gbrain jobs smoke [--sigkill-rescue] [--wedge-rescue]
  gbrain jobs watch [--json] [--follow] [--refresh-ms=N]
  gbrain jobs work [--queue Q] [--concurrency N] [--max-rss MB]
                   [--health-interval MS] [--nice N]
                   [--job-isolation inline|process]
  gbrain jobs supervisor [start] [--detach] [--json]
                         [--concurrency N] [--queue Q] [--pid-file PATH]
                         [--max-crashes N] [--health-interval N]
                         [--allow-shell-jobs] [--cli-path PATH]
                         [--max-rss MB] [--nice N]
                         [--job-isolation inline|process]

    --nice N   OS scheduling priority, -20 (highest) to 19 (nicest). Lowers CPU
               priority without cutting concurrency — full throughput when the
               box is idle, yields to foreground work when it's busy. Propagates
               to spawned workers and their children. Env: GBRAIN_NICE (flag
               wins). Effective value shows in 'jobs stats' and 'gbrain doctor'.
               Negative values need root.
  gbrain jobs supervisor status [--json] [--pid-file PATH]
  gbrain jobs supervisor stop [--json] [--pid-file PATH]

    Auto-restarting wrapper around 'gbrain jobs work'. Spawns the worker
    as a child process and restarts on crash with exponential backoff
    (1s -> 60s cap). Writes a brain-scoped PID file to
    ~/.gbrain/supervisor-<brain-id>.pid by default (override via
    --pid-file or GBRAIN_SUPERVISOR_PID_FILE env).
    Lifecycle events are appended to
      \${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-YYYY-Www.jsonl

    SUBCOMMANDS
      start        (default) Launch the supervisor. --detach returns a
                   JSON {event, supervisor_pid, pid_file} payload on
                   stdout and forks; omit for foreground.
      status       Read PID file + audit log, report running / last_start
                   / crashes_24h / max_crashes_exceeded as JSON or human.
                   Exits 0 if running, 1 if not.
      stop         Send SIGTERM to the supervisor, wait up to 40s for
                   graceful drain, report outcome. Exits 0 on clean stop.

    EXIT CODES (start)
      0  clean shutdown (SIGTERM/SIGINT received, worker drained)
      1  max crashes exceeded (worker kept dying)
      2  another supervisor holds the PID lock
      3  PID file unwritable (permission / path error)

    EXAMPLES
      gbrain jobs supervisor --concurrency 4         # foreground (Ctrl-C stops)
      gbrain jobs supervisor start --detach --json   # agent-friendly: fork + return JSON
      gbrain jobs supervisor status --json           # machine-readable health check
      gbrain jobs supervisor stop                    # graceful stop
      gbrain jobs supervisor --json --allow-shell-jobs  # JSONL events + shell-exec on

HANDLER TYPES (built in)
  sync              Pull and embed new pages from the repo
  embed             (Re-)embed pages; --params '{"slug":...}' or '{"all":true}'
  lint              Run page linter; --params '{"dir":"...","fix":true}'
  import            Bulk import markdown; --params '{"dir":"..."}'
  extract           Extract links + timeline entries; '{"mode":"all"}'
  backlinks         Check or fix back-links; '{"action":"fix"}'
  autopilot-cycle   One autopilot pass (sync+extract+embed+backlinks)
  shell             Run a command or argv. Requires GBRAIN_ALLOW_SHELL_JOBS=1
                    on the worker. Params: {cmd?, argv?, cwd, env?}.
                    See: docs/guides/minions-shell-jobs.md

Detailed help: gbrain jobs {work|supervisor|submit|watch|prune} --help
Other subcommands are fully described above.
`;

/**
 * Per-subcommand help for the flag-heavy / side-effectful subcommands.
 * Pattern from bootstrap.ts SUBCOMMAND_HELP: the guard below prints these
 * BEFORE the switch, so \`jobs work --help\` can never start a worker
 * daemon (the defect class this record exists to prevent). Subcommands
 * without an entry fall back to JOBS_HELP, which documents them fully.
 */
const JOBS_SUBCOMMAND_HELP: Record<string, string> = {
  work: `gbrain jobs work — start a worker daemon (Postgres only)

USAGE
  gbrain jobs work [--queue Q] [--concurrency N] [--max-rss MB]
                   [--health-interval MS] [--nice N]
                   [--job-isolation inline|process]

OPTIONS
  --queue Q            Queue to claim from (default: default)
  --job-isolation M    inline (default): handlers run in the worker process.
                       process: each claimed job runs in its own child
                       process — a stuck handler is group-SIGKILLed instead
                       of abandoned, and a crash takes one job, not all N.
                       Env fallback: GBRAIN_JOB_ISOLATION. Recommended for
                       long-running LLM-bound handlers (subagent). Note:
                       --max-rss then covers the worker only, and each child
                       adds ~4 pooler client connections.
  --concurrency N      Max jobs in flight. Resolution: flag, then
                       GBRAIN_WORKER_CONCURRENCY env, then 1. Values < 1
                       are clamped to 1 with a loud stderr note.
  --max-rss MB         RSS watchdog. Absent: auto-sized to 50% of
                       min(cgroup limit, host RAM), capped at 16384 MB,
                       raised to a 4096 MB floor when the basis allows.
                       0 disables the watchdog. Values 1-255 are rejected
                       (megabytes, not gigabytes — unit-confusion guard).
  --health-interval MS Health probe cadence (default 60000). 0 disables.
                       Values 1-999 are rejected as unit confusion.
                       Under GBRAIN_SUPERVISED=1 stall detection is off;
                       the DB probe stays.
  --nice N             OS scheduling priority, -20 (highest) to 19
                       (nicest). Env fallback: GBRAIN_NICE; flag wins.
                       Negative values need root.

NOTES
  Requires the Postgres engine — PGLite's exclusive file lock cannot host
  a long-lived daemon. For crash-resilient operation prefer:
    gbrain jobs supervisor start --detach --json
`,
  supervisor: `gbrain jobs supervisor — auto-restarting wrapper around 'gbrain jobs work'

USAGE
  gbrain jobs supervisor [start] [--detach] [--json]
                         [--concurrency N] [--queue Q] [--pid-file PATH]
                         [--max-crashes N] [--health-interval N]
                         [--allow-shell-jobs] [--cli-path PATH]
                         [--max-rss MB] [--nice N]
                         [--job-isolation inline|process]
  gbrain jobs supervisor status [--json] [--pid-file PATH]
  gbrain jobs supervisor stop [--json] [--pid-file PATH]

OPTIONS (start)
  --detach             Fork and print {event, supervisor_pid, pid_file} JSON
  --json               JSONL lifecycle events on stdout
  --concurrency N      Worker concurrency (default 2)
  --queue Q            Queue to claim from (default: default)
  --pid-file PATH      PID file (default: brain-scoped
                       ~/.gbrain/supervisor-<brain-id>.pid;
                       env GBRAIN_SUPERVISOR_PID_FILE)
  --max-crashes N      Soft crash threshold (default 10): past N crashes in
                       24h the supervisor reports degraded and keeps backing
                       off. It only STOPS permanently at the hard ceiling —
                       default 10 x N; override or disable (0 = never) via
                       GBRAIN_SUPERVISOR_HARD_STOP_CRASHES.
  --health-interval N  Worker health probe cadence in ms
  --allow-shell-jobs   Enable the shell handler on the spawned worker
  --cli-path PATH      Explicit gbrain binary for the worker child
  --max-rss MB         RSS watchdog for the worker (same rules as jobs work)
  --nice N             OS priority for supervisor + worker children
  --job-isolation M    Passed through to the worker (see jobs work --help)

EXIT CODES (start)
  0 clean shutdown   1 max crashes exceeded
  2 another supervisor holds the PID lock   3 PID file unwritable
  4 DB queue lock lost (repeated refresh failures; restart re-acquires)
`,
  submit: `gbrain jobs submit — enqueue a background job

USAGE
  gbrain jobs submit <name> [--params JSON] [--follow] [--priority N]
                            [--delay Nms] [--max-attempts N] [--max-stalled N]
                            [--max-waiting N]
                            [--backoff-type fixed|exponential] [--backoff-delay Nms]
                            [--backoff-jitter 0..1] [--timeout-ms Nms]
                            [--lock-duration-ms Nms]
                            [--idempotency-key K] [--queue Q] [--dry-run]
                            [--redact-secrets]

OPTIONS
  --params JSON        Job payload (handler-specific; see HANDLER TYPES in
                       'gbrain jobs --help')
  --follow             Run inline and stream progress (constructs a real
                       worker; works on both engines)
  --priority N         Lower runs first (default 0)
  --delay Nms          Delay before the job becomes claimable (default 0)
  --max-attempts N     Retry budget (default 3)
  --max-stalled N      Stall-requeue budget before dead-letter (default 5)
  --max-waiting N      Backpressure: cap waiting jobs with this name/queue/
                       source before coalescing new submissions ([1,100])
  --timeout-ms Nms     Per-job wall-clock budget. Long-lane handlers get a
                       default from HANDLER_DEFAULT_TIMEOUT_MS when omitted.
  --lock-duration-ms N Per-job lock lease (#4145). Clamped to [5s, 1h].
                       Long-lane handlers default to 300s via
                       HANDLER_DEFAULT_LOCK_DURATION_MS; others use the
                       worker default (30s).
  --idempotency-key K  At-most-one row per key (dead/cancelled free the key)
  --queue Q            Target queue (default: default)
  --dry-run            Print what would be submitted, submit nothing
  --redact-secrets     (shell jobs) scrub inherited env values from output
`,
  watch: `gbrain jobs watch — live queue dashboard

USAGE
  gbrain jobs watch [--json] [--follow] [--refresh-ms=N]

OPTIONS
  --json           JSON snapshots instead of the human dashboard
  --follow         Keep refreshing (default: on for TTY, off otherwise)
  --refresh-ms=N   Refresh cadence in ms (default 1000). Equals form only —
                   'watch' does not accept a space-separated value.
`,
  prune: `gbrain jobs prune — delete old terminal jobs

USAGE
  gbrain jobs prune [--older-than 30d] [--dry-run]

OPTIONS
  --older-than AGE  Delete completed/failed/dead/cancelled jobs older than
                    AGE in days (default 30d; bare N or Nd — hour forms
                    are not supported)
  --dry-run         Report what would be deleted without deleting
`,
};

// Bare (unsupervised) workers run the same orphaned-private-queue recovery
// the supervisor runs in beforeSpawn — a deployment that starts
// `gbrain jobs work` directly must not lose the crash-recovery lane.
// Supervised children skip it: their supervisor already ran it.
export async function maybeRunWorkerStartupRecovery(
  queue: MinionQueue,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.GBRAIN_SUPERVISED === '1') return;
  try {
    const recovered = await queue.reconcileOrphanedPrivateQueues({
      reason: 'worker startup recovery: orphaned dream-inline private queue',
    });
    if (recovered.cancelled_jobs > 0) {
      console.error(
        `[gbrain jobs] private-queue startup recovery: cancelled ${recovered.cancelled_jobs} ` +
        `job(s) across ${recovered.cancelled_queues} orphaned queue(s)`,
      );
    }
  } catch (e) {
    console.error(`[gbrain jobs] private-queue startup recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runJobs(engineOrNull: BrainEngine | null, args: string[]): Promise<void> {
  const sub = args[0];

  // Help guards run BEFORE the thin-client refusal below: cli.ts routes
  // `jobs … --help` here engine-free (SELF_HELP_WITHOUT_ENGINE), and help
  // must never require an engine — or worse, fall through to a subcommand
  // body and start a real daemon. Only --help/-h are recognized; the bare
  // word 'help' is NOT (e.g. `jobs submit help` is a legitimate job name).
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(JOBS_HELP);
    return;
  }
  if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
    // Object.hasOwn: a plain-object lookup resolves inherited keys, so
    // `jobs constructor --help` (toString/valueOf/…) would print the
    // Object.prototype function instead of falling back to the full help.
    console.log(Object.hasOwn(JOBS_SUBCOMMAND_HELP, sub) ? JOBS_SUBCOMMAND_HELP[sub] : JOBS_HELP);
    return;
  }

  // Thin-client dispatch (cli.ts) passes engine=null for the subcommands
  // with remote MCP routing (`list`, `get`) so no scratch local engine is
  // ever built. Any other subcommand arriving with a null engine is a
  // routing bug upstream of this function — refuse instead of crashing
  // inside MinionQueue.
  if (!engineOrNull && sub !== 'list' && sub !== 'get') {
    console.error(`\`gbrain jobs ${sub ?? ''}\` needs a local engine and cannot run on a thin client.`);
    process.exit(1);
  }
  // Null only ever reaches the MCP-routed `list`/`get` branches, which
  // never touch the engine — narrowed once here so the host-only cases
  // below typecheck unchanged.
  const engine = engineOrNull as BrainEngine;

  // The constructor just stores the reference; on the null (thin-client
  // list/get) paths no queue method is ever reached.
  const queue = new MinionQueue(engine);

  switch (sub) {
    case 'submit': {
      const name = args[1]?.trim();
      if (!name) {
        console.error('Error: job name required. Usage: gbrain jobs submit <name>');
        process.exit(1);
      }

      const paramsStr = parseFlag(args, '--params');
      let data: Record<string, unknown> = {};
      if (paramsStr) {
        try { data = JSON.parse(paramsStr); }
        catch { console.error('Error: --params must be valid JSON'); process.exit(1); }
      }

      const priority = parseInt(parseFlag(args, '--priority') ?? '0', 10);
      const delay = parseInt(parseFlag(args, '--delay') ?? '0', 10);
      const maxAttempts = parseInt(parseFlag(args, '--max-attempts') ?? '3', 10);
      const maxStalledRaw = parseFlag(args, '--max-stalled');
      const maxStalled = maxStalledRaw !== undefined ? parseInt(maxStalledRaw, 10) : undefined;
      // --max-waiting N: submission-time backpressure cap. Mirrors --max-stalled
      // clamp [1, 100]. Feature is usable from CLI as of v0.19.1; pre-v0.19.1
      // only programmatic callers reached it.
      let maxWaiting: number | undefined;
      try { maxWaiting = parseMaxWaitingFlag(args); }
      catch (e) { console.error(`Error: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
      // v0.13.1 field audit: expose retry/backoff/timeout/idempotency knobs so
      // users can tune Minions behavior without dropping into TypeScript.
      const backoffTypeRaw = parseFlag(args, '--backoff-type');
      const backoffType = backoffTypeRaw === 'fixed' || backoffTypeRaw === 'exponential'
        ? backoffTypeRaw
        : undefined;
      const backoffDelayRaw = parseFlag(args, '--backoff-delay');
      const backoffDelay = backoffDelayRaw !== undefined ? parseInt(backoffDelayRaw, 10) : undefined;
      const backoffJitterRaw = parseFlag(args, '--backoff-jitter');
      const backoffJitter = backoffJitterRaw !== undefined ? parseFloat(backoffJitterRaw) : undefined;
      const timeoutMsRaw = parseFlag(args, '--timeout-ms');
      const timeoutMs = timeoutMsRaw !== undefined ? parseInt(timeoutMsRaw, 10) : undefined;
      if (timeoutMsRaw !== undefined && (isNaN(timeoutMs!) || timeoutMs! <= 0)) {
        console.error('Error: --timeout-ms must be a positive integer (milliseconds)');
        process.exit(1);
      }
      // #4145: per-job lock lease. Clamped to [5s,1h] in queue.add via
      // clampLockDurationMs (shared with the MCP op); NULL falls to the
      // handler map, then the worker default.
      const lockDurationMsRaw = parseFlag(args, '--lock-duration-ms');
      const lockDurationMs = lockDurationMsRaw !== undefined ? parseInt(lockDurationMsRaw, 10) : undefined;
      if (lockDurationMsRaw !== undefined && (isNaN(lockDurationMs!) || lockDurationMs! <= 0)) {
        console.error('Error: --lock-duration-ms must be a positive integer (milliseconds)');
        process.exit(1);
      }
      const idempotencyKey = parseFlag(args, '--idempotency-key');
      const queueName = parseFlag(args, '--queue') ?? 'default';
      const dryRun = hasFlag(args, '--dry-run');
      const follow = hasFlag(args, '--follow');
      // v0.36.5.0: --redact-secrets merges the equivalent --params JSON convenience.
      if (hasFlag(args, '--redact-secrets') && name === 'shell') {
        data.redact_secrets = true;
      }

      // Dry-run reports real admission; follow starts and awaits an inline worker.
      const trusted = {
        ...(isProtectedJobName(name) ? { allowProtectedSubmit: true } : {}),
        ...(follow && name === 'embed-backfill' ? { allowPgliteInlineWorker: true } : {}),
      };
      try { assertEmbedBackfillQueueAdmission(engine, name, data, trusted); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      if (dryRun) {
        console.log(`[DRY RUN] Would submit job:`);
        console.log(`  Name: ${name}`);
        console.log(`  Queue: ${queueName}`);
        console.log(`  Priority: ${priority}`);
        console.log(`  Max attempts: ${maxAttempts}`);
        if (maxStalled !== undefined) console.log(`  Max stalled: ${maxStalled}`);
        if (maxWaiting !== undefined) console.log(`  Max waiting: ${maxWaiting}`);
        if (backoffType) console.log(`  Backoff type: ${backoffType}`);
        if (backoffDelay !== undefined) console.log(`  Backoff delay: ${backoffDelay}ms`);
        if (backoffJitter !== undefined) console.log(`  Backoff jitter: ${backoffJitter}`);
        if (timeoutMs !== undefined) console.log(`  Timeout: ${timeoutMs}ms`);
        if (lockDurationMs !== undefined) {
          // Echo what will actually be STORED (queue.add clamps to [5s,1h]);
          // a dry-run that prints the raw out-of-range input lies.
          const stored = clampLockDurationMs(lockDurationMs);
          console.log(`  Lock lease: ${stored}ms${stored !== lockDurationMs ? ` (clamped from ${lockDurationMs}ms)` : ''}`);
        }
        if (idempotencyKey) console.log(`  Idempotency key: ${idempotencyKey}`);
        if (delay > 0) console.log(`  Delay: ${delay}ms`);
        console.log(`  Data: ${JSON.stringify(data)}`);
        return;
      }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      // v0.35.8.0: pre-enqueue shell-job validation. Validates `inherit:`
      // closed enum, rejects secret env-keys, fail-fasts on missing config.
      // Throws UnrecoverableError BEFORE `queue.add` so a bad payload never
      // lands in `minion_jobs.data`. Defense-in-depth re-validation happens
      // in the worker handler. See: src/core/minions/handlers/shell-validate.ts
      if (name === 'shell') {
        try {
          const { validateShellJobParams } = await import('../core/minions/handlers/shell-validate.ts');
          validateShellJobParams(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`Error: ${msg}`);
          process.exit(1);
        }
      }

      const job = await queue.add(name, data, {
        priority,
        delay: delay > 0 ? delay : undefined,
        max_attempts: maxAttempts,
        max_stalled: maxStalled,
        maxWaiting,
        backoff_type: backoffType,
        backoff_delay: backoffDelay,
        backoff_jitter: backoffJitter,
        timeout_ms: timeoutMs,
        lock_duration_ms: lockDurationMs,
        idempotency_key: idempotencyKey,
        queue: queueName,
      }, trusted);

      // Submission audit log (operational trace, not forensic insurance).
      try {
        const { logShellSubmission } = await import('../core/minions/handlers/shell-audit.ts');
        if (name === 'shell') {
          const inheritNames = Array.isArray(data.inherit)
            ? (data.inherit as unknown[]).filter((s): s is string => typeof s === 'string')
            : undefined;
          logShellSubmission({
            caller: 'cli',
            remote: false,
            job_id: job.id,
            cwd: typeof data.cwd === 'string' ? data.cwd : '',
            cmd_display: typeof data.cmd === 'string' ? data.cmd.slice(0, 80) : undefined,
            argv_display: Array.isArray(data.argv)
              ? (data.argv as unknown[]).filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 80))
              : undefined,
            inherit: inheritNames && inheritNames.length > 0 ? inheritNames : undefined,
          });
        }
      } catch { /* audit failures never block submission */ }

      // Starvation warning (DX polish). Fire for every non-`--follow` shell submit
      // regardless of the submitter's own `GBRAIN_ALLOW_SHELL_JOBS` — the submitter
      // env is a weak proxy for the worker env (they may run on different machines),
      // so the warning remains useful any time the job might sit in 'waiting'.
      if (!follow && name === 'shell') {
        process.stderr.write(
          `\n⚠  Shell jobs require GBRAIN_ALLOW_SHELL_JOBS=1 on the worker process.\n` +
          `   Your job was queued (id=${job.id}) but will sit in 'waiting' until a\n` +
          `   worker with the env flag starts. To run now:\n\n` +
          `     GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \\\n` +
          `       --params '...' --follow\n\n` +
          `   Or start a persistent worker (Postgres only — PGLite uses --follow):\n\n` +
          `     GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work\n\n`,
        );
      }

      if (follow) {
        console.log(`Job #${job.id} submitted (${name}). Executing inline...`);
        // Inline execution: run the job in this process. Disable the
        // self-health-check timer — inline flows are one-shot and don't have
        // a process manager to restart them. With the timer enabled and no
        // 'unhealthy' listener, a DB blip would trip emitUnhealthy's
        // no-listener fallback and call process.exit(1) from inside the
        // library, killing the user's CLI session.
        const worker = new MinionWorker(engine, {
          queue: queueName, pollInterval: 100, healthCheckInterval: 0,
        });

        // Register built-in handlers
        await registerBuiltinHandlers(worker, engine);

        if (!worker.registeredNames.includes(name)) {
          console.error(`Error: Unknown job type '${name}'.`);
          console.error(`Available types: ${worker.registeredNames.join(', ')}`);
          console.error(`Register custom types with worker.register('${name}', handler).`);
          process.exit(1);
        }

        // Run worker for one job then stop
        const startTime = Date.now();
        const workerPromise = worker.start();
        // Poll until this job completes
        const pollInterval = setInterval(async () => {
          const updated = await queue.getJob(job.id);
          if (updated && ['completed', 'failed', 'dead', 'cancelled'].includes(updated.status)) {
            worker.stop();
            clearInterval(pollInterval);
          }
        }, 200);
        await workerPromise;
        clearInterval(pollInterval);

        const final = await queue.getJob(job.id);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (final?.status === 'completed') {
          console.log(`Job #${job.id} completed in ${elapsed}s`);
          if (final.result) console.log(`Result: ${JSON.stringify(final.result)}`);
        } else {
          console.error(`Job #${job.id} ${final?.status}: ${final?.error_text}`);
          process.exit(1);
        }
      } else {
        console.log(JSON.stringify(job, null, 2));
      }
      break;
    }

    case 'list': {
      const status = parseFlag(args, '--status') as MinionJobStatus | undefined;
      const queueName = parseFlag(args, '--queue');
      const limit = parseInt(parseFlag(args, '--limit') ?? '20', 10);

      // v0.32: thin-client routing. The `list_jobs` MCP op is admin-scoped
      // but not localOnly, so a thin-client install with admin access can
      // see the remote brain's job queue. Without this branch we'd query
      // the empty local PGLite and report "No jobs found" for an actively-
      // running host brain.
      const cfg = loadConfig();
      let jobs: MinionJob[];
      if (isThinClient(cfg)) {
        const raw = await callRemoteTool(cfg!, 'list_jobs', {
          status, queue: queueName, limit,
        }, { timeoutMs: 30_000 });
        jobs = unpackToolResult<MinionJob[]>(raw).map((j) => rehydrateJobDates(j));
      } else {
        try { await queue.ensureSchema(); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
        jobs = await queue.getJobs({ status, queue: queueName, limit });
      }

      // #3685: --json emits the machine-readable array the CHANGELOG's
      // scripting guidance promises (before this guard the flag was accepted
      // and silently discarded — scripts got the padded ASCII table). Guard
      // sits BEFORE the empty-check so an empty queue emits `[]`, not prose.
      if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(jobs, null, 2));
        break;
      }

      if (jobs.length === 0) {
        console.log('No jobs found.');
        return;
      }

      console.log(`  ${'ID'.padEnd(6)} ${'Name'.padEnd(14)} ${'Status'.padEnd(20)} ${'Queue'.padEnd(10)} ${'Time'.padEnd(8)} Created`);
      console.log('  ' + '─'.repeat(80));
      for (const job of jobs) console.log(formatJob(job));
      console.log(`\n  ${jobs.length} jobs shown`);
      break;
    }

    case 'get': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required. Usage: gbrain jobs get <id>'); process.exit(1); }

      // v0.32: thin-client routing (mirrors `list` branch above).
      const cfg = loadConfig();
      let job: MinionJob | null;
      if (isThinClient(cfg)) {
        try {
          const raw = await callRemoteTool(cfg!, 'get_job', { id }, { timeoutMs: 30_000 });
          job = rehydrateJobDates(unpackToolResult<MinionJob | null>(raw));
        } catch (e) {
          // The remote op throws `invalid_params` on not-found; surface as
          // the same "Job not found" exit-1 the local path produces.
          const msg = e instanceof Error ? e.message : String(e);
          if (/not found/i.test(msg)) {
            console.error(`Job #${id} not found.`);
            process.exit(1);
          }
          throw e;
        }
      } else {
        try { await queue.ensureSchema(); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
        job = await queue.getJob(id);
      }
      if (!job) { console.error(`Job #${id} not found.`); process.exit(1); }
      // #3685: same machine-readable contract as `list --json` above.
      if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(job, null, 2));
        break;
      }
      console.log(formatJobDetail(job));
      break;
    }

    case 'cancel': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const cancelled = await queue.cancelJob(id);
      if (cancelled) {
        console.log(`Job #${id} cancelled.`);
      } else {
        console.error(`Could not cancel job #${id} (may already be completed/dead).`);
        process.exit(1);
      }
      break;
    }

    case 'retry': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const retried = await queue.retryJob(id);
      if (retried) {
        console.log(`Job #${id} re-queued for retry.`);
      } else {
        console.error(`Could not retry job #${id} (must be failed or dead).`);
        process.exit(1);
      }
      break;
    }

    case 'delete': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const removed = await queue.removeJob(id);
      if (removed) {
        console.log(`Job #${id} deleted.`);
      } else {
        console.error(`Could not delete job #${id} (must be in a terminal status).`);
        process.exit(1);
      }
      break;
    }

    case 'prune': {
      const olderThanStr = parseFlag(args, '--older-than') ?? '30d';
      const days = parseInt(olderThanStr, 10);
      if (isNaN(days) || days <= 0) {
        console.error('Error: --older-than must be a positive number (days). Example: --older-than 30d');
        process.exit(1);
      }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      // #2712: --dry-run previews the count without deleting. It used to be
      // silently ignored (the destructive default ran anyway).
      const dryRun = hasFlag(args, '--dry-run');
      const count = await queue.prune({ olderThan: new Date(Date.now() - days * 86400000), dryRun });
      if (dryRun) {
        console.log(`[dry-run] Would prune ${count} jobs older than ${days} days. Nothing deleted.`);
      } else {
        console.log(`Pruned ${count} jobs older than ${days} days.`);
      }
      break;
    }

    case 'stats': {
      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const statsQueue = parseFlag(args, '--queue') ?? 'default';
      const stats = await queue.getStats({ queue: statsQueue });

      // Divergence detection: intake (created in window) vs USEFUL drain
      // (drained_completed — cancellations are outflow, not work; a naive
      // combined drain self-inflates while the TTL sweep shreds backlog).
      // Same env-threshold pattern as the wedge line below.
      const divergenceRatio = (() => {
        const raw = Number(process.env.GBRAIN_QUEUE_DIVERGENCE_RATIO ?? '');
        return Number.isFinite(raw) && raw > 0 ? raw : 2;
      })();
      const divergenceMinWaiting = (() => {
        const raw = parseInt(process.env.GBRAIN_QUEUE_DIVERGENCE_MIN_WAITING ?? '', 10);
        return Number.isFinite(raw) && raw > 0 ? raw : 50;
      })();
      const divergent = stats.by_type.filter(t =>
        t.waiting_now > divergenceMinWaiting &&
        t.total > divergenceRatio * Math.max(t.drained_completed, 1));

      // Waiting-TTL cancellations in the window (admission sweep visibility —
      // derived from the reason prefix cancelJobs writes; no extra storage).
      let ttlCancelled: Array<{ name: string; count: number }> = [];
      try {
        const { TTL_REASON_PREFIX } = await import('../core/minions/admission.ts');
        const ttlRows = await engine.executeRaw<{ name: string; count: string }>(
          `SELECT name, count(*)::text AS count FROM minion_jobs
            WHERE status = 'cancelled' AND error_text LIKE $1
              AND finished_at > now() - interval '24 hours'
            GROUP BY name ORDER BY count(*) DESC`,
          [`${TTL_REASON_PREFIX}%`],
        );
        ttlCancelled = ttlRows.map(r => ({ name: r.name, count: parseInt(r.count, 10) }));
      } catch { /* best-effort */ }
      // Job names originate from the MCP-exposed submit surface — strip
      // control/ANSI bytes + cap before echoing into the terminal screams
      // (same hygiene as frontmatter-derived type names). Names embedded in
      // COPY-PASTEABLE command hints get the stricter safeConfigSegment gate:
      // display-sanitize keeps shell metacharacters.
      const { sanitizeTypeForDisplay: sanitizeName } = await import('../core/schema-pack/type-usage.ts');
      const { safeConfigSegment } = await import('../core/minions/admission.ts');

      if (hasFlag(args, '--json')) {
        console.log(JSON.stringify({
          queue: statsQueue,
          ...stats,
          divergent: divergent.map(t => ({
            name: t.name,
            intake_24h: t.total,
            drained_completed_24h: t.drained_completed,
            waiting_now: t.waiting_now,
            oldest_waiting_minutes: t.oldest_waiting_minutes,
          })),
          ttl_cancelled_24h: ttlCancelled,
        }, null, 2));
        break;
      }

      console.log('Job Stats (last 24h):');
      if (stats.by_type.length > 0) {
        console.log(`  ${'Type'.padEnd(14)} ${'Total'.padEnd(7)} ${'Done'.padEnd(7)} ${'Failed'.padEnd(8)} ${'Dead'.padEnd(6)} ${'Drained'.padEnd(9)} ${'Waiting'.padEnd(9)} Avg Time`);
        for (const t of stats.by_type) {
          const avgTime = t.avg_duration_ms != null ? `${(t.avg_duration_ms / 1000).toFixed(1)}s` : '—';
          // Drained = terminal outflow in-window, completed-first with the
          // rest bracketed so TTL-cancel storms can't masquerade as work.
          const drained = `${t.drained_completed}${(t.drained_failed + t.drained_dead + t.drained_cancelled) > 0 ? `(+${t.drained_failed + t.drained_dead + t.drained_cancelled})` : ''}`;
          console.log(`  ${sanitizeName(t.name).padEnd(14)} ${String(t.total).padEnd(7)} ${String(t.completed).padEnd(7)} ${String(t.failed).padEnd(8)} ${String(t.dead).padEnd(6)} ${drained.padEnd(9)} ${String(t.waiting_now).padEnd(9)} ${avgTime}`);
        }
        console.log(`  (Drained = completed in-window, +N = failed/dead/cancelled outflow; Waiting = now, all queues)`);
      } else {
        console.log('  No jobs in the last 24 hours.');
      }
      console.log(`\n  Queue health: ${stats.queue_health.waiting} waiting, ${stats.queue_health.active} active, ${stats.queue_health.stalled} stalled`);

      // DIVERGENT-queue scream: intake structurally exceeds useful drain and a
      // real backlog is sitting there. This is the default-on protection layer
      // (quota ships config-only), so it must carry the opt-in hint.
      for (const t of divergent) {
        const perDay = t.drained_completed; // window is 24h
        const etaDays = perDay > 0 ? Math.round(t.waiting_now / perDay) : null;
        const eta = etaDays != null ? `~${etaDays}d backlog at current drain` : 'backlog never drains at current rate';
        const ttl = ttlCancelled.find(c => c.name === t.name);
        const ttlNote = ttl ? ` Waiting-TTL is cancelling ~${ttl.count}/day of it.` : '';
        console.log(
          `\n  ⚠  DIVERGENT QUEUE type '${sanitizeName(t.name)}': intake ${t.total}/24h vs ${t.drained_completed} completed/24h, ` +
          `${t.waiting_now} waiting (${eta}).${ttlNote}\n` +
          `     Reduce intake, raise drain, or cap admission:\n` +
          `       gbrain config set minions.quota_max_waiting.${safeConfigSegment(t.name) ?? '<job-name>'} <n>`,
        );
      }
      if (ttlCancelled.length > 0) {
        const parts = ttlCancelled.map(c => `${sanitizeName(c.name)}: ${c.count}`).join(', ');
        console.log(
          `\n  ⚠  Waiting-TTL cancelled ${ttlCancelled.reduce((a, c) => a + c.count, 0)} job(s) in the last 24h (${parts}).\n` +
          `     These waited past their TTL without ever being claimed. Tune:\n` +
          `       gbrain config set minions.ttl_waiting_hours.<name> <hours|0>`,
        );
      }

      // Scheduling priority (niceness, issue #1815). Best-effort: measures live
      // workers from the registry + the supervisor (if running) — silently skips
      // when nothing is reniced/running, so default stats output stays clean.
      try {
        const { readWorkers } = await import('../core/minions/worker-registry.ts');
        const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');
        const { DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
        const liveWorkers = readWorkers();
        const sup = readSupervisorPid(DEFAULT_PID_FILE);
        const supNice = sup.running && sup.pid !== null ? getEffectiveNiceness(sup.pid) : null;
        if (liveWorkers.length > 0 || supNice !== null) {
          console.log(`\n  Scheduling priority (nice):`);
          if (supNice !== null) console.log(`    supervisor (pid ${sup.pid}): ${formatNice(supNice)}`);
          for (const w of liveWorkers) {
            const diverged = w.nice_requested !== null && w.nice_now !== null && w.nice_requested !== w.nice_now
              ? `  ⚠ requested ${formatNice(w.nice_requested)}, not applied` : '';
            console.log(`    worker (pid ${w.pid}, queue ${w.queue}): ${w.nice_now !== null ? formatNice(w.nice_now) : '?'}${diverged}`);
          }
        }
      } catch {
        // Registry/import failure is best-effort; skip silently.
      }

      // issue #1801 — wedged-queue signature (queue-scoped): a worker is alive
      // but claiming nothing while work waits. `active_healthy` (live-lock only)
      // means an expired-lock active row doesn't mask it. Loud line so the
      // operator/agent catches a silent halt in `jobs stats`, not 15h later.
      {
        const w = stats.wedge;
        const mins = w.minutes_since_completion;
        // Shared derivation (queue.ts deriveWedgeSignal) so this line, the
        // doctor wedged_queue check, and the get_job_stats op agree (#1801).
        const { wedged, wedge_threshold_minutes: wedgeMins, private_queue } = deriveWedgeSignal(w);
        // Parent-owned dream-inline queue: no shared worker can EVER claim it,
        // so the supervisor-restart advice below would be a dead end (the
        // incident bug class). Gate the ABANDONED line on the SAME classifier
        // recovery uses — a healthy mid-drain queue (active_healthy 0 in a
        // claim gap) classifies live and must not scream.
        const privateVerdict = private_queue && w.active_healthy === 0 && w.waiting > 0
          ? await queue.classifyPrivateQueueForRecovery(w.queue)
          : null;
        if (privateVerdict === 'orphan' || privateVerdict === 'unowned') {
          const since = mins === null ? 'no completions on record' : `${mins}m since last completion`;
          console.log(
            `\n  ⚠  ABANDONED PRIVATE QUEUE '${w.queue}': ${w.waiting} waiting, 0 active (live-lock), ${since}.\n` +
            `     This dream-inline queue is parent-owned; restarting a worker cannot consume it.\n` +
            (privateVerdict === 'orphan'
              ? `     Auto-recovery cancels it at the next worker spawn or dream-cycle start.`
              : `     Legacy unowned queue: preview \`gbrain dream retriage --help\` before manual cancellation.`),
          );
        } else if (wedged) {
          const since = mins === null ? 'no completions on record' : `${mins}m since last completion`;
          console.log(
            `\n  ⚠  WEDGED QUEUE '${w.queue}': ${w.waiting} waiting, 0 active (live-lock), ${since}.\n` +
            `     A worker may be alive but stuck (dead DB pool / stuck handler). Fix:\n` +
            `       gbrain jobs supervisor stop && gbrain jobs supervisor start   # rebuild a fresh pool\n` +
            `       gbrain jobs retry <id>                                        # for dead-lettered jobs`,
          );
        }

        // Backpressure visibility: maxPending suppression keeps `waiting` at 0
        // while a job is in flight, which silences the waiting>0 wedge line
        // above — the exact operator-confusion cost of the duplicate-cycle
        // incident. Surface the last 24h of coalesce events (per name, this
        // queue) from the backpressure audit JSONL, plus a hint naming the
        // in-flight job when a name shows suppression with zero waiting rows
        // and a stale live-lock active. Best-effort: unreadable audit files
        // simply omit the line.
        try {
          const { readRecentCoalesceCounts } = await import('../core/minions/backpressure-audit.ts');
          const coalesceCounts = readRecentCoalesceCounts({ queue: statsQueue, windowMs: 24 * 3600_000 });
          if (coalesceCounts.size > 0) {
            // Sort once, reuse for the summary AND the hint slice — slicing
            // insertion order would let low-volume early-in-file names crowd
            // out the highest-volume (most likely wedged) ones the summary
            // line just highlighted.
            const sortedCoalesces = [...coalesceCounts.entries()]
              .sort((a, b) => b[1].count - a[1].count);
            const parts = sortedCoalesces.map(([name, s]) => `${name}: ${s.count}`);
            console.log(`\n  Backpressure (24h): submissions coalesced onto in-flight jobs — ${parts.join(', ')}`);
            // Hint loop is bounded: names come from the 24h audit window
            // (normally a handful), capped defensively — this is an
            // operator-invoked diagnostic, not a hot path. Each hint is
            // driven by the LATEST coalesce target for the name (the audit's
            // returned_job_id), scoped to that job's source — a name-wide
            // aggregate would let source A's waiting row mask source B's
            // wedge, or name A's job for B's coalesce (multi-source brains).
            const hints = sortedCoalesces.slice(0, 10);
            for (const [name, summary] of hints) {
              if (summary.last_returned_job_id == null) continue;
              // The target CTE re-checks name+queue: the audit dir is shared
              // across brains in one GBRAIN_HOME, so an id from another
              // brain's audit trail must fail the match here rather than
              // name an unrelated job as the suppressor.
              const rows = await engine.executeRaw<{ waiting: string; live_id: string | null; age_min: string | null }>(
                `WITH target AS (
                   SELECT id, started_at, status, lock_until,
                          COALESCE(data->>'sourceId', data->>'source_id') AS scope
                     FROM minion_jobs WHERE id = $3 AND name = $1 AND queue = $2
                 )
                 SELECT (SELECT count(*)::text FROM minion_jobs m, target t
                          WHERE m.name = $1 AND m.queue = $2 AND m.status = 'waiting'
                            AND COALESCE(m.data->>'sourceId', m.data->>'source_id') IS NOT DISTINCT FROM t.scope) AS waiting,
                        (SELECT id::text FROM target WHERE status = 'active' AND lock_until > now()) AS live_id,
                        (SELECT floor(EXTRACT(EPOCH FROM (now() - started_at)) / 60)::text FROM target
                          WHERE status = 'active' AND lock_until > now()) AS age_min`,
                [name, statsQueue, summary.last_returned_job_id],
              );
              const r = rows[0];
              const ageMin = r?.age_min != null ? parseInt(r.age_min, 10) : null;
              if (r && parseInt(r.waiting ?? '0', 10) === 0 && r.live_id != null && ageMin != null && ageMin > wedgeMins) {
                console.log(
                  `     ${name}: dispatch suppressed by in-flight job #${r.live_id} (age ${ageMin}m) — check \`gbrain jobs get ${r.live_id}\``,
                );
              }
            }
          }
        } catch {
          // Audit read is advisory; never break stats.
        }
      }

      // v0.41 Bug 2 / Eng D8 — surface lease pressure to the operator.
      // Reads minion_lease_pressure_log windowed at 1h. Best-effort: pre-v93
      // brains (no table) silently skip; the queue_health line above is the
      // operator's primary signal in that case.
      try {
        const lpRows = await engine.executeRaw<{ count: string }>(
          `SELECT count(*)::text AS count FROM minion_lease_pressure_log
            WHERE bounced_at > now() - interval '1 hour'`,
        );
        const lpCount = parseInt(lpRows[0]?.count ?? '0', 10);
        if (lpCount > 0) {
          // Also surface whether any of those bounces stalled forward progress.
          // Bounces with rising completed counts = healthy backpressure; bounces
          // with zero completes = real blocker (matches doctor's subagent_health).
          const completedRows = await engine.executeRaw<{ count: string }>(
            `SELECT count(*)::text AS count FROM minion_jobs
              WHERE finished_at > now() - interval '1 hour'
                AND status = 'completed' AND name = 'subagent'`,
          ).catch(() => [{ count: '0' }]);
          const completed = parseInt(completedRows[0]?.count ?? '0', 10);
          const tag = completed > 0
            ? `(${completed} subagent job${completed === 1 ? '' : 's'} completed, throughput healthy)`
            : `(no subagent jobs completed — cap may be too tight; \`export GBRAIN_ANTHROPIC_MAX_INFLIGHT=64\`)`;
          console.log(`  Lease pressure (1h): ${lpCount} bounce${lpCount === 1 ? '' : 's'} ${tag}`);
        } else {
          console.log(`  Lease pressure (1h): 0 bounces`);
        }
      } catch {
        // Pre-v93 brain — no table. Silent skip.
      }

      // v0.41 D3 — error clustering. Optional via --cluster-errors flag so
      // operators only see the breakdown when triaging a fail-heavy batch
      // (default stats output stays scannable). Pulls last 24h of dead +
      // failed jobs, classifies by error-classify.ts buckets, sorts by
      // count, surfaces top 5 with paste-ready retry hints.
      if (hasFlag(args, '--cluster-errors')) {
        try {
          const { clusterErrors } = await import('../core/minions/error-classify.ts');
          const errRows = await engine.executeRaw<{ id: number; last_error: string | null }>(
            `SELECT id, error_text AS last_error FROM minion_jobs
              WHERE status IN ('dead', 'failed')
                AND updated_at > now() - interval '24 hours'`,
          );
          if (errRows.length === 0) {
            console.log(`\n  Error clusters (24h): no dead/failed jobs`);
          } else {
            const clusters = clusterErrors(errRows);
            console.log(`\n  Error clusters (24h):`);
            for (const c of clusters.slice(0, 5)) {
              const sample = c.sample_ids.length > 0
                ? `  (e.g. \`gbrain jobs get ${c.sample_ids[0]}\`)` : '';
              console.log(`    ${String(c.count).padStart(4)} × ${c.cluster.padEnd(22)}${sample}`);
            }
            if (clusters.length > 5) {
              console.log(`    + ${clusters.length - 5} more cluster${clusters.length - 5 === 1 ? '' : 's'}`);
            }
          }
        } catch (e) {
          // error-classify import or SQL fail. Don't block stats output.
          if (process.env.GBRAIN_DEBUG === '1') {
            console.error(`[jobs stats] cluster-errors skipped: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      break;
    }

    case 'smoke': {
      const startTime = Date.now();
      try { await queue.ensureSchema(); }
      catch (e) {
        console.error(`SMOKE FAIL — schema init: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const sigkillRescue = hasFlag(args, '--sigkill-rescue');
      const wedgeRescue = hasFlag(args, '--wedge-rescue');

      // Smoke harness is short-lived and has no listener — disable the health
      // timer so the no-listener fallback can't trip process.exit(1) mid-test.
      const worker = new MinionWorker(engine, {
        queue: 'smoke', pollInterval: 100, healthCheckInterval: 0,
      });
      worker.register('noop', async () => ({ ok: true, at: new Date().toISOString() }));

      const job = await queue.add('noop', {}, { queue: 'smoke', max_attempts: 1 });
      const workerPromise = worker.start();

      const timeoutMs = 15000;
      let final: MinionJob | null = null;
      for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
        await new Promise(r => setTimeout(r, 100));
        final = await queue.getJob(job.id);
        if (final && ['completed', 'failed', 'dead', 'cancelled'].includes(final.status)) break;
      }
      worker.stop();
      await workerPromise;

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
      if (final?.status !== 'completed') {
        console.error(`SMOKE FAIL — job #${job.id} status: ${final?.status ?? 'timeout'} (${elapsedSec}s elapsed)`);
        if (final?.error_text) console.error(`  Error: ${final.error_text}`);
        process.exit(1);
      }

      // --sigkill-rescue: regression case for #219. Simulates a SIGKILL
      // mid-flight by directly manipulating lock_until via handleStalled.
      // Verifies that with the v0.13.1 schema default (max_stalled=5), a
      // stalled job is REQUEUED rather than dead-lettered on first stall.
      // Full subprocess-level SIGKILL lives in test/e2e/minions.test.ts.
      if (sigkillRescue) {
        const rescueJob = await queue.add('noop', {}, { queue: 'smoke' });

        // Transition to active with a past lock_until, mimicking a worker
        // that claimed and then got SIGKILL'd mid-run.
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status='active',
                  lock_token='smoke-sigkill-rescue',
                  lock_until=now() - interval '1 minute',
                  started_at=now() - interval '2 minute',
                  attempts_started = attempts_started + 1
            WHERE id=$1`,
          [rescueJob.id]
        );

        const result = await queue.handleStalled();
        const afterStall = await queue.getJob(rescueJob.id);

        if (afterStall?.status === 'dead') {
          console.error(
            `SMOKE FAIL (--sigkill-rescue) — job #${rescueJob.id} was dead-lettered on first stall. ` +
            `This is the #219 regression: schema default max_stalled should rescue, not dead-letter. ` +
            `handleStalled: ${JSON.stringify(result)}`
          );
          process.exit(1);
        }
        if (afterStall?.status !== 'waiting') {
          console.error(
            `SMOKE FAIL (--sigkill-rescue) — unexpected status after stall: ${afterStall?.status}. ` +
            `Expected 'waiting' (rescued). handleStalled: ${JSON.stringify(result)}`
          );
          process.exit(1);
        }
        try { await queue.removeJob(rescueJob.id); } catch { /* non-fatal cleanup */ }
      }

      // --wedge-rescue: regression case for the v0.19.1 production incident.
      // In prod, a wedged worker held a row lock via a pending txn. The
      // lock-renewal UPDATE blocked, lock_until fell below now(), handleStalled
      // saw the candidate but FOR UPDATE SKIP LOCKED skipped (row lock held),
      // handleTimeouts was disqualified (lock_until > now() fails).
      // Only handleWallClockTimeouts' no-constraint sweep evicted.
      //
      // The smoke is single-connection, so we can't simulate a row lock held
      // by another txn. Instead we forge the state where BOTH handleStalled
      // and handleTimeouts are disqualified so only wall-clock fires:
      //   - lock_until far in the future → handleStalled skips (not a stall)
      //   - timeout_at = NULL → handleTimeouts skips (needs NOT NULL)
      //   - started_at 10s ago with timeout_ms=1000 → wall-clock matches
      //     (2 × timeout_ms = 2000ms threshold exceeded)
      if (wedgeRescue) {
        const wedgedJob = await queue.add('noop', {}, {
          queue: 'smoke',
          timeout_ms: 1000,
        });
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status='active',
                  lock_token='smoke-wedge-rescue',
                  lock_until=now() + interval '30 seconds',
                  started_at=now() - interval '10 seconds',
                  timeout_at=NULL,
                  attempts_started = attempts_started + 1
            WHERE id=$1`,
          [wedgedJob.id]
        );

        const stallResult = await queue.handleStalled();
        const stalledStatus = await queue.getJob(wedgedJob.id);
        const timeoutResult = await queue.handleTimeouts();
        const timedStatus = await queue.getJob(wedgedJob.id);
        const wallResult = await queue.handleWallClockTimeouts(30000);
        const finalStatus = await queue.getJob(wedgedJob.id);

        if (finalStatus?.status !== 'dead') {
          console.error(
            `SMOKE FAIL (--wedge-rescue) — wall-clock sweep did not evict job #${wedgedJob.id}. ` +
            `Status: ${finalStatus?.status}. ` +
            `handleStalled: requeued=${stallResult.requeued.length} dead=${stallResult.dead.length}, after: ${stalledStatus?.status}; ` +
            `handleTimeouts: ${timeoutResult.length}, after: ${timedStatus?.status}; ` +
            `handleWallClockTimeouts: ${wallResult.length}, final: ${finalStatus?.status}.`
          );
          process.exit(1);
        }
        if (finalStatus.error_text !== 'wall-clock timeout exceeded') {
          console.error(
            `SMOKE FAIL (--wedge-rescue) — dead, but error_text='${finalStatus.error_text}' ` +
            `(expected 'wall-clock timeout exceeded').`
          );
          process.exit(1);
        }
        try { await queue.removeJob(wedgedJob.id); } catch { /* non-fatal cleanup */ }
      }

      const cfg = (await import('../core/config.ts')).loadConfig();
      const engineLabel = cfg?.engine ?? 'unknown';
      const tags: string[] = [];
      if (sigkillRescue) tags.push('SIGKILL rescue');
      if (wedgeRescue) tags.push('wedge rescue');
      const tag = tags.length > 0 ? ` + ${tags.join(' + ')}` : '';
      console.log(`SMOKE PASS — Minions healthy${tag} in ${elapsedSec}s (engine: ${engineLabel})`);
      if (engineLabel === 'pglite') {
        console.log('Note: the `gbrain jobs work` daemon requires Postgres. PGLite');
        console.log('supports inline execution only (`submit --follow`).');
      }
      try { await queue.removeJob(job.id); } catch { /* non-fatal cleanup */ }
      process.exit(0);
    }

    case 'run-child': {
      // INTERNAL (issue #5 process isolation): spawned by `jobs work` with
      // process isolation enabled. One job, one process: validate the claim,
      // run the handler with the child's own engine, write ONE outcome file,
      // exit. Deliberately absent from user-facing help. The CLI layer owns
      // engine.disconnect() + process.exit() (engine-ownership invariant).
      {
        const config = loadConfig();
        if (config?.engine === 'pglite') {
          console.error('[run-child] process isolation requires the Postgres engine.');
          await engine.disconnect();
          process.exit(JOB_CHILD_EXIT_USAGE);
        }
        const jobIdRaw = parseFlag(args, '--job-id');
        const jobId = jobIdRaw != null ? parseInt(jobIdRaw, 10) : NaN;
        const lockToken = process.env[CHILD_ENV.lockToken];
        const resultPath = process.env[CHILD_ENV.resultPath];
        const parentPidRaw = parseInt(process.env[CHILD_ENV.parentPid] ?? '0', 10);
        if (!Number.isInteger(jobId) || jobId <= 0 || !lockToken || !resultPath) {
          console.error(
            '[run-child] internal command spawned by the jobs worker; requires ' +
            `a numeric job id plus ${CHILD_ENV.lockToken} and ${CHILD_ENV.resultPath} in env.`,
          );
          await engine.disconnect();
          process.exit(JOB_CHILD_EXIT_USAGE);
        }

        // Same handler surface as the worker: registerBuiltinHandlers also
        // performs plugin discovery, so plugin subagent jobs isolate too.
        const throwaway = new MinionWorker(engine, { queue: 'default', concurrency: 1 });
        await registerBuiltinHandlers(throwaway, engine, { quiet: true });

        let code: number;
        try {
          code = await runChildJobEntry(
            engine,
            {
              jobId,
              lockToken,
              resultPath,
              parentPid: Number.isInteger(parentPidRaw) && parentPidRaw > 0 ? parentPidRaw : 0,
            },
            { resolveHandler: (name) => throwaway.getHandler(name) },
          );
        } catch (e) {
          console.error(`[run-child] fatal: ${e instanceof Error ? e.message : String(e)}`);
          code = 1;
        }
        await engine.disconnect();
        process.exit(code);
      }
    }
    // eslint-disable-next-line no-fallthrough -- unreachable: the case above always exits
    case 'work': {
      // Check if PGLite
      const config = (await import('../core/config.ts')).loadConfig();
      if (config?.engine === 'pglite') {
        console.error('Error: Worker daemon requires Postgres. PGLite uses an exclusive file lock that blocks other processes.');
        console.error('Use --follow for inline execution: gbrain jobs submit <name> --follow');
        process.exit(1);
      }

      const queueName = parseFlag(args, '--queue') ?? 'default';
      const concurrency = resolveWorkerConcurrency(args);
      // --max-rss: explicit value wins (including 0 to disable the watchdog).
      // Absent → cgroup-aware auto-size (issue #1678): the flat 2048MB default
      // killed legit embed work (~10GB) on every cycle and produced a silent
      // ~400×/24h respawn loop. See src/core/minions/rss-default.ts.
      const maxRssExplicit = parseMaxRssFlag(args);
      const { resolveDefaultMaxRssMb, describeDefaultMaxRss } =
        await import('../core/minions/rss-default.ts');
      const maxRssMb = maxRssExplicit ?? resolveDefaultMaxRssMb();

      // --health-interval: self-health-check period in ms. 0 disables. Default: 60_000 (60s).
      // Provides DB liveness probes + stall detection for bare workers.
      // Automatically skipped when running under a supervisor (GBRAIN_SUPERVISED=1).
      // Validated aggressively (parity with --max-rss): reject NaN/negative/non-integer
      // values, and reject suspicious sub-1000ms values that are likely a unit-confusion
      // typo (e.g. "--health-interval 60" thinking the unit is seconds).
      const healthRaw = parseFlag(args, '--health-interval');
      let healthCheckInterval = 60_000;
      if (healthRaw !== undefined) {
        const parsed = parseInt(healthRaw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error(`Error: --health-interval must be a non-negative integer (ms), got "${healthRaw}"`);
          process.exit(1);
        }
        if (parsed > 0 && parsed < 1000) {
          console.error(
            `Error: --health-interval ${parsed} is suspiciously low (likely a unit-confusion typo). ` +
            `The flag takes milliseconds; for 60-second probes pass 60000. Use 0 to disable.`,
          );
          process.exit(1);
        }
        healthCheckInterval = parsed;
      }

      // --nice N (issue #1815): renice this worker process so background work
      // yields CPU to foreground tasks without sacrificing concurrency. Applied
      // at the CLI layer (worker.ts stays embeddable). Niceness inherits to the
      // worker's spawned children (shell jobs / subagents) automatically.
      const niceVal = parseNiceFlag(args);
      let niceResult: ReturnType<typeof applyNiceness> | undefined;
      if (niceVal !== undefined) {
        niceResult = applyNiceness(niceVal);
        if (!niceResult.applied) {
          console.error(
            `[gbrain jobs] could not set niceness to ${niceVal}: ${niceResult.error ?? 'unknown'}. ` +
            `Negative nice needs privilege; running at niceness ${niceResult.effective ?? 'unchanged'}.`,
          );
        }
      }

      // issue #5: per-job process isolation. Resolve + validate the child CLI
      // invocation ONCE at startup and refuse to start on failure — a bad
      // path discovered per-job would release every claim as infra failures
      // (never dead-lettering, but never progressing either).
      const jobIsolation = parseJobIsolationFlag(args);
      let childCliInvocation: { cmd: string; argsPrefix: string[] } | null = null;
      let childTiniPath = '';
      if (jobIsolation === 'process') {
        const { resolveGbrainCliPath } = await import('./autopilot.ts');
        const inv = resolveChildCliInvocation(
          process.env,
          process.execPath,
          process.argv[1],
          () => resolveGbrainCliPath(),
        );
        if (!inv) {
          console.error(
            'Error: process isolation needs a resolvable gbrain CLI for job children ' +
            '(compiled binary on PATH, or GBRAIN_JOB_CHILD_CLI override).',
          );
          process.exit(1);
        }
        // Canonicalize BEFORE validating: existsSync on a relative name checks
        // cwd while spawn() resolves via PATH — the validated file and the
        // executed binary could differ (security review). Resolving to an
        // absolute path makes the fail-fast check and the spawn agree.
        const { existsSync: childCliExists } = await import('node:fs');
        const { resolve: resolveCliPath } = await import('node:path');
        inv.cmd = resolveCliPath(inv.cmd);
        if (!childCliExists(inv.cmd)) {
          console.error(
            `Error: resolved child CLI does not exist: ${inv.cmd} ` +
            '(set GBRAIN_JOB_CHILD_CLI to a valid gbrain binary).',
          );
          process.exit(1);
        }
        childCliInvocation = inv;
        const { detectTini } = await import('../core/minions/spawn-helpers.ts');
        childTiniPath = detectTini();
        if (maxRssMb > 0) {
          console.error(
            '[gbrain jobs] note: with process isolation on, the --max-rss watchdog covers the ' +
            'WORKER process only — handler memory now lives in job children. Per-child caps are ' +
            'a filed follow-up; size host memory for concurrency x handler footprint.',
          );
        }
      }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      await maybeRunWorkerStartupRecovery(queue);

      // issue #6: the direct-pool kill switch collapses lock renewal, health
      // probes, and handler workload onto ONE shared pool — silently. Make
      // the collapse loud at startup so a later 'pool_starved' incident has
      // an obvious prior warning instead of a mystery.
      {
        const { getConnectionRouting } = await import('../core/minions/db-probe.ts');
        const cm = getConnectionRouting(engine);
        if (cm?.isDualPoolActive && !cm.isDualPoolActive()) {
          const killSwitched = cm.describeMode?.().kill_switch_active === true;
          console.error(
            `[gbrain jobs] single-pool mode: lock renewal, health probes and handler workload share ` +
            `one connection pool${killSwitched ? ' (direct-lane kill switch is active)' : ''}. ` +
            `Under heavy handler load this pool can starve the lock heartbeat. For Supabase brains, ` +
            `ensure the direct (5432) host is reachable or set GBRAIN_DIRECT_DATABASE_URL.`,
          );
        }
      }

      const worker = new MinionWorker(engine, {
        queue: queueName, concurrency, maxRssMb, healthCheckInterval,
        jobIsolation, childCliInvocation, childTiniPath,
      });
      await registerBuiltinHandlers(worker, engine);

      // Subscribe to self-health failures emitted by the worker. Library code
      // (worker.ts) never calls process.exit directly so it stays embeddable;
      // this CLI layer is the right place to terminate the process and let
      // the external PM (systemd, Docker, cron watchdog) restart cleanly.
      worker.on('unhealthy', (info) => {
        if (info.reason === 'db_dead') {
          // issue #6: name the failing LAYER, not just "DB unreachable" —
          // that message sent operators chasing database capacity while the
          // real fault was client-side pool exhaustion. Exiting is still
          // correct recovery either way (it frees every client-held slot).
          if (info.verdict === 'pool_starved') {
            console.error(
              `[health] FATAL: connection-pool path saturated after ${info.consecutiveFailures} probes — ` +
              `the database server itself is reachable. (${info.message}) ` +
              `Likely causes: long-running handler queries holding pool slots, or too-small GBRAIN_POOL_SIZE ` +
              `for this workload. Consider --job-isolation process for long-running handlers ` +
              `(handler connections then die with each job's child process). ` +
              `Exiting for process-manager restart (frees all client-held slots).`,
            );
          } else if (info.verdict === 'server_unreachable') {
            console.error(
              `[health] FATAL: database server unreachable after ${info.consecutiveFailures} probes ` +
              `(both pooler and direct lanes failed). (${info.message}) ` +
              `Exiting for process-manager restart.`,
            );
          } else {
            console.error(
              `[health] FATAL: DB probe failed ${info.consecutiveFailures} consecutive times (${info.message}). ` +
              `Exiting for process-manager restart.`,
            );
          }
        } else if (info.reason === 'child_spawn_failing') {
          console.error(
            `[health] FATAL: ${info.consecutiveFailures} consecutive job-child spawn/bootstrap ` +
            `failures (${info.message}). The child CLI is deterministically broken — fix the ` +
            `worker's child CLI configuration (or GBRAIN_JOB_CHILD_CLI). Exiting for ` +
            `process-manager restart.`,
          );
        } else {
          console.error(
            `[health] FATAL: Worker stalled — ${info.waitingCount} waiting job(s) for ` +
            `registered handlers, ${info.idleMinutes}m idle. Exiting for process-manager restart.`,
          );
        }
        process.exit(1);
      });

      const isSupervisedChild = process.env.GBRAIN_SUPERVISED === '1';
      let watchdogNote = '';
      if (maxRssMb > 0) {
        if (maxRssExplicit !== undefined) {
          watchdogNote = `, watchdog: ${maxRssMb}MB (explicit)`;
        } else {
          const d = describeDefaultMaxRss();
          watchdogNote = `, watchdog: ${maxRssMb}MB (auto-sized from ${Math.round(d.basisMb / 1024)}GB ${d.source} RAM)`;
        }
      }
      // issue #1801 (fix #2): the DB-liveness probe runs under supervision too;
      // only stall detection is supervised-off. Report accordingly.
      const healthNote = healthCheckInterval > 0
        ? (isSupervisedChild
            ? `, db-probe: ${Math.round(healthCheckInterval / 1000)}s`
            : `, health-check: ${Math.round(healthCheckInterval / 1000)}s`)
        : '';
      const niceNote = niceResult ? `, nice: ${formatNice(niceResult.effective ?? niceVal!)}` : '';
      const isolationNote = jobIsolation === 'process'
        ? `, isolation: process (child cli: ${childCliInvocation?.cmd}${childTiniPath ? ', tini' : ''})`
        : '';
      console.log(`Minion worker started (queue: ${queueName}, concurrency: ${concurrency}${watchdogNote}${healthNote}${niceNote}${isolationNote})`);
      console.log(`Registered handlers: ${worker.registeredNames.join(', ')}`);

      // Register in the live worker registry (issue #1815) so jobs stats / doctor
      // can report this worker's effective niceness. Cleanup runs on BOTH the
      // finally below AND process.on('exit') — the unhealthy handler's
      // process.exit(1) bypasses the awaited finally (Codex #10).
      const { registerWorker } = await import('../core/minions/worker-registry.ts');
      const unregisterWorker = registerWorker({
        pid: process.pid,
        queue: queueName,
        nice_requested: niceVal ?? null,
        nice_effective: niceResult ? niceResult.effective : null,
        started_at: Date.now(),
      });
      process.on('exit', () => unregisterWorker());

      try {
        await worker.start();
      } finally {
        unregisterWorker();
        // Release the DB connection pool immediately on shutdown so
        // PgBouncer slots are freed rather than waiting for TCP keepalive
        // (~minutes). Disconnect failure is best-effort but logged loudly:
        // a silent shutdown disconnect error is exactly the bug class the
        // v0.26.9 D14 direction (isUndefinedColumnError, oauth-provider)
        // was created to surface. The CLI is the engine owner here, not
        // the worker — keeping disconnect at this layer preserves the
        // "engine ownership stays with the creator" invariant that broke
        // tests in earlier waves of this branch.
        try { await engine.disconnect(); }
        catch (e) { console.error('[gbrain jobs work] engine disconnect failed during shutdown:', e); }

        // If the RSS watchdog (not a normal SIGTERM) drained the worker, exit
        // with the distinct WORKER_EXIT_RSS_WATCHDOG code so the supervisor
        // classifies the drain as `rss_watchdog` (cause-keyed backoff + loud
        // alert) instead of a silent `clean_exit`. The worker exposes the
        // intent; the CLI owns process.exit (same ownership boundary as the
        // engine-disconnect above). Explicit process.exit also guarantees the
        // code even if a lingering handle would otherwise keep the process
        // alive past natural exit (issue #1678, Codex #7).
        if (worker.rssWatchdogTriggered) {
          process.exit(WORKER_EXIT_RSS_WATCHDOG);
        }
      }
      break;
    }

    case 'supervisor': {
      // Dispatcher for supervisor subcommands:
      //   gbrain jobs supervisor                    → foreground start (back-compat)
      //   gbrain jobs supervisor start [--detach]   → foreground or detached start
      //   gbrain jobs supervisor status             → JSON liveness + queue stats
      //   gbrain jobs supervisor stop               → SIGTERM + drain wait
      const { MinionSupervisor, DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
      const { writeSupervisorEvent } = await import('../core/minions/handlers/supervisor-audit.ts');

      const supCmd = args[1];
      const isStatusCmd = supCmd === 'status';
      const isStopCmd = supCmd === 'stop';
      const isStartCmd = supCmd === 'start' || supCmd === undefined || supCmd === '--detach' ||
                          (typeof supCmd === 'string' && supCmd.startsWith('--'));
      const jsonMode = hasFlag(args, '--json');
      const pidFile = parseFlag(args, '--pid-file') ?? DEFAULT_PID_FILE;

      // ----- status subcommand -----
      if (isStatusCmd) {
        const { readSupervisorEvents, summarizeCrashes } = await import('../core/minions/handlers/supervisor-audit.ts');
        const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');
        const { readWorkers } = await import('../core/minions/worker-registry.ts');

        const pidStatus = readSupervisorPid(pidFile);
        const supervisorPid = pidStatus.pid;
        const pidfileRunning = pidStatus.running;

        const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
        const lastStart = events.filter(e => e.event === 'started').pop()?.ts ?? null;

        // issue #2227 fix #1/#3: the pidfile is HOME-derived, so a supervisor
        // started under a different $HOME (keeper=/root vs ops=/data) reads as
        // "not running" here even when it is healthy — the false signal that
        // makes an operator spawn a duplicate. Fall back to the queue-scoped DB
        // singleton lock (#1849), the HOME-independent authority. PID-reuse-safe:
        // isLockHolderLive keys on lock freshness, never process.kill.
        const supQueue = parseFlag(args, '--queue') ?? 'default';
        let detectedViaDbLock = false;
        let dbLockHolder: { holder_pid: number; holder_host: string } | null = null;
        if (!pidfileRunning) {
          try {
            const { inspectLock, isLockHolderLive } = await import('../core/db-lock.ts');
            const { supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } = await import('../core/minions/supervisor.ts');
            const snap = await inspectLock(engine, supervisorLockId(supQueue));
            if (snap && isLockHolderLive(snap, SUPERVISOR_LOCK_TTL_MIN)) {
              detectedViaDbLock = true;
              dbLockHolder = { holder_pid: snap.holder_pid, holder_host: snap.holder_host };
            }
          } catch {
            // Pre-migration brains / transient DB errors: fall back to pidfile-only.
          }
        }
        const running = pidfileRunning || detectedViaDbLock;
        // Surface the supervisor's recorded config from the latest `started`
        // event (concurrency + effective --max-rss) so split-$HOME deployments
        // see what the live-but-pidfile-invisible supervisor is running.
        const startedEvt = events.filter(e => e.event === 'started').pop() ?? null;
        // Shared classifier — same code path runs in `gbrain doctor` so the
        // two surfaces cannot drift on what counts as a crash. Supersedes
        // v0.35.4.0's binary `classifyWorkerExit({code})` on this surface;
        // see doctor.ts for the layering rationale.
        const summary = summarizeCrashes(events);
        const maxCrashesEvent = events.filter(e => e.event === 'max_crashes_exceeded').pop() ?? null;

        // Niceness (issue #1815): measure live workers + the supervisor itself.
        const workers = readWorkers().map(w => ({
          pid: w.pid,
          queue: w.queue,
          nice_requested: w.nice_requested,
          nice: w.nice_now,
        }));
        const supervisorNice = pidfileRunning && supervisorPid !== null
          ? getEffectiveNiceness(supervisorPid)
          : null;

        const status = {
          running,
          detected_via: detectedViaDbLock ? 'db_lock' : (pidfileRunning ? 'pidfile' : null),
          supervisor_pid: supervisorPid ?? dbLockHolder?.holder_pid ?? null,
          db_lock_holder: dbLockHolder,
          pid_file: pidFile,
          queue: supQueue,
          last_start: lastStart,
          concurrency: typeof startedEvt?.concurrency === 'number' ? startedEvt.concurrency : null,
          max_rss_mb: typeof startedEvt?.max_rss_mb === 'number' ? startedEvt.max_rss_mb : null,
          crashes_24h: summary.total,
          clean_exits_24h: summary.clean_exits,
          crashes_by_cause: summary.by_cause,
          max_crashes_exceeded: !!maxCrashesEvent,
          nice: supervisorNice,
          workers,
        };

        if (jsonMode) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          const via = detectedViaDbLock ? ' (detected via DB lock; pidfile not found at the configured path)' : '';
          console.log(`Supervisor: ${running ? 'running' : 'not running'}${via}`);
          if (status.supervisor_pid) console.log(`  PID:           ${status.supervisor_pid}${detectedViaDbLock ? ` @ ${dbLockHolder?.holder_host}` : ''}`);
          console.log(`  PID file:      ${pidFile}`);
          if (detectedViaDbLock && status.concurrency !== null) console.log(`  Concurrency:   ${status.concurrency}${status.max_rss_mb !== null ? ` (max-rss ${status.max_rss_mb}MB)` : ''}`);
          if (lastStart) console.log(`  Last start:    ${lastStart}`);
          console.log(`  Crashes (24h):     ${summary.total} (runtime=${summary.by_cause.runtime_error} oom=${summary.by_cause.oom_or_external_kill} unknown=${summary.by_cause.unknown} legacy=${summary.by_cause.legacy})`);
          console.log(`  Clean exits (24h): ${summary.clean_exits}`);
          if (supervisorNice !== null) console.log(`  Nice (supervisor): ${formatNice(supervisorNice)}`);
          for (const w of workers) {
            const req = w.nice_requested !== null && w.nice !== null && w.nice_requested !== w.nice
              ? ` (requested ${formatNice(w.nice_requested)})` : '';
            console.log(`  Worker pid ${w.pid} [${w.queue}]: nice ${w.nice !== null ? formatNice(w.nice) : '?'}${req}`);
          }
          if (maxCrashesEvent) console.log(`  ⚠ Max crashes exceeded at ${maxCrashesEvent.ts}`);
        }
        process.exit(running ? 0 : 1);
      }

      // ----- stop subcommand -----
      if (isStopCmd) {
        const { existsSync, readFileSync } = await import('fs');
        if (!existsSync(pidFile)) {
          const payload = { stopped: false, reason: 'pid_file_missing', pid_file: pidFile };
          if (jsonMode) console.log(JSON.stringify(payload));
          else console.error(`No PID file at ${pidFile}; supervisor not running.`);
          process.exit(1);
        }
        let supervisorPid: number;
        try {
          supervisorPid = parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0], 10);
          if (isNaN(supervisorPid) || supervisorPid <= 0) throw new Error('invalid pid');
        } catch (err) {
          const payload = { stopped: false, reason: 'pid_file_corrupt', error: String(err) };
          if (jsonMode) console.log(JSON.stringify(payload));
          else console.error(`PID file corrupt: ${err}`);
          process.exit(1);
        }

        try { process.kill(supervisorPid, 'SIGTERM'); }
        catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          const payload = {
            stopped: false,
            reason: code === 'ESRCH' ? 'process_gone' : 'kill_failed',
            supervisor_pid: supervisorPid,
          };
          if (jsonMode) console.log(JSON.stringify(payload));
          else console.error(`Cannot signal PID ${supervisorPid}: ${err}`);
          process.exit(code === 'ESRCH' ? 0 : 1);
        }

        // Poll for up to 40s (supervisor's own 35s drain + 5s slack).
        const deadline = Date.now() + 40_000;
        let stoppedCleanly = false;
        while (Date.now() < deadline) {
          try { process.kill(supervisorPid, 0); }
          catch { stoppedCleanly = true; break; }
          await new Promise(r => setTimeout(r, 250));
        }

        const payload = {
          stopped: stoppedCleanly,
          supervisor_pid: supervisorPid,
          reason: stoppedCleanly ? 'drained' : 'timeout_40s',
        };
        if (jsonMode) console.log(JSON.stringify(payload));
        else console.log(stoppedCleanly ? `Supervisor ${supervisorPid} stopped.` : `Supervisor ${supervisorPid} did not exit within 40s.`);
        process.exit(stoppedCleanly ? 0 : 1);
      }

      // ----- start subcommand (default) -----
      if (!isStartCmd) {
        console.error(`Unknown supervisor subcommand: ${supCmd}. Expected: start, status, stop.`);
        process.exit(1);
      }

      const config = (await import('../core/config.ts')).loadConfig();
      if (config?.engine === 'pglite') {
        console.error('Error: Supervisor requires Postgres. PGLite uses an exclusive file lock that blocks other processes.');
        process.exit(1);
      }

      const { resolveGbrainCliPath } = await import('./autopilot.ts');

      const concurrency = parseInt(parseFlag(args, '--concurrency') ?? '2', 10);
      const queueName = parseFlag(args, '--queue') ?? 'default';
      const maxCrashes = parseInt(parseFlag(args, '--max-crashes') ?? '10', 10);
      // --health-interval (supervisor): validate same as `jobs work` so NaN /
      // negative / sub-1000ms typos fail-fast instead of silently disabling
      // the supervisor's own health probe.
      const supHealthRaw = parseFlag(args, '--health-interval');
      let healthInterval = 60_000;
      if (supHealthRaw !== undefined) {
        const parsed = parseInt(supHealthRaw, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error(`Error: --health-interval must be a non-negative integer (ms), got "${supHealthRaw}"`);
          process.exit(1);
        }
        if (parsed > 0 && parsed < 1000) {
          console.error(
            `Error: --health-interval ${parsed} is suspiciously low (likely a unit-confusion typo). ` +
            `The flag takes milliseconds; for 60-second probes pass 60000. Use 0 to disable.`,
          );
          process.exit(1);
        }
        healthInterval = parsed;
      }
      const allowShellJobs = hasFlag(args, '--allow-shell-jobs') ||
                             !!process.env.GBRAIN_ALLOW_SHELL_JOBS;
      const detach = hasFlag(args, '--detach');
      // Supervisor's --max-rss: explicit wins; absent → cgroup-aware auto-size
      // (issue #1678). The supervisor is the main production path, so the
      // watchdog is on by default — but at a realistic, RAM-relative cap
      // instead of the old flat 2048MB footgun.
      const { resolveDefaultMaxRssMb: resolveSupMaxRss } =
        await import('../core/minions/rss-default.ts');
      const maxRssMb = parseMaxRssFlag(args) ?? resolveSupMaxRss();

      // --nice N (issue #1815): validated here (fail-fast on bad input even for
      // --detach), but APPLIED only in the foreground-start path below — applying
      // before the --detach branch would renice the throwaway parent that forks
      // and exits, not the long-lived re-exec'd child (Codex #1).
      const supNice = parseNiceFlag(args);

      const cliPath = parseFlag(args, '--cli-path') ?? resolveGbrainCliPath();

      // --detach: fork a background supervisor, print PID payload, exit 0.
      // #4418: the child gets a DURABLE stderr sink (audit-dir log, null-device
      // fallback) instead of inheriting the invoker's stderr — an inherited
      // capture pipe closing killed the worker (SIGPIPE 141) and then the
      // supervisor itself on their next stderr write. See detached-stderr.ts.
      if (detach) {
        const { spawnDetachedSupervisor } = await import('../core/minions/detached-stderr.ts');
        const started = spawnDetachedSupervisor(
          process.execPath,
          process.argv[1],
          process.argv.slice(2).filter(a => a !== '--detach'),
        );
        const payload = {
          event: 'started',
          supervisor_pid: started.pid,
          pid_file: pidFile,
          detached: true,
          ...(started.stderrPath ? { stderr_log: started.stderrPath } : {}),
        };
        console.log(JSON.stringify(payload));
        process.exit(0);
      }

      // Foreground start. Renice THIS process (the long-lived supervisor) now,
      // after the --detach fork-and-exit branch (Codex #1). The worker inherits
      // it via the spawn env; the supervisor also passes `--nice` down so the
      // worker re-applies it (see buildWorkerArgs).
      const supervisorPid = process.pid;
      let supNiceResult: ReturnType<typeof applyNiceness> | undefined;
      if (supNice !== undefined) {
        supNiceResult = applyNiceness(supNice);
        if (!supNiceResult.applied) {
          console.error(
            `[gbrain jobs] could not set supervisor niceness to ${supNice}: ${supNiceResult.error ?? 'unknown'}. ` +
            `Negative nice needs privilege; running at niceness ${supNiceResult.effective ?? 'unchanged'}.`,
          );
        }
      }
      const supervisor = new MinionSupervisor(engine, {
        concurrency,
        queue: queueName,
        pidFile,
        maxCrashes,
        healthInterval,
        cliPath,
        allowShellJobs,
        json: jsonMode,
        maxRssMb,
        jobIsolation: parseJobIsolationFlag(args),
        ...(supNice !== undefined ? { nice_requested: supNice } : {}),
        ...(supNiceResult?.effective != null ? { nice_effective: supNiceResult.effective } : {}),
        ...(supNiceResult?.error ? { nice_error: supNiceResult.error } : {}),
        onEvent: (emission) => writeSupervisorEvent(emission, supervisorPid),
      });

      await supervisor.start();
      break;
    }

    case 'watch': {
      // v0.41 D2 — live dashboard; v0.42.11.0 (#1784) decoupled output from TTY.
      // Flags: --json (FORMAT, human default), --follow (LOOP, default=isTTY so
      // non-TTY one-shots), --refresh-ms=N. Non-TTY no-flag → one human snapshot.
      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
      const { runWatch } = await import('./jobs-watch.ts');
      const refreshArg = args.find(a => a.startsWith('--refresh-ms='));
      const refreshMs = refreshArg ? parseInt(refreshArg.split('=')[1] ?? '1000', 10) : 1000;
      const json = hasFlag(args, '--json');
      const follow = hasFlag(args, '--follow') ? true : undefined; // undefined → default to isTTY
      await runWatch(engine, { refreshMs, json, follow });
      break;
    }

    default:
      console.error(`Unknown subcommand: ${sub}. Run 'gbrain jobs --help' for usage.`);
      process.exit(1);
  }
}

/**
 * Register built-in job handlers.
 *
 * Handlers call library-level Core functions (runSyncCore via performSync,
 * runExtractCore, runEmbedCore, runBacklinksCore) directly — NOT the CLI
 * wrappers. CLI wrappers call process.exit(1) on validation errors; if a
 * worker claimed a badly-formed job and ran one, the WORKER PROCESS would
 * die and every in-flight job would go stalled. Library Cores throw
 * instead, so one bad job fails one job — not the worker.
 *
 * Per the v0.11.1 plan (Codex architecture #5 — tension 3).
 */
export async function registerBuiltinHandlers(
  worker: MinionWorker,
  engine: BrainEngine,
  opts?: { quiet?: boolean },
): Promise<void> {
  // `quiet` suppresses the informational startup stderr lines. The supervisor
  // (issue #1801) runs this against a throwaway worker purely to read
  // `registeredNames` for wedge name-scoping — it must not spam the operator's
  // terminal with "shell handler registered…" lines. The real `jobs work` path
  // omits opts and prints as before.
  const quiet = opts?.quiet === true;
  worker.register('sync', async (job) => {
    const { performSync } = await import('./sync.ts');
    const repoPath = typeof job.data.repoPath === 'string' ? job.data.repoPath : undefined;
    const noPull = !resolveJobPull(job.data);
    // noEmbed defaults to true (embed is a separate job — submit `embed --stale`
    // after sync, OR run via the autopilot cycle which has its own embed phase).
    // Caller can opt in by passing { noEmbed: false } in job params.
    const noEmbed = job.data.noEmbed !== false;
    // v0.22.13 (PR #490 CODEX-1): resolve sourceId from job param OR by looking
    // up the sources row for repoPath. Mirrors cycle.ts:480 — without this, a
    // multi-source brain reads the global config.sync.last_commit anchor
    // instead of sources.last_commit, which on a regularly-GC'd repo can drop
    // out of git history and trigger 30-min full reimports every cycle.
    let sourceId: string | undefined =
      typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId && repoPath) {
      try {
        const rows = await engine.executeRaw<{ id: string }>(
          `SELECT id FROM sources WHERE local_path = $1 LIMIT 1`,
          [repoPath],
        );
        sourceId = rows[0]?.id;
      } catch {
        // sources table may not exist on very old brains — fall through to
        // global config.sync.* anchor in performSync.
      }
    }
    // v0.22.13 (PR #490 CODEX-4): route concurrency through the shared
    // autoConcurrency helper instead of hardcoded 4. PGLite engines stay
    // serial (forced 1); explicit job param wins; auto path defaults are
    // applied inside performSync against the resolved file count.
    const concurrencyOverride = typeof job.data.concurrency === 'number'
      ? job.data.concurrency
      : undefined;
    // v0.36+ codex #5 fix: standalone `sync` handler now passes
    // noExtract:true so doctor's remediation plan [sync, extract] doesn't
    // double-extract (performSync inline-extract + standalone extract job).
    // Pre-fix, runPhaseSync in cycle.ts passed noExtract:true but the
    // standalone handler dropped it. Callers that want inline extract can
    // pass { noExtract: false } in job params explicitly.
    const noExtract = job.data.noExtract !== false;
    // v0.46: github-kind single-item refresh (webhook path). The payload
    // carries {repo, number, kind} and sync refreshes exactly that item.
    const githubItem =
      job.data.github_item && typeof job.data.github_item === 'object'
        ? {
            repo: String((job.data.github_item as Record<string, unknown>).repo),
            number: Number((job.data.github_item as Record<string, unknown>).number),
            kind: (job.data.github_item as Record<string, unknown>).kind === 'pr' ? 'pr' as const : 'issue' as const,
            deleted: (job.data.github_item as Record<string, unknown>).deleted === true,
          }
        : undefined;
    let result;
    try {
      result = await performSync(engine, {
        repoPath, sourceId, noPull, noEmbed, noExtract,
        concurrency: concurrencyOverride,
        ...(githubItem ? { githubItem } : {}),
      });
    } catch (err) {
      // v0.42.x (#1794, Part B): single-flight backpressure. A concurrent
      // sync (manual run, sibling autopilot tick) holds the per-source lock.
      // SKIP cleanly — mark the job done, NOT failed — so the holder finishes
      // without this tick polluting the failed-jobs count + supervisor crash
      // metrics. The next scheduled tick resumes against the (by then
      // advanced) anchor.
      const { SyncLockBusyError } = await import('./sync.ts');
      if (err instanceof SyncLockBusyError) {
        console.error(
          `[sync] skipped: sync already in progress for ${sourceId ?? 'default'} ` +
          `(lock ${err.lockKey} held).`,
        );
        return { skipped: true, reason: 'sync_in_progress', source_id: sourceId ?? 'default' };
      }
      throw err;
    }

    // v0.40 D22: auto_embed_backfill defaults TRUE when sourceId is set AND
    // the feature flag is enabled. Submits a child embed-backfill job
    // (fire-and-forget — D15.1) so stale chunks get embedded async without
    // the sync handler waiting on the embed pipeline.
    const autoEmbed = job.data.auto_embed_backfill !== false;
    let embedJobId: number | null = null;
    let embedSkipReason: string | null = null;
    if (autoEmbed && sourceId && result.status !== 'up_to_date' && result.status !== 'dry_run') {
      try {
        const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
        if (await isFederatedV2Enabled(engine)) {
          const { submitEmbedBackfill } = await import('../core/embed-backfill-submit.ts');
          const submission = await submitEmbedBackfill(engine, sourceId, {
            reason: typeof job.data.embed_reason === 'string'
              ? (job.data.embed_reason as string)
              : 'sync_handler',
          });
          if (submission.status === 'submitted') {
            embedJobId = submission.jobId;
          } else if (submission.status === 'cooldown' || submission.status === 'spend_capped' || submission.status === 'no_worker_surface') {
            embedSkipReason = submission.status;
          } else {
            submission satisfies never;
          }
        } else {
          embedSkipReason = 'feature_flag_disabled';
        }
      } catch (err) {
        // Embed-backfill submission failure must NOT fail the sync job.
        embedSkipReason = `submit_error:${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (!sourceId) {
      embedSkipReason = 'no_source_id';
    } else if (!autoEmbed) {
      embedSkipReason = 'auto_embed_disabled';
    }

    return { ...result, embed_job_id: embedJobId, embed_skip_reason: embedSkipReason };
  });

  registerBuiltinJob(worker, engine, 'embed', async (job) => {
    const { runEmbedCore } = await import('./embed.ts');
    // Primary Minion progress channel is job.updateProgress (DB-backed,
    // readable via `gbrain jobs get <id>`). Stderr from the worker daemon
    // only emits coarse job-start / job-done lines; per-page detail lives
    // in the DB. Per Codex review #20.
    const embedResult = await runEmbedCore(engine, {
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      slugs: Array.isArray(job.data.slugs) ? (job.data.slugs as string[]) : undefined,
      all: !!job.data.all,
      stale: job.data.all ? false : (job.data.stale !== false),
      // `embed --background` serializes dryRun into the payload (embed.ts's
      // job-args builder). Not reading it back here meant a backgrounded
      // preview embedded for real: API spend and NULL->vector writes from an
      // invocation whose whole point was to do neither.
      dryRun: !!job.data.dryRun,
      sourceId: typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined,
      // Background parity (D7): the doc-recommended recovery
      // `embed --stale --catch-up --include-null-signature --background`
      // used to silently DEGRADE — the payload dropped these four, so the
      // job ran as a plain 30-min-budget stale pass with the grandfather
      // clause intact. Serialize + read them like every other embed knob.
      catchUp: !!job.data.catchUp,
      includeNullSignature: !!job.data.includeNullSignature,
      batchSize: typeof job.data.batchSize === 'number' ? job.data.batchSize : undefined,
      priority: job.data.priority === 'recent' ? 'recent' : undefined,
      // CX1+CX5: pace overrides ride in the job payload as explicit overrides
      // only; runEmbedCore re-resolves env > config > bundle at execution so
      // GBRAIN_PACE_* still wins during an incident.
      ...(job.data.pace && typeof job.data.pace === 'object'
        ? {
            pace: job.data.pace as { perCallMode?: string; perCall?: PaceKeyOverrides },
            // Serialized from the queued payload → config tier so GBRAIN_PACE_*
            // on the worker still wins at execution (Codex P2 escape hatch).
            paceFromBackground: true,
          }
        : {}),
      onProgress: (done, total, embedded) => {
        // Fire-and-forget: progress updates are best-effort and must not
        // block the worker loop.
        job.updateProgress({ done, total, embedded, phase: 'embed.pages' }).catch(() => {});
      },
    });
    // #4599 (X6): a stall-watchdog abort is an error RESULT from core; the
    // handler layer converts it to a FAILED JOB (throw) — never process.exit.
    assertEmbedNotStalled(embedResult);
    // Report what happened, not a constant. `embedded: true` claimed a dry run
    // had embedded, which is the same lie in miniature: `gbrain jobs get`
    // showed it. `embedded` stays the key it always was and stays truthy on a
    // real run (it is now the count, 0 on a dry run).
    return {
      embedded: embedResult.embedded,
      dry_run: !!embedResult.dryRun,
      would_embed: embedResult.would_embed,
      failures: embedResult.failures,
    };
  });

  worker.register('lint', async (job) => {
    const { runLintCore } = await import('./lint.ts');
    const target = typeof job.data.dir === 'string' ? job.data.dir : '.';
    // issue #1678: reuse the worker's live engine for lint's content-sanity
    // DB lift so it doesn't create + disconnect a competing engine.
    const result = await runLintCore({ target, fix: !!job.data.fix, dryRun: !!job.data.dryRun, engine });
    return result;
  });

  // v0.41.11.0 — extract-conversation-facts. NOT in PROTECTED_JOB_NAMES
  // because per-call cost is bounded by `data.max_cost_usd` (default
  // DEFAULT_MAX_COST_USD = $5) and the handler re-creates the
  // BudgetTracker inside its own process. BudgetExhausted is caught at
  // the core level and returned as `result.budget_exhausted: true` (NOT
  // a job failure) so the user can resume with a higher cap.
  registerBuiltinJob(worker, engine, 'extract-conversation-facts', async (job) => {
    const { runExtractConversationFactsCore } = await import('./extract-conversation-facts.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId) {
      // Multi-source iteration not supported in the Minion-handler path;
      // the CLI wrapper does multi-source loops. A background submission
      // SHOULD pin to one source per call (job_id is per-call).
      throw new Error('extract-conversation-facts Minion job requires data.sourceId');
    }
    // ALLOWED_TYPES is the single source of truth for the conversation-facts
    // type allowlist (see src/core/facts/conversation-types.ts).
    const types = Array.isArray(job.data.types)
      ? (job.data.types as string[]).filter(
          (t): t is AllowedType => (ALLOWED_TYPES as readonly string[]).includes(t),
        )
      : undefined;
    const result = await runExtractConversationFactsCore(engine, {
      sourceId,
      types,
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      dryRun: !!job.data.dryRun,
      limit: typeof job.data.limit === 'number' ? job.data.limit : undefined,
      sinceIso: typeof job.data.sinceIso === 'string' ? job.data.sinceIso : undefined,
      force: !!job.data.force,
      sleepMs: typeof job.data.sleepMs === 'number' ? job.data.sleepMs : undefined,
      segmentLimit: typeof job.data.segmentLimit === 'number' ? job.data.segmentLimit : undefined,
      maxCostUsd: typeof job.data.maxCostUsd === 'number' ? job.data.maxCostUsd : undefined,
      overrideDisabled: !!job.data.overrideDisabled,
      // v0.41.15.0 (D9): round-trip --workers via job.data.workers so
      // `gbrain extract-conversation-facts --background --workers 20`
      // works end-to-end.
      workers: typeof job.data.workers === 'number' ? job.data.workers : undefined,
    });
    return result;
  });

  // v0.42.x (#2390) — Life Chronicle event extraction. NOT protected (bounded
  // LLM spend per page; no shell). Enqueued by the put_page chronicle backstop
  // and by `gbrain chronicle backfill`. Idempotent (content-addressed event
  // slugs + projection upsert), so a retry re-runs to the same state.
  // #3387: registered via registerBuiltinJob (gateway-refresh wrap) — the
  // judge is a gateway chat call, so a stale worker gateway meant silent
  // no_events for every extraction.
  registerBuiltinJob(worker, engine, 'chronicle_extract', async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : undefined;
    if (!slug) throw new Error('chronicle_extract job requires data.slug');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    const { runChronicleExtract } = await import('../core/chronicle/extract-events.ts');
    const { chronicleTz } = await import('../core/chronicle/config.ts');
    const tz = await chronicleTz(engine);
    return await runChronicleExtract(engine, {
      slug,
      sourceId,
      tz,
      signal: (job as { signal?: AbortSignal }).signal,
    });
  });

  // Open-loop commitment/decision extraction over google-source email pages
  // (src/core/google/loops-extract.ts). Enqueued by runGoogleSync on trickle
  // threads within the recent window, idempotency-keyed per page revision,
  // capped per sweep. Kill switch: config loops.extraction_enabled.
  registerBuiltinJob(worker, engine, 'loops_extract', async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : undefined;
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!slug || !sourceId) throw new Error('loops_extract job requires data.slug and data.sourceId');
    const threadId = typeof job.data.threadId === 'string' ? job.data.threadId : undefined;
    const { runLoopsExtract } = await import('../core/google/loops-extract.ts');
    return await runLoopsExtract(engine, { slug, sourceId, ...(threadId ? { threadId } : {}) });
  });

  // v0.41.39 (#1700) — enrich. NOT in PROTECTED_JOB_NAMES: per-call cost is
  // bounded by data.maxCostUsd (default DEFAULT_MAX_COST_USD) and the handler
  // re-creates the BudgetTracker in its own process. BudgetExhausted is caught
  // at the core level and returned as result.budget_exhausted (NOT a failure).
  // Strict per-source: the CLI fans out one job per source when --source is
  // omitted, so a job ALWAYS carries data.sourceId.
  registerBuiltinJob(worker, engine, 'enrich', async (job) => {
    const { runEnrichCore } = await import('./enrich.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId) {
      throw new Error('enrich Minion job requires data.sourceId (CLI fans out one job per source)');
    }
    const types = Array.isArray(job.data.types)
      ? (job.data.types as string[])
      : undefined;
    const order = typeof job.data.order === 'string' ? job.data.order : undefined;
    const result = await runEnrichCore(engine, {
      sourceId,
      types: types as import('../core/types.ts').PageType[] | undefined,
      order: order as ('inbound-links' | 'salience' | 'updated') | undefined,
      limit: typeof job.data.limit === 'number' ? job.data.limit : undefined,
      workers: typeof job.data.workers === 'number' ? job.data.workers : undefined,
      model: typeof job.data.model === 'string' ? job.data.model : undefined,
      maxCostUsd: typeof job.data.maxCostUsd === 'number' ? job.data.maxCostUsd : undefined,
      minContextChars: typeof job.data.minContextChars === 'number' ? job.data.minContextChars : undefined,
      thinThreshold: typeof job.data.thinThreshold === 'number' ? job.data.thinThreshold : undefined,
      reenrichAfterMs: typeof job.data.reenrichAfterMs === 'number' ? job.data.reenrichAfterMs : undefined,
      dryRun: !!job.data.dryRun,
      force: !!job.data.force,
    });
    return result;
  });

  // v0.40.3.0 T8b: RemediationStep consumer handlers. Thin wrappers
  // around already-shipping CLI commands so doctor --remediate can
  // submit them as Minion jobs. NOT in PROTECTED_JOB_NAMES (no shell
  // exec, no cost spike, MCP-safe).
  worker.register('lint-fix', async (job) => {
    const { runLintCore } = await import('./lint.ts');
    const target = typeof job.data.dir === 'string' ? job.data.dir : '.';
    // issue #1678: reuse the worker's live engine (see 'lint' handler).
    return await runLintCore({ target, fix: true, dryRun: false, engine });
  });

  worker.register('integrity-auto', async () => {
    const { runIntegrity } = await import('./integrity.ts');
    await runIntegrity(['auto']);
    return { ok: true };
  });

  worker.register('sync-retry-failed', async () => {
    const { runSync } = await import('./sync.ts');
    await runSync(engine, ['--retry-failed']);
    return { ok: true };
  });

  worker.register('import', async (job) => {
    // import.ts Core extraction deferred (import has parallel workers +
    // checkpointing; the typed-API split lands in W7 of the fix-wave).
    // W0 (Tier-1 #5): runImport no longer contains ANY process.exit — all
    // five preflight sites throw typed ImportAbortError, which this
    // handler's catch converts to a normal failJob. No worker-kill risk.
    const { runImport } = await import('./import.ts');
    const importArgs: string[] = [];
    if (job.data.dir) importArgs.push(String(job.data.dir));
    if (job.data.noEmbed) importArgs.push('--no-embed');
    await runImport(engine, importArgs);
    return { imported: true };
  });

  worker.register('extract', async (job) => {
    const { runExtractCore, extractStaleFromDB, STALE_TIME_BUDGET_MS } = await import('./extract.ts');
    // #2849: stale mode — the durable follow-up for extraction deferred by
    // performSync's size gate (totalChanges > 100). Runs the same DB-source
    // watermark sweep as `gbrain extract --stale`, scoped to the source the
    // sync that deferred it was scoped to (job.data.sourceId; absent =
    // unscoped, matching what the CLI hint tells a default-brain operator
    // to run). The sweep is checkout-less + idempotent, so retries and
    // overlapping submissions converge.
    if (job.data.stale === true) {
      const sourceIdFilter = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
      const r = await extractStaleFromDB(engine, {
        dryRun: !!job.data.dryRun,
        jsonMode: false,
        includeFrontmatter: false,
        sourceIdFilter,
        catchUp: false,
      });
      // Internal 30-min budget hit with work remaining → chain a
      // continuation job so a very large deferred backlog converges without
      // waiting for the next sync. Forward-progress guard (pagesProcessed >
      // 0) prevents an infinite chain if the sweep can't advance.
      if (!job.data.dryRun && r.staleRemaining > 0 && r.pagesProcessed > 0) {
        try {
          const queue = new MinionQueue(engine);
          // NO maxWaiting: with an unscoped (NULL-sourceId) payload the
          // coalesce filter matches ANY waiting 'extract' job and would
          // swallow the continuation. Each completed sweep chains at most
          // one continuation and the sweep is an idempotent watermark scan,
          // so there is no pile-up to guard against.
          await queue.add(
            'extract',
            { ...job.data, continuation_of: job.id },
            { timeout_ms: STALE_TIME_BUDGET_MS + 5 * 60 * 1000 },
          );
        } catch { /* best-effort: next sync/manual sweep picks up the rest */ }
      }
      return { stale: true, source_id: sourceIdFilter ?? null, ...r };
    }
    const mode = (typeof job.data.mode === 'string' && ['links', 'timeline', 'all'].includes(job.data.mode))
      ? (job.data.mode as 'links' | 'timeline' | 'all')
      : 'all';
    const dir = typeof job.data.dir === 'string'
      ? job.data.dir
      : (await engine.getConfig('sync.repo_path')) ?? '.';
    // #3957: thread the job's source id into the fs-walk extractors. Without
    // it the batch rows default to source_id='default' and the pages JOIN
    // drops every row on a non-'default' brain (silent "created 0"), and the
    // full-walk watermark stamp targets the wrong source.
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    return await runExtractCore(engine, { mode, dir, dryRun: !!job.data.dryRun, sourceId });
  });

  worker.register('backlinks', async (job) => {
    const { runBacklinksCore } = await import('./backlinks.ts');
    // Default to 'check', not 'fix': backlinks jobs submitted with an empty
    // payload (e.g. the sync→embed→backlinks chains enqueued after ingestion)
    // must never rewrite tracked brain pages with generated "Referenced in"
    // timeline bullets. Mirrors the documented intent in src/core/cycle.ts
    // (runPhaseBacklinks). The filesystem fixer stays available explicitly
    // via '{"action":"fix"}' or `gbrain check-backlinks fix`.
    const action: 'check' | 'fix' = job.data.action === 'fix' ? 'fix' : 'check';
    const dir = typeof job.data.dir === 'string'
      ? job.data.dir
      : (await engine.getConfig('sync.repo_path')) ?? '.';
    return await runBacklinksCore({ action, dir, dryRun: !!job.data.dryRun });
  });

  // Local patch 2026-06-11: durable facts:absorb. One-shot CLI processes
  // (capture/put/sync) can't finish the extraction chat before their exit
  // drain aborts it, so backstop.ts submits this job instead and the
  // long-lived worker does the LLM work here. Inline mode: errors throw, so
  // minion retry/backoff handles transient failures and real ones stay visible
  // in `gbrain jobs list --status failed`. In the gateway-refresh set (model
  // config re-stamped per job). #4310: wrapped in the provider-halt cooldown
  // (llm-halt-cooldown.ts) — a globally-broken provider defers the queue.
  registerBuiltinJob(worker, engine, 'facts-absorb', withFactsAbsorbHaltCooldown(async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : '';
    if (!slug) throw new Error('facts-absorb job requires data.slug');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : 'default';
    const page = await engine.getPage(slug, { sourceId });
    if (!page) return { skipped: 'page_missing', slug, sourceId };
    const { runFactsBackstop } = await import('../core/facts/backstop.ts');
    const KNOWN_SOURCES = ['sync:import', 'mcp:put_page', 'mcp:extract_facts', 'file_upload', 'code_import'] as const;
    const source = (KNOWN_SOURCES as readonly string[]).includes(job.data.source as string)
      ? (job.data.source as typeof KNOWN_SOURCES[number])
      : 'mcp:put_page';
    const result = await runFactsBackstop(
      {
        slug: page.slug,
        type: page.type,
        compiled_truth: page.compiled_truth,
        frontmatter: (page.frontmatter ?? {}) as Record<string, unknown>,
      },
      {
        engine,
        sourceId,
        sessionId: typeof job.data.sessionId === 'string' ? job.data.sessionId : null,
        source,
        mode: 'inline',
        notabilityFilter: job.data.notabilityFilter === 'high-only' ? 'high-only' : 'all',
        visibility: job.data.visibility === 'world' ? 'world' : 'private',
        ...(typeof job.data.model === 'string' && job.data.model ? { model: job.data.model } : {}),
      },
    ).catch(async (err: unknown) => {
      const { writeFactsAbsorbFailure } = await import('../core/facts/absorb-log.ts');
      await writeFactsAbsorbFailure(engine, slug, err, sourceId);
      throw err;
    });
    // Execution-time chat_unavailable in a KEYED worker is config drift —
    // throw (typed) so minion retry/backoff parks it as a VISIBLE, re-runnable
    // failure instead of consuming the job and silently losing the facts. A
    // KEYLESS worker completes the job as a calm skip (its execution-time gate
    // already printed the keyless note; a retry loop would turn every page
    // write into failed-job noise). The retry conversion lives HERE, not in
    // the shared pipeline — the same pipeline serves the extract_facts op,
    // which must return its keyless envelope instead of throwing. The
    // classification runs in the WORKER process (the submitting hook
    // subprocess may have a deliberately neutered env).
    if (factsAbsorbUnavailable(result)) {
      const { classifyUnavailable } = await import('../core/facts/backstop.ts');
      const jobModel = typeof job.data.model === 'string' && job.data.model ? job.data.model : undefined;
      if (factsAbsorbShouldRetry(result, await classifyUnavailable(jobModel))) {
        const { FactsExtractionError } = await import('../core/facts/extract.ts');
        throw new FactsExtractionError('chat_unavailable', jobModel);
      }
    }
    return result;
  }));

  // Autopilot-cycle handler: delegates to runCycle. Shares the exact same
  // phase set and ordering as `gbrain dream` and autopilot's inline path —
  // one source of truth for what the brain does overnight.
  //
  // Yields the event loop between phases so the worker's lock-renewal
  // timer (src/core/minions/worker.ts) can fire. Without this the v0.14
  // stall-death regression returns: long CPU-bound phases starve the
  // renewal callback and the stalled-sweeper kills the job.
  //
  // Phase failures surface as report.status='partial' (via runCycle's
  // v0.40.3.0: per-page contextual retrieval re-embed handler. PROTECTED
  // name (src/core/minions/protected-names.ts) — MCP/OAuth callers can't
  // submit; only trusted local callers (config.ts mode-switch hook,
  // reindex sweep, doctor --remediate). Composes the global Haiku rate-
  // leaser per D26 P0-3 + delegates to contextual-retrieval-service.ts
  // for the two-phase build.
  {
    const { makeContextualReindexHandler } = await import(
      '../core/minions/handlers/contextual-reindex-per-chunk.ts'
    );
    registerBuiltinJob(worker, engine, 'contextual_reindex_per_chunk', makeContextualReindexHandler({ engine }));
  }

  // derivation); the handler returns { partial, status, report } so
  // `gbrain jobs get <id>` shows the full structured report. Does NOT
  // throw on partial: a flaky phase must not block every future cycle.
  registerBuiltinJob(worker, engine, 'autopilot-cycle', async (job) => {
    const { runCycle } = await import('../core/cycle.ts');
    // v0.41.30 (T2): fall back to null (NOT cwd '.') when no repo is configured.
    // The queued cycle is the same primitive `gbrain dream` uses; a checkout-less
    // postgres brain should skip filesystem phases (no_brain_dir) and run the
    // DB-only phases (resolve_symbol_edges, embed, ...) — not silently lint/sync
    // against whatever directory the worker happens to be running in.
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? null;

    // v0.38 (codex r1 P1-2 + P1-5): per-source dispatch threading.
    //   - source_id: when set, runCycle uses the per-source lock ID and
    //     writes last_full_cycle_at on success. Validated at handler entry
    //     so queue replays with malformed source_id dead-letter instead of
    //     reaching cycle code.
    //   - pull: when set, overrides the legacy hardcoded `true` so
    //     per-source dispatch can disable pull for local-only sources.
    //     Missing/undefined keeps the legacy `true` for back-compat.
    //   - Archive recheck: if source_id is set but the source was
    //     archived between fan-out and worker claim, skip cleanly.
    const rawSourceId = job.data.source_id;
    let sourceId: string | undefined;
    // issue #2227/#2194 (TODOS:634, codex #8): a per-source cycle must run its
    // FILESYSTEM phases (sync/lint/extract) against the SOURCE's own checkout,
    // not the global brain's. Pre-fix it inherited `repoPath` (the default
    // checkout) while writing DB freshness for `source_id` — mixed scope that
    // made cooldown/freshness attribute to the wrong source. We resolve the
    // source's `local_path` here and use it as the cycle's brainDir below.
    let sourceLocalPath: string | null = null;
    if (rawSourceId !== undefined && rawSourceId !== null) {
      if (typeof rawSourceId !== 'string') {
        throw new Error(`autopilot-cycle: invalid source_id (not a string): ${JSON.stringify(rawSourceId)}`);
      }
      const { isValidSourceId } = await import('../core/source-id.ts');
      if (!isValidSourceId(rawSourceId)) {
        // Dead-letter early — malformed source_id from queue replay shouldn't
        // reach cycle code. TS narrowing via isValidSourceId boolean shape
        // (assertValidSourceId would require static-import per TS2775).
        throw new Error(`autopilot-cycle: invalid source_id (regex): ${JSON.stringify(rawSourceId)}`);
      }
      // Archive recheck (codex r1 P1-5): cheap pre-cycle lookup. Returns
      // immediately if source is gone or archived; runCycle never even
      // acquires a lock. Also fetches local_path so FS phases bind to the
      // source's own checkout (the #2227/#2194 mixed-scope fix).
      const rows = await engine.executeRaw<{ archived: boolean | null; local_path: string | null }>(
        `SELECT archived, local_path FROM sources WHERE id = $1`,
        [rawSourceId],
      );
      if (rows.length === 0) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_not_found', source_id: rawSourceId },
        };
      }
      if (rows[0].archived === true) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_archived', source_id: rawSourceId },
        };
      }
      sourceId = rawSourceId;
      sourceLocalPath = typeof rows[0].local_path === 'string' && rows[0].local_path.length > 0
        ? rows[0].local_path
        : null;
    }

    // Effective checkout for FS phases. For a per-source cycle, bind to the
    // SOURCE's local_path (or null → skip FS phases for a pure-DB source);
    // NEVER fall through to the global repoPath, which would run sync/lint
    // against the wrong tree. Legacy (no source_id) keeps the global repoPath.
    const effectiveBrainDir: string | null = sourceId ? sourceLocalPath : repoPath;

    // Allow callers to select phases via job data (e.g. skip embed for
    // fast cycles). Validates against ALL_PHASES to prevent injection, then
    // normalizes per-source payloads to the freshness set (queue payloads
    // are machine-authored; see normalizeQueuedSourcePhases in cycle.ts).
    const { ALL_PHASES, normalizeQueuedSourcePhases } = await import('../core/cycle.ts');
    const validPhases = new Set(ALL_PHASES);
    const requestedPhases = Array.isArray(job.data.phases)
      ? (job.data.phases as string[]).filter(p => validPhases.has(p as any))
      : undefined;
    const { phases: effectivePhases, rejected: phasesRejectedByNormalization } =
      normalizeQueuedSourcePhases(requestedPhases as any, sourceId);
    // An explicitly-empty phase list (arrived empty, or emptied by the
    // normalization) is a no-op — NOT an implicit run. The reason string is
    // honest about WHICH of the two happened.
    if (effectivePhases !== undefined && effectivePhases.length === 0) {
      return {
        partial: false,
        status: 'skipped',
        report: {
          reason: phasesRejectedByNormalization.length > 0
            ? 'all_phases_rejected_by_normalization'
            : 'empty_phase_list',
          ...(sourceId ? { source_id: sourceId } : {}),
          phases_rejected_by_normalization: phasesRejectedByNormalization,
        },
      };
    }

    const pull = resolveJobPull(job.data);

    // #2194 fix #2 / codex #5 (D4): claim-time cooldown guard. A job already
    // queued or retrying (max_attempts:2) can reach the worker after the
    // dispatch gate decided to back this source off. Skip it here as a NO-OP
    // (status 'skipped', NOT a failure — a failure would re-arm the cooldown).
    if (sourceId) {
      const { isSourceInCooldown } = await import('./autopilot-fanout.ts');
      if (await isSourceInCooldown(engine, sourceId)) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_in_cooldown', source_id: sourceId },
        };
      }
    }

    const report = await runCycle(engine, {
      brainDir: effectiveBrainDir,
      pull,
      signal: job.signal, // propagate abort so cycle bails on timeout/cancel
      deadlineAtMs: job.deadlineAtMs, // #2781: phases budget sub-work from remaining time
      privateQueueOwnerJobId: job.id,
      ...(sourceId ? { sourceId } : {}),
      ...(effectivePhases !== undefined ? { phases: effectivePhases as any } : {}),
      yieldBetweenPhases: async () => {
        // Yield to the event loop so worker lock-renewal can fire.
        await new Promise<void>(r => setImmediate(r));
      },
    });

    return {
      partial: report.status === 'partial' || report.status === 'failed',
      status: report.status,
      report,
      // Surfaced so operators can see the queue-boundary normalization at
      // work in job results (runCycle never sees rejected phases, so its
      // excludedPhases skip-reporting cannot cover them).
      ...(phasesRejectedByNormalization.length > 0
        ? { phases_rejected_by_normalization: phasesRejectedByNormalization }
        : {}),
    };
  });

  // Brain-wide maintenance. Runs mixed + global phases ONCE per window instead
  // of repeating cross-source transcript/reflection reads in every source.
  // No source_id → uses the legacy global cycle lock; stamps autopilot.last_global_at
  // on success so the dispatch gate backs off.
  worker.register('autopilot-global-maintenance', async (job) => {
    const { runCycle, MAINTENANCE_PHASES, LAST_GLOBAL_AT_KEY } = await import('../core/cycle.ts');
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? null;

    // #4250: queued maintenance payloads are machine-authored too — intersect
    // with MAINTENANCE_PHASES so a stale (or remote-submitted) payload can't
    // run source-scoped phases through the global lane, symmetric with the
    // per-source normalization in the autopilot-cycle handler.
    const maintenanceSet = new Set<string>(MAINTENANCE_PHASES);
    const requested = Array.isArray(job.data.phases)
      ? (job.data.phases as string[]).filter((p) => maintenanceSet.has(p))
      : MAINTENANCE_PHASES;
    const phases = (requested.length > 0 ? requested : MAINTENANCE_PHASES) as typeof MAINTENANCE_PHASES;

    const report = await runCycle(engine, {
      brainDir: repoPath,
      pull: false, // brain-wide DB/maintenance work never git-pulls
      signal: job.signal,
      deadlineAtMs: job.deadlineAtMs, // #2781: phases budget sub-work from remaining time
      // The maintenance lane is where synthesize/patterns actually run on
      // multi-source brains (per-source payloads normalize down to the
      // freshness phases) — without the owner id its private queues would be
      // owner-less and recovery would degrade to lease-expiry only.
      privateQueueOwnerJobId: job.id,
      phases,
      forceGlobalOrphans: true,
      yieldBetweenPhases: async () => { await new Promise<void>((r) => setImmediate(r)); },
    });

    // Stamp last_global_at only on a non-failed run so a failed pass stays stale
    // and re-dispatches next tick (self-healing retry).
    if (report.status === 'ok' || report.status === 'clean' || report.status === 'partial') {
      try {
        await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date().toISOString());
      } catch (e) {
        console.warn(`[autopilot-global-maintenance] failed to stamp last_global_at: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      partial: report.status === 'partial' || report.status === 'failed',
      status: report.status,
      report,
    };
  });

  // Shell handler is always registered. Runtime env guard lives inside the
  // handler so claimed jobs emit a clear rejection log on workers missing
  // GBRAIN_ALLOW_SHELL_JOBS=1.
  {
    const { shellHandler } = await import('../core/minions/handlers/shell.ts');
    worker.register('shell', shellHandler);
    if (!quiet) {
      if (process.env.GBRAIN_ALLOW_SHELL_JOBS === '1') {
        process.stderr.write('[minion worker] shell handler enabled (GBRAIN_ALLOW_SHELL_JOBS=1)\n');
      } else {
        process.stderr.write('[minion worker] shell handler registered in guarded mode (set GBRAIN_ALLOW_SHELL_JOBS=1 to execute shell jobs)\n');
      }
    }
  }

  // v0.15 subagent handlers: always-on. Unlike shell (which needs an env
  // flag because of RCE surface), subagent only calls the Anthropic API
  // with the operator's own ANTHROPIC_API_KEY — no key, the SDK call
  // fails immediately. Who-can-submit is already gated by
  // PROTECTED_JOB_NAMES + TrustedSubmitOpts (MCP can't submit subagent
  // jobs; only the CLI path with allowProtectedSubmit can). No separate
  // cost-ceremony env flag needed.
  const { makeSubagentHandler } = await import('../core/minions/handlers/subagent.ts');
  const { subagentAggregatorHandler } = await import('../core/minions/handlers/subagent-aggregator.ts');
  worker.register('subagent', makeSubagentHandler({ engine }));
  worker.register('subagent_aggregator', subagentAggregatorHandler);
  process.stderr.write('[minion worker] subagent handlers enabled\n');

  // ============================================================
  // v0.38 ingestion substrate — ingest_capture handler. Receives
  // IngestionEvent payloads from the daemon's dispatcher (file-watcher,
  // inbox-folder, cron-scheduler sources) and from serve --http's
  // POST /ingest route (webhook source). Routes through importFromContent
  // to land as a brain page under inbox/YYYY-MM-DD-<hash6> (or the
  // caller-provided slug).
  // ============================================================
  const { makeIngestCaptureHandler } = await import('../core/minions/handlers/ingest-capture.ts');
  worker.register('ingest_capture', makeIngestCaptureHandler(engine));

  // ============================================================
  // v0.36+ brain-health-100 wave: 11 new handlers for autonomous
  // remediation via `gbrain doctor --remediate` and autopilot.
  //
  // PROTECTED via PROTECTED_JOB_NAMES (D11): synthesize, patterns,
  // consolidate — they internally submit `subagent` jobs with
  // allowProtectedSubmit=true, so they CAN spend Anthropic credits.
  // Open handlers (DB writes only): reindex, repair-jsonb, orphans,
  // integrity, purge, extract_facts, resolve_symbol_edges,
  // recompute_emotional_weight.
  // ============================================================

  worker.register('reindex', async (job) => {
    const { runReindex } = await import('./reindex.ts');
    const args: string[] = ['--markdown'];
    if (typeof job.data.limit === 'number') args.push('--limit', String(job.data.limit));
    if (job.data.dryRun) args.push('--dry-run');
    if (job.data.noEmbed) args.push('--no-embed');
    if (typeof job.data.repoPath === 'string') args.push('--repo', job.data.repoPath);
    const result = await runReindex(engine, args);
    return { ...result, ran: 'reindex' };
  });

  worker.register('repair-jsonb', async (job) => {
    const { repairJsonb } = await import('./repair-jsonb.ts');
    const dryRun = !!job.data.dryRun;
    const result = await repairJsonb({ dryRun });
    return result;
  });

  worker.register('orphans', async (_job) => {
    const result = await engine.findOrphanPages();
    return { count: result.length, orphans: result };
  });

  worker.register('integrity', async (job) => {
    const { runIntegrity } = await import('./integrity.ts');
    const args: string[] = [];
    args.push(job.data.mode === 'auto' ? 'auto' : 'check');
    if (typeof job.data.confidence === 'number') args.push('--confidence', String(job.data.confidence));
    if (job.data.dryRun) args.push('--dry-run');
    await runIntegrity(args);
    return { ran: 'integrity', mode: args[0] };
  });

  worker.register('purge', async (job) => {
    const scope = (typeof job.data.scope === 'string' && ['pages', 'sources', 'all'].includes(job.data.scope))
      ? (job.data.scope as 'pages' | 'sources' | 'all')
      : 'all';
    const olderThanHours = typeof job.data.olderThanHours === 'number' ? job.data.olderThanHours : 72;
    const dryRun = !!job.data.dryRun;
    let pagesPurged = 0;
    let sourcesPurged: string[] = [];
    if (scope === 'pages' || scope === 'all') {
      const result = await engine.purgeDeletedPages(olderThanHours);
      pagesPurged = result.count;
    }
    let sourcesBlocked: Array<{ id: string; reason: string }> = [];
    if (scope === 'sources' || scope === 'all') {
      const { purgeExpiredSources } = await import('../core/destructive-guard.ts');
      const purgeResult = await purgeExpiredSources(engine);
      sourcesPurged = purgeResult.purged;
      sourcesBlocked = purgeResult.blocked;
    }
    // GC stale op_checkpoints rows (folded scope item +C from review).
    const { purgeStaleCheckpoints } = await import('../core/op-checkpoint.ts');
    const checkpointsPurged = await purgeStaleCheckpoints(engine, 7);
    return { pagesPurged, sourcesPurged, sourcesBlocked, checkpointsPurged, dryRun };
  });

  // Phase-wrapper handlers — each delegates to runCycle({ phases: [name] }).
  // Cycle owns the lock + abort signal + progress reporter per D10.
  // Smaller diff than full standalone phase extraction; cycle.ts remains
  // the single source of truth for phase semantics.
  const makePhaseHandler = (phase: string) => async (job: any) => {
    const { runCycle } = await import('../core/cycle.ts');
    // v0.41.38 (codex P2 review): fall back to null (NOT cwd '.') when no repo
    // is configured, matching the autopilot-cycle handler + `gbrain dream`. On a
    // checkout-less postgres brain a filesystem phase (synthesize/patterns/...)
    // skips with reason 'no_brain_dir' instead of running against the worker cwd;
    // DB-only phases (resolve_symbol_edges/embed/...) ignore brainDir either way.
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : ((await engine.getConfig('sync.repo_path')) ?? null);
    const report = await runCycle(engine, {
      brainDir: repoPath,
      phases: [phase as any],
      signal: job.signal,
      deadlineAtMs: job.deadlineAtMs, // #2781: phases budget sub-work from remaining time
      privateQueueOwnerJobId: job.id,
    });
    return { phase, status: report.status, report };
  };

  // PROTECTED — internally spawn subagent children
  registerBuiltinJob(worker, engine, 'synthesize', makePhaseHandler('synthesize'));
  registerBuiltinJob(worker, engine, 'patterns', makePhaseHandler('patterns'));
  registerBuiltinJob(worker, engine, 'consolidate', makePhaseHandler('consolidate'));

  // Open — DB writes only, no LLM spend
  registerBuiltinJob(worker, engine, 'extract_facts', makePhaseHandler('extract_facts'));
  worker.register('resolve_symbol_edges', makePhaseHandler('resolve_symbol_edges'));
  worker.register('recompute_emotional_weight', makePhaseHandler('recompute_emotional_weight'));

  // v0.42.x (#1685 GAP D) — PROTECTED bounded extract_atoms backlog drain.
  // Thin wrapper over the shared helper (DECISION 5A) so the CLI `--drain`
  // path, this handler, and autopilot's auto-drain can't diverge on lock id /
  // window / defer behavior. On LockUnavailableError (the routine cycle holds
  // the per-source lock) the job completes `{ deferred: true }` and retries
  // next tick instead of failing — cooperative interleave (CODEX accepted).
  registerBuiltinJob(worker, engine, 'extract-atoms-drain', async (job) => {
    const { runExtractAtomsDrainForSource } = await import('../core/cycle/extract-atoms-drain.ts');
    const { LockUnavailableError } = await import('../core/db-lock.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    const windowSeconds =
      typeof job.data.window === 'number' && job.data.window > 0 ? job.data.window : 120;
    const repoPath =
      typeof job.data.repoPath === 'string'
        ? job.data.repoPath
        : ((await engine.getConfig('sync.repo_path')) ?? undefined);
    try {
      const result = await runExtractAtomsDrainForSource(engine, {
        sourceId,
        windowSeconds,
        brainDir: repoPath,
      });
      // issue #3218: every item the drain attempted failed (0 succeeded, >=1
      // provider error) — completing this job normally would mark the
      // durable job done while the backlog sits untouched, and no retry
      // policy would ever fire on it again. Throw so the worker's ordinary
      // failJob path (attempt+backoff, or dead-letter once exhausted) takes
      // over instead — matching the existing behavior for every other
      // handler failure. Partial success (>=1 item extracted) keeps
      // completing normally, unchanged.
      if (result.status === 'provider_failure') {
        throw new Error(
          `extract-atoms-drain: all provider calls failed this batch ` +
          `(batches=${result.batches}, remaining=${result.remaining ?? '?'}) — retrying`,
        );
      }
      return result;
    } catch (e) {
      if (e instanceof LockUnavailableError) {
        return { phase: 'extract_atoms', status: 'skipped', deferred: true, reason: 'cycle_already_running' };
      }
      throw e;
    }
  });

  // v0.40 Federated Sync v2 — embed-backfill: per-source decoupled embed.
  // Cost-bounded via D6 ($10/job BudgetTracker) + D19 (source-level cooldown
  // + 24h rolling cap, gated at submit time). NOT in PROTECTED_JOB_NAMES —
  // embedding-only spend, no API-by-the-minute risk like subagent.
  registerBuiltinJob(worker, engine, 'embed-backfill', async (job) => {
    const { makeEmbedBackfillHandler } = await import('../core/minions/handlers/embed-backfill.ts');
    return await makeEmbedBackfillHandler(engine)(job);
  });
  // connector-sync: fetch a chat provider's history and ingest it. Fetch+ingest
  // needs no LLM, but the PGLite embed kickoff calls runEmbedCore inline, so
  // it's in GATEWAY_REFRESH_JOB_NAMES (gateway refresh before the handler).
  registerBuiltinJob(worker, engine, 'connector-sync', async (job) => {
    const { makeConnectorSyncHandler } = await import('../core/minions/handlers/connector-sync.ts');
    return await makeConnectorSyncHandler(engine)(job);
  });

  // v0.41.18.0 (A10, T7): extract-ner handler for the gbrain onboard
  // remediation pipeline. Wraps extractNerLinks; emits typed_ner kind
  // alongside the by-mention 'plain' kind. NOT in PROTECTED_JOB_NAMES
  // (regex-only, no LLM spend).
  worker.register('extract-ner', async (job) => {
    const { extractNerLinks } = await import('../core/extract-ner.ts');
    const data = (job.data ?? {}) as { sourceId?: string };
    return await extractNerLinks(engine, {
      sourceIdFilter: data.sourceId,
    });
  });

  // v0.41.18.0 (A12, T9): extract-takes-from-pages handler. PROTECTED
  // (LLM-bearing). Two-gate consent enforced at the handler boundary:
  // refuses to run unless takes.bootstrap_enabled config is true, even
  // when allowProtectedSubmit was set at queue.add time.
  registerBuiltinJob(worker, engine, 'extract-takes-from-pages', async (job) => {
    const { extractTakesFromPages } = await import('../core/extract-takes-from-pages.ts');
    const data = (job.data ?? {}) as { sourceId?: string; maxPages?: number };
    const bootstrapCfg = await engine.getConfig('takes.bootstrap_enabled');
    const bootstrapEnabled = bootstrapCfg === 'true' || bootstrapCfg === '1';
    return await extractTakesFromPages(engine, {
      bootstrapEnabled,
      sourceIdFilter: data.sourceId,
      maxPages: data.maxPages,
    });
  });

  // v0.41.18.0 (A11, T8): extract-timeline-from-meetings handler. Wraps
  // extractTimelineFromMeetings. NOT in PROTECTED_JOB_NAMES (pure SQL + string
  // scan, no LLM spend).
  worker.register('extract-timeline-from-meetings', async (job) => {
    const { extractTimelineFromMeetings } = await import('../core/extract-timeline-from-meetings.ts');
    const data = (job.data ?? {}) as { sourceId?: string };
    return await extractTimelineFromMeetings(engine, {
      sourceIdFilter: data.sourceId,
    });
  });

  // v0.41.18.0 (A13): embed-catch-up handler for the gbrain onboard
  // remediation pipeline. Wraps runEmbedCore with stale + catchUp + the
  // priority/batchSize the recommendation supplies. NOT in
  // PROTECTED_JOB_NAMES (embedding spend only).
  registerBuiltinJob(worker, engine, 'embed-catch-up', async (job) => {
    const { runEmbedCore } = await import('./embed.ts');
    const data = (job.data ?? {}) as {
      sourceId?: string;
      batchSize?: number;
      priority?: 'recent';
      includeNullSignature?: boolean;
    };
    const catchUpResult = await runEmbedCore(engine, {
      stale: true,
      catchUp: true,
      batchSize: data.batchSize,
      priority: data.priority,
      sourceId: data.sourceId,
      // D7/D12: submitters that detected a NULL-signature cohort thread the
      // widening through; absent = grandfather clause stays (unchanged).
      includeNullSignature: !!data.includeNullSignature,
    });
    // #4599 (X6): stall abort → failed job (throw), same as the embed handler.
    assertEmbedNotStalled(catchUpResult);
    return catchUpResult;
  });

  // v0.42 type-unification (T10): unify-types PROTECTED handler. Pack-upgrade
  // migration that retypes 25K+ pages, creates alias rows, converts edge-
  // shaped pages to link rows, AND flips the active pack at end of run.
  // manual_only via src/core/onboard/render.ts:MANUAL_ONLY_PROTECTED_JOBS.
  // Dry-run preview: `gbrain jobs submit unify-types --allow-protected
  // --params '{"target_pack":"gbrain-base-v2"}'`; apply with
  // '{"target_pack":"gbrain-base-v2","apply":true}'.
  worker.register('unify-types', async (job) => {
    const { runUnifyTypes } = await import('../core/schema-pack/unify-types-handler.ts');
    const data = (job.data ?? {}) as {
      target_pack?: string;
      apply?: boolean;
      sourceId?: string;
    };
    if (!data.target_pack) {
      throw new Error(`unify-types: missing required 'target_pack' parameter`);
    }
    const ctx = {
      engine,
      cfg: null,
      remote: false,
    } as unknown as import('../core/operations.ts').OperationContext;
    return await runUnifyTypes(ctx, {
      target_pack: data.target_pack,
      // #1575: default matches the handler interface's "Default false
      // (dry-run)" — a destructive one-shot migration must be opted into
      // with apply:true (the onboard remediation + the printed migration
      // command both carry it explicitly).
      apply: data.apply ?? false,
      sourceId: data.sourceId,
      onProgress: (msg: string) => {
        job.updateProgress({ phase: 'unify-types', message: msg }).catch(() => {});
        process.stderr.write(msg + '\n');
      },
    });
  });

  // v0.42.0.0 SkillOpt Minion handler — for --background CLI invocations.
  // PROTECTED by name so MCP submission rejects (only trusted CLI can
  // submit). Threaded SkillOptOpts JSON in job.data.
  worker.register('skillopt', async (job) => {
    const { runSkillOpt } = await import('../core/skillopt/orchestrator.ts');
    const data = (job.data ?? {}) as Record<string, unknown>;
    const skillsDir = String(data.skills_dir ?? '');
    const skillName = String(data.skill_name ?? '');
    const benchmarkPath = String(data.benchmark_path ?? '');
    if (!skillsDir || !skillName || !benchmarkPath) {
      throw new Error(`skillopt handler: missing required job.data fields (skills_dir, skill_name, benchmark_path)`);
    }
    const result = await runSkillOpt({
      engine,
      skillName,
      skillsDir,
      benchmarkPath,
      epochs: Number(data.epochs ?? 4),
      batchSize: Number(data.batch_size ?? 8),
      lr: Number(data.lr ?? 4),
      lrSchedule: (data.lr_schedule as 'cosine' | 'linear' | 'constant') ?? 'cosine',
      split: (data.split as [number, number, number]) ?? [4, 1, 5],
      optimizerModel: String(data.optimizer_model ?? 'anthropic:claude-opus-4-7'),
      targetModel: String(data.target_model ?? 'anthropic:claude-sonnet-4-6'),
      judgeModel: String(data.judge_model ?? 'anthropic:claude-sonnet-4-6'),
      mode: (data.mode as 'patch' | 'rewrite') ?? 'patch',
      dryRun: Boolean(data.dry_run),
      noMutate: Boolean(data.no_mutate),
      allowMutateBundled: Boolean(data.allow_mutate_bundled),
      bootstrapReviewed: Boolean(data.bootstrap_reviewed),
      ...(data.held_out_path ? { heldOutPath: String(data.held_out_path) } : {}),
      json: true,
      maxCostUsd: Number(data.max_cost_usd ?? 5.0),
      maxRuntimeMin: Number(data.max_runtime_min ?? 30),
      force: Boolean(data.force),
    });
    return {
      outcome: result.outcome,
      receipt: result.receipt,
      mutated_skill_file: result.mutatedSkillFile,
      proposed_path: result.proposedPath,
    };
  });

  process.stderr.write('[minion worker] brain-health-100 handlers registered (12 ops, 4 protected) + embed-backfill (v0.40) + embed-catch-up (v0.42) + unify-types (v0.42) + skillopt (v0.42.0.0, protected)\n');

  // Plugin discovery — one line per discovered plugin (mirrors the
  // openclaw-seam startup line convention from v0.11+). Loaded
  // unconditionally; empty GBRAIN_PLUGIN_PATH is a no-op.
  try {
    const { loadPluginsFromEnv } = await import('../core/minions/plugin-loader.ts');
    const { BRAIN_TOOL_ALLOWLIST } = await import('../core/minions/tools/brain-allowlist.ts');
    const validNames = new Set<string>();
    for (const n of BRAIN_TOOL_ALLOWLIST) validNames.add(`brain_${n}`);
    const loaded = loadPluginsFromEnv({ validAgentToolNames: validNames });
    for (const w of loaded.warnings) process.stderr.write(w + '\n');
    for (const p of loaded.plugins) {
      process.stderr.write(
        `[plugin-loader] loaded '${p.manifest.name}' v${p.manifest.version} (${p.subagents.length} subagents)\n`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[plugin-loader] discovery failed: ${msg}\n`);
  }
}
