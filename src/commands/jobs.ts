/**
 * CLI handler for `gbrain jobs` subcommands.
 * Thin wrapper around MinionQueue and MinionWorker.
 */

import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { MinionWorker } from '../core/minions/worker.ts';
import { withFactsAbsorbHaltCooldown } from '../core/minions/llm-halt-cooldown.ts';
import type { MinionHandler } from '../core/minions/types.ts';
import { makeAutopilotCycleHandler } from '../core/minions/handlers/autopilot-cycle.ts';
import { makeAutopilotGlobalMaintenanceHandler } from '../core/minions/handlers/autopilot-global-maintenance.ts';
import { makeBacklinksHandler } from '../core/minions/handlers/backlinks.ts';
import { makeChronicleExtractHandler } from '../core/minions/handlers/chronicle-extract.ts';
import { makeCyclePhaseHandler } from '../core/minions/handlers/cycle-phase.ts';
import { makeEmbedCatchUpHandler } from '../core/minions/handlers/embed-catch-up.ts';
import { makeEmbedHandler } from '../core/minions/handlers/embed.ts';
import { makeEnrichHandler } from '../core/minions/handlers/enrich.ts';
import { makeExtractAtomsDrainHandler } from '../core/minions/handlers/extract-atoms-drain.ts';
import { makeExtractConversationFactsHandler } from '../core/minions/handlers/extract-conversation-facts.ts';
import { makeExtractNerHandler } from '../core/minions/handlers/extract-ner.ts';
import { makeExtractTakesFromPagesHandler } from '../core/minions/handlers/extract-takes-from-pages.ts';
import { makeExtractTimelineFromMeetingsHandler } from '../core/minions/handlers/extract-timeline-from-meetings.ts';
import { makeExtractHandler } from '../core/minions/handlers/extract.ts';
import { makeFactsAbsorbHandler } from '../core/minions/handlers/facts-absorb.ts';
import { makeImportHandler } from '../core/minions/handlers/import.ts';
import { integrityAutoHandler } from '../core/minions/handlers/integrity-auto.ts';
import { integrityHandler } from '../core/minions/handlers/integrity.ts';
import { makeLintFixHandler } from '../core/minions/handlers/lint-fix.ts';
import { makeLintHandler } from '../core/minions/handlers/lint.ts';
import { makeLoopsExtractHandler } from '../core/minions/handlers/loops-extract.ts';
import { makeOrphansHandler } from '../core/minions/handlers/orphans.ts';
import { makePurgeHandler } from '../core/minions/handlers/purge.ts';
import { makeReindexHandler } from '../core/minions/handlers/reindex.ts';
import { repairJsonbHandler } from '../core/minions/handlers/repair-jsonb.ts';
import { makeSyncRetryFailedHandler } from '../core/minions/handlers/sync-retry-failed.ts';
import { makeSyncHandler } from '../core/minions/handlers/sync.ts';
import { makeUnifyTypesHandler } from '../core/minions/handlers/unify-types.ts';
import { runJobsAuthorizeLegacy } from './jobs/authorize-legacy.ts';
import { runJobsSubmit } from './jobs/submit.ts';
import { runJobsList } from './jobs/list.ts';
import { runJobsGet } from './jobs/get.ts';
import { runJobsCancel } from './jobs/cancel.ts';
import { runJobsRetry } from './jobs/retry.ts';
import { runJobsDelete } from './jobs/delete.ts';
import { runJobsPrune } from './jobs/prune.ts';
import { runJobsStats } from './jobs/stats.ts';
import { runJobsSmoke } from './jobs/smoke.ts';
import { runJobsChildReadiness } from './jobs/child-readiness.ts';
import { runJobsRunChild } from './jobs/run-child.ts';
import { runJobsWork } from './jobs/work.ts';
import { runJobsSupervisor } from './jobs/supervisor.ts';
import { runJobsWatch } from './jobs/watch.ts';
import type { JobsCommandContext } from './jobs/shared.ts';

// Moved to src/core/minions/handlers/ (refactor wave 1); re-exported so importers keep this path.
export { resolveJobPull } from '../core/minions/handlers/job-pull.ts';
export { factsAbsorbShouldRetry, factsAbsorbUnavailable } from '../core/minions/handlers/facts-absorb.ts';
// Subcommand helpers moved to src/commands/jobs/ (refactor wave 1); re-exported for the same reason.
export {
  formatJobDetail,
  parseJobIsolationFlag,
  parseMaxRssFlag,
  parseMaxWaitingFlag,
  parseNiceFlag,
  rehydrateJobDates,
  resolveWorkerConcurrency,
  type JobIsolationMode,
} from './jobs/shared.ts';
export { maybeRunWorkerStartupRecovery } from './jobs/work.ts';

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

// Job names whose handlers call the LLM gateway: registerBuiltinJob wraps
// them with refreshGatewayForJob so file-plane keys + DB-plane model config
// reach a long-lived worker. Drift guard: test/jobs-gateway-refresh-set.test.ts
// pins this set against the registerBuiltinJob call sites — a gateway-using
// handler registered via bare worker.register() runs with a stale gateway
// (the #3387 chronicle_extract silent-no_events class).
export const GATEWAY_REFRESH_JOB_NAMES = new Set([
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

/**
 * The full jobs help block. Hoisted to a constant so `gbrain jobs --help`
 * (routed engine-free via cli.ts SELF_HELP_WITHOUT_ENGINE) and bare
 * `gbrain jobs` print the same text. Issue: jobs --help used to print the
 * generic CLI stub because 'jobs' was missing from CLI_ONLY_SELF_HELP.
 */
const JOBS_HELP = `gbrain jobs — Minions job queue

USAGE
  gbrain jobs authorize-legacy --ids 12,34 [--expect <snapshot_digest> --yes] [--json]
  gbrain jobs authorize-legacy --select "status=waiting|paused,name=synthesize" [--expect <hash> --yes] [--json]
  gbrain jobs submit <name> [--params JSON] [--follow] [--priority N]
                            [--delay Nms] [--max-attempts N] [--max-stalled N]
                            [--max-waiting N]
                            [--backoff-type fixed|exponential] [--backoff-delay Nms]
                            [--backoff-jitter 0..1] [--timeout-ms Nms]
                            [--lock-duration-ms Nms]
                            [--idempotency-key K] [--queue Q] [--dry-run]
                            [--yes] [--max-usd USD|off]  (enrich, subagent: paid)
                            [--redact-secrets]   (shell only; scrubs inherit
                                                  values from stdout/stderr)
  gbrain jobs list [--status S] [--queue Q] [--limit N] [--json]
  gbrain jobs list --group SPEND_GROUP [--json]
  gbrain jobs get <id> [--json]
  gbrain jobs cancel <id> | --group SPEND_GROUP
  gbrain jobs cancel --select "status=waiting|paused,name=synthesize" [--expect <hash> --yes] [--json]
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
      stop         Send SIGTERM to the supervisor, wait up to 45s for
                   graceful drain, report outcome (--queue names the
                   queue lock to verify when the audit log cannot).
                   Exits 0 only on a verified drain: the supervisor's own
                   stopped row says drained, its workers are gone and its
                   lock is released; otherwise exits 1 naming the check.

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
  shell             Run a command or argv. Requires --allow-shell-jobs (or
                    GBRAIN_ALLOW_SHELL_JOBS=1) on the worker. Params: {cmd?,
                    argv?, cwd, env?}. See: docs/guides/minions-shell-jobs.md

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
  work: `gbrain jobs work — start a worker daemon (PGLite: drain the queue and exit)

USAGE
  gbrain jobs work [--queue Q] [--concurrency N] [--max-rss MB]
                   [--health-interval MS] [--nice N]
                   [--job-isolation inline|process] [--allow-shell-jobs]

OPTIONS
  --queue Q            Queue to claim from (default: default)
  --allow-shell-jobs   Enable the shell handler on this worker. Equivalent to
                       exporting GBRAIN_ALLOW_SHELL_JOBS=1 from your shell; a
                       .env in the working directory cannot set it.
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
  PGLite's exclusive file lock cannot host a long-lived daemon: there it runs
  the waiting jobs in the foreground and exits once the queue is drained
  (stop any running \`gbrain serve\` first). On Postgres prefer:
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
                            [--idempotency-key K] [--queue Q] [--queue-only]
                            [--dry-run] [--redact-secrets]

OPTIONS
  --params JSON        Job payload (handler-specific; see HANDLER TYPES in
                       'gbrain jobs --help')
  --follow             Run inline and stream progress (works on both engines;
                       required on PGLite, which has no background worker)
  --queue-only         PGLite: queue without running (\`gbrain jobs work\` drains)
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
  'authorize-legacy': `gbrain jobs authorize-legacy — review old queued work locally

USAGE
  gbrain jobs authorize-legacy --ids 12,34 --json
  gbrain jobs authorize-legacy --ids 12,34 --expect <snapshot_digest> --yes --json
  gbrain jobs authorize-legacy --select "status=waiting|paused,name=synthesize|ingest_capture" [--json]
  gbrain jobs authorize-legacy --select "status=waiting|paused,name=synthesize|ingest_capture" --expect <hash> --yes

Stop producers (gbrain serve, gbrain autopilot) and workers and cancel active jobs
first. A command without --yes only previews; apply requires the exact reviewed hash
and --yes. --select keys: status (waiting, delayed, waiting-children, paused,
completed, failed) and name, each taking | alternatives. The --select preview lists
counts by job name and status, the first 20 ids and the preview hash, and the apply
authorizes exactly the previewed set. Dependencies are shown but never implicitly
authorized. IDs, data, schedule and retries persist.
`,
  cancel: `gbrain jobs cancel — cancel a job, or preview-bound bulk cancel of legacy jobs

USAGE
  gbrain jobs cancel <id> | --group SPEND_GROUP   (--group: every unfinished job of one paid command's approval)
  gbrain jobs cancel --select "status=waiting|paused,name=synthesize" [--json]
  gbrain jobs cancel --select "status=waiting|paused,name=synthesize" --expect <hash> --yes

--select picks live jobs whose submission authority is missing or unsupported
(the rows that block workers after an upgrade across v0.50). Keys: status
(waiting, delayed, waiting-children, paused) and name, each taking | alternatives.
Without --yes it only previews: counts by job name and status, the first 20 ids,
parents that return to waiting, and the preview hash. The apply cancels exactly
the previewed set; a selection that would cascade to a job outside it refuses.
Stop producers and workers and cancel active jobs (gbrain jobs cancel <id>) first.
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

/** `gbrain jobs <sub>` dispatch table; runJobs resolves help and the thin-client refusal first. */
const JOBS_SUBCOMMANDS: Record<string, (ctx: JobsCommandContext) => Promise<void>> = {
  'authorize-legacy': runJobsAuthorizeLegacy,
  submit: runJobsSubmit,
  list: runJobsList,
  get: runJobsGet,
  cancel: runJobsCancel,
  retry: runJobsRetry,
  delete: runJobsDelete,
  prune: runJobsPrune,
  stats: runJobsStats,
  smoke: runJobsSmoke,
  'child-readiness': runJobsChildReadiness,
  'run-child': runJobsRunChild,
  work: runJobsWork,
  supervisor: runJobsSupervisor,
  watch: runJobsWatch,
};

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
  const localSupervisorStatus = sub === 'supervisor' && args[1] === 'status';
  if (!engineOrNull && sub !== 'list' && sub !== 'get' && !localSupervisorStatus) {
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

  const run = Object.hasOwn(JOBS_SUBCOMMANDS, sub) ? JOBS_SUBCOMMANDS[sub] : undefined;
  if (!run) {
    console.error(`Unknown subcommand: ${sub}. Run 'gbrain jobs --help' for usage.`);
    process.exit(1);
  }
  await run({ args, engine, engineOrNull, queue });
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
  worker.register('sync', makeSyncHandler(engine));
  registerBuiltinJob(worker, engine, 'embed', makeEmbedHandler(engine));
  worker.register('lint', makeLintHandler(engine));
  registerBuiltinJob(worker, engine, 'extract-conversation-facts', makeExtractConversationFactsHandler(engine));
  registerBuiltinJob(worker, engine, 'chronicle_extract', makeChronicleExtractHandler(engine));
  registerBuiltinJob(worker, engine, 'loops_extract', makeLoopsExtractHandler(engine));
  registerBuiltinJob(worker, engine, 'enrich', makeEnrichHandler(engine));
  worker.register('lint-fix', makeLintFixHandler(engine));
  worker.register('integrity-auto', integrityAutoHandler);
  worker.register('sync-retry-failed', makeSyncRetryFailedHandler(engine));
  worker.register('import', makeImportHandler(engine));
  worker.register('extract', makeExtractHandler(engine));
  worker.register('backlinks', makeBacklinksHandler(engine));
  registerBuiltinJob(worker, engine, 'facts-absorb', withFactsAbsorbHaltCooldown(makeFactsAbsorbHandler(engine)));

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

  registerBuiltinJob(worker, engine, 'autopilot-cycle', makeAutopilotCycleHandler(engine));
  worker.register('autopilot-global-maintenance', makeAutopilotGlobalMaintenanceHandler(engine));

  // Shell handler is always registered. Runtime guard lives inside the handler
  // so claimed jobs emit a clear rejection log on workers started without
  // --allow-shell-jobs (the flag sets GBRAIN_ALLOW_SHELL_JOBS=1 after preflight).
  {
    const { shellHandler } = await import('../core/minions/handlers/shell.ts');
    worker.register('shell', shellHandler);
    if (!quiet) {
      if (process.env.GBRAIN_ALLOW_SHELL_JOBS === '1') {
        process.stderr.write('[minion worker] shell handler enabled (--allow-shell-jobs / GBRAIN_ALLOW_SHELL_JOBS=1)\n');
      } else {
        process.stderr.write('[minion worker] shell handler registered in guarded mode (start with `gbrain jobs work --allow-shell-jobs`, or export GBRAIN_ALLOW_SHELL_JOBS=1, to execute shell jobs)\n');
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

  worker.register('reindex', makeReindexHandler(engine));
  worker.register('repair-jsonb', repairJsonbHandler);
  worker.register('orphans', makeOrphansHandler(engine));
  worker.register('integrity', integrityHandler);
  worker.register('purge', makePurgeHandler(engine));

  // PROTECTED — internally spawn subagent children
  registerBuiltinJob(worker, engine, 'synthesize', makeCyclePhaseHandler(engine, 'synthesize'));
  registerBuiltinJob(worker, engine, 'patterns', makeCyclePhaseHandler(engine, 'patterns'));
  registerBuiltinJob(worker, engine, 'consolidate', makeCyclePhaseHandler(engine, 'consolidate'));

  // Open — DB writes only, no LLM spend
  registerBuiltinJob(worker, engine, 'extract_facts', makeCyclePhaseHandler(engine, 'extract_facts'));
  worker.register('resolve_symbol_edges', makeCyclePhaseHandler(engine, 'resolve_symbol_edges'));
  worker.register('recompute_emotional_weight', makeCyclePhaseHandler(engine, 'recompute_emotional_weight'));
  registerBuiltinJob(worker, engine, 'extract-atoms-drain', makeExtractAtomsDrainHandler(engine));

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

  worker.register('extract-ner', makeExtractNerHandler(engine));
  registerBuiltinJob(worker, engine, 'extract-takes-from-pages', makeExtractTakesFromPagesHandler(engine));
  worker.register('extract-timeline-from-meetings', makeExtractTimelineFromMeetingsHandler(engine));
  registerBuiltinJob(worker, engine, 'embed-catch-up', makeEmbedCatchUpHandler(engine));
  worker.register('unify-types', makeUnifyTypesHandler(engine));

  // v0.42.0.0 SkillOpt Minion handler — for --background CLI invocations.
  // PROTECTED by name so MCP submission rejects (only trusted CLI can
  // submit). Body in skillopt/job.ts: re-resolves the role models and re-runs
  // the strict check at execution time.
  worker.register('skillopt', async (job) =>
    (await import('../core/skillopt/job.ts')).runSkillOptJob(engine, job.data));

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
