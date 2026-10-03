/**
 * `gbrain sync` CLI flag parsing and usage text (refactor wave 1, W4 sync).
 * Invalid values print the same messages and exit with the same codes as
 * before; parsing is split in two because `--break-lock` runs (and exits)
 * between the two halves.
 */
import { loadConfig } from '../../core/config.ts';
import { parseDurationSeconds, parseWorkers } from '../../core/sync-concurrency.ts';
import { resolveNoEmbed } from '../../core/sync-git.ts';
import type { SyncOpts } from '../sync.ts';
import { parseMissingPathMode } from './missing-path.ts';
import type { MissingPathMode } from './missing-path.ts';

export function printSyncHelp(): void {
  console.log(`Usage: gbrain sync [options]

Sync the brain repo's text content into the engine, then embed.

Options:
  --no-embed           Skip the embed step. Use this when the embed
                       provider is misconfigured or you want to defer
                       embedding (run 'gbrain embed --stale' later).
  --no-extract         Skip the link/timeline extraction step. Pages will
                       show as stale in 'gbrain doctor'; run
                       'gbrain extract --stale' later to catch up.
  --workers N          Run the import phase with N parallel workers
                       (alias: --concurrency). Default: 4 when the
                       diff is >100 files, else serial.
  --source <id>        Scope sync to a single source. Defaults to the
                       brain's default source.
  --repo <path>        Path to the brain repo. Defaults to the path
                       saved by 'gbrain init'.
  --full               Force a full re-sync (rare; usually incremental).
  --src-subpath <dir>  Sync only this subdirectory of the git repo (monorepo
                       pattern: N logical sources in one repo). Git pull/diff
                       run at the repo root; imports are scoped to the subdir
                       and slugs stay root-relative (wiki/page1). Passing the
                       subdirectory directly as --repo also works.
  --exclude <glob>     Exclude files matching the glob from sync (repeatable;
                       matched against the scope-relative path).
  --include-hidden <glob>
                       Waive the leading-dot prune (.git, .obsidian, and any
                       other dot-prefixed directory — but NOT node_modules/
                       vendor/dist/build/venv/*.raw, which are never
                       waivable) for paths matching this glob (repeatable).
                       Does not reach a non-git directory's FS-walk import
                       fallback; every git-tracked source (the normal case)
                       is covered. Cannot combine with --all; persist it as
                       the sync.include_hidden config key (gbrain config set
                       sync.include_hidden '<globs>') so --all, autopilot and
                       the dream cycle honor it.
  --include-gitignored Include otherwise-syncable files matched by .gitignore.
                       Forces a full filesystem walk so periodic syncs see
                       ignored untracked content.
  --working-tree       Also import uncommitted working-tree state (untracked
                       files + uncommitted edits/deletes). Default: committed
                       changes only — uncommitted drift is counted and warned,
                       never silently ignored. Persist with
                       'gbrain config set sync.include_working_tree true'.
                       Caution: imports untracked files as-is — unignored
                       scratch files and secrets included; review 'git status'
                       before enabling, especially as persisted config.
  --dry-run            Show what would be synced without writing.
  --skip-failed        Acknowledge previously-recorded sync failures so
                       the bookmark can advance past unparseable files.
  --retry-failed       Re-attempt previously-failed files; clear on success.
  --reset-checkpoint   Connector source only: re-walk its window once from an empty
                       checkpoint; unchanged pages are not admitted again.
  --watch              Re-sync continuously on an interval.
  --interval N         Watch-mode interval in seconds (default 60).
  --no-pull            Skip 'git pull' before the sync (useful for tests).
  --no-delegate        On a PGLite brain with a live 'gbrain serve', sync
                       normally delegates the run to the serve process over
                       its IPC socket (the lock owner does the work; embeds
                       defer to serve's background sweep). This flag (or
                       GBRAIN_SYNC_NO_DELEGATE=1) opts out — sync then fails
                       fast if a live serve holds the brain.
  --no-schema-pack     Skip loading the active schema pack (no per-file pack
                       regex runs; pages use legacy prefix typing). Escape
                       hatch if a suspect pack regex is wedging sync.
                       GBRAIN_SYNC_TRACE=1 names the file being imported (hang triage).
  --all                Sync every registered source instead of just the
                       default (multi-source brains).
  --parallel N         (with --all) Run up to N sources concurrently.
                       Default: min(sourceCount, --workers, 4). Each
                       source takes its own per-source DB lock
                       (gbrain-sync:<source_id>) so independent sources
                       sync without contending. Total live Postgres
                       connections per wave ≈ parallel × workers × 2
                       (per-file pool) + parent pool. Pass --parallel 1
                       to force serial.
  --missing-path M     (with --all) What to do when a source's local_path
                       does not exist on this machine: 'fail' (default —
                       loud, current behavior) or 'skip' (classify as
                       skipped_missing_path: ⊘ in the aggregate, excluded
                       from error_count and the rc=1 gate). Use skip on
                       brains whose sources were registered from more
                       than one machine.
  --json               Emit a structured JSON envelope on stdout
                       ({schema_version: 1, sources, parallel,
                       ok_count, error_count, skipped_count}). Sources
                       skipped by --missing-path skip appear with
                       status 'skipped_missing_path' and their
                       local_path. All human output routes to stderr
                       (single-source runs too) so '--json | jq'
                       parses cleanly.
                       Exit codes: 0 = all sources ok or skipped,
                       1 = any error, 2 = cost-prompt-not-confirmed.
  --yes                Accept any interactive prompts (CI / non-TTY).

See also:
  gbrain embed --stale    Re-embed all stale chunks (post --no-embed).
  gbrain doctor           Diagnose dim mismatches and other sync issues.
`);
}

// setTimeout treats delays above 2^31-1 ms as ~1 ms; stay within that bound.
const MAX_WATCH_INTERVAL_SECONDS = Math.floor(2_147_483_647 / 1000);

function parseWatchIntervalSeconds(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`--interval must be an integer from 1 to ${MAX_WATCH_INTERVAL_SECONDS} seconds.`);
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WATCH_INTERVAL_SECONDS) {
    throw new Error(`--interval must be an integer from 1 to ${MAX_WATCH_INTERVAL_SECONDS} seconds.`);
  }
  return seconds;
}

/** Flags read before the `--break-lock` branch. */
export function parseSyncFlags(args: string[]) {
  const repoPath = args.find((a, i) => args[i - 1] === '--repo') || undefined;
  const watch = args.includes('--watch');
  const intervalIndex = args.indexOf('--interval');
  let interval = 60;
  if (intervalIndex !== -1) {
    try {
      interval = parseWatchIntervalSeconds(args[intervalIndex + 1]);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');
  const noPull = args.includes('--no-pull');
  let noEmbed = resolveNoEmbed(args, loadConfig());
  const noExtract = args.includes('--no-extract'); // v0.42.7 #1696
  const skipFailed = args.includes('--skip-failed');
  const retryFailed = args.includes('--retry-failed'), resetCheckpoint = args.includes('--reset-checkpoint');
  const noSchemaPack = args.includes('--no-schema-pack'); // v0.41.37.0 #1569
  const explicitProcessing = ([['--no-embed', 'noEmbed'], ['--no-extract', 'noExtract'], ['--no-schema-pack', 'noSchemaPack']] as const)
    .filter(([flag]) => args.includes(flag)).map(([, key]) => key);
  const includeGitignored = args.includes('--include-gitignored');
  // Untracked-gap fix: --working-tree imports uncommitted working-tree state.
  // The config fallback (sync.include_working_tree) resolves inside
  // performSync so every caller honors it; the CLI passes undefined when the
  // flag is absent.
  const workingTree = args.includes('--working-tree') ? true : undefined;
  const syncAll = args.includes('--all');
  let missingPathMode: MissingPathMode = 'fail';
  try {
    missingPathMode = parseMissingPathMode(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (missingPathMode !== 'fail' && !syncAll) {
    // Single-source sync on a missing path should stay loud — an explicit
    // `--source X` naming an absent checkout is an operator error, not a
    // multi-machine artifact. Warn instead of silently ignoring the flag.
    console.error('[gbrain] WARN: --missing-path only applies to `sync --all`; ignored here.');
  }
  const jsonOut = args.includes('--json');
  const yesFlag = args.includes('--yes');
  // v0.41.6.0 D3: lock-recovery flags. --break-lock (safe) verifies the
  // holder is local-host + (TTL-expired OR PID-dead+60s-old) before
  // deleting the row. --force-break-lock skips the liveness check. Both
  // are refused when combined with --all (per-source invocation required;
  // v0.40 lock keys are gbrain-sync:<sourceId>).
  const breakLock = args.includes('--break-lock');
  const forceBreakLock = args.includes('--force-break-lock');

  // v0.41.13.0 (T4 + T16) — --max-age <s>: age-gated lock break via
  // last_refreshed_at semantic (NOT acquired_at — D-V3-4). Only valid with
  // --break-lock; mutually exclusive with --force-break-lock (--force skips
  // every guard; --max-age is one specific extra guard so the two policies
  // can't coexist).
  const maxAgeStr = args.find((a, i) => args[i - 1] === '--max-age');
  let maxAgeSeconds: number | undefined;
  try {
    maxAgeSeconds = parseDurationSeconds(maxAgeStr, '--max-age');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (maxAgeSeconds !== undefined && !breakLock) {
    console.error(`--max-age is only valid with --break-lock.`);
    process.exit(1);
  }
  if (maxAgeSeconds !== undefined && forceBreakLock) {
    console.error(`--max-age cannot be combined with --force-break-lock (force skips all guards).`);
    process.exit(1);
  }
  return { repoPath, watch, interval, dryRun, full, noPull, noEmbed, noExtract, skipFailed, retryFailed, resetCheckpoint, noSchemaPack, explicitProcessing, includeGitignored, workingTree, syncAll, missingPathMode, jsonOut, yesFlag, breakLock, forceBreakLock, maxAgeSeconds };
}

export type SyncFlags = ReturnType<typeof parseSyncFlags>;

/** Flags read after the `--break-lock` branch: fan-out, scope and timeout. */
export function parseSyncFanoutFlags(args: string[], syncAll: boolean) {
  // v0.40 D4+D18: parallel `sync --all` by default; --serial opts back to v1.
  // --no-auto-embed skips the per-source embed-backfill auto-enqueue.
  // --max-sources N caps fan-out (default min(sources.length, 8)).
  const serialFlag = args.includes('--serial');
  const noAutoEmbed = args.includes('--no-auto-embed');
  const maxSourcesStr = args.find((a, i) => args[i - 1] === '--max-sources');
  const maxSources = maxSourcesStr ? parseInt(maxSourcesStr, 10) : undefined;
  if (maxSourcesStr && (!Number.isFinite(maxSources!) || maxSources! < 1)) {
    console.error(`Invalid --max-sources value: "${maxSourcesStr}". Must be a positive integer.`);
    process.exit(1);
  }
  const strategyArg = args.find((a, i) => args[i - 1] === '--strategy') as SyncOpts['strategy'] | undefined;
  // #753/#774: monorepo subdir-source flags. --exclude is repeatable.
  const srcSubpath = args.find((a, i) => args[i - 1] === '--src-subpath') || undefined;
  const excludePatterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude' && i + 1 < args.length) excludePatterns.push(args[i + 1]);
  }
  // --include-hidden is repeatable, same parsing shape as --exclude.
  const includeHiddenPatterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-hidden' && i + 1 < args.length) includeHiddenPatterns.push(args[i + 1]);
  }
  if (syncAll && (srcSubpath || excludePatterns.length > 0 || includeHiddenPatterns.length > 0)) {
    console.error(
      `--src-subpath/--exclude/--include-hidden scope a single sync invocation; they cannot be combined with --all. ` +
      `For --all runs, register the subdirectory as the source's local_path instead ` +
      `(gbrain sources add <id> --path <repo>/<subdir>), persist exclusions with ` +
      `\`gbrain config set sync.exclude <globs>\`, and persist the dot-directory waiver with ` +
      `\`gbrain config set sync.include_hidden <globs>\` so --all, autopilot and the dream cycle honor it.`,
    );
    process.exit(1);
  }
  const concurrencyStr = args.find((a, i) => args[i - 1] === '--concurrency' || args[i - 1] === '--workers');
  const parallelStr = args.find((a, i) => args[i - 1] === '--parallel');
  // v0.22.13 (PR #490 Q2): parseWorkers throws on '0', '-3', 'foo', '1.5' instead
  // of silently falling through to auto-concurrency or NaN. Loud failure beats
  // a 4-worker spawn from a typo. v0.40.3.0: same validation applies to --parallel.
  let concurrency: number | undefined;
  let parallelOverride: number | undefined;
  try {
    concurrency = parseWorkers(concurrencyStr);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  try {
    parallelOverride = parseWorkers(parallelStr);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // v0.41.13.0 (T16 + T6) — --timeout <s>: graceful self-termination signal
  // threaded into performSync via SyncOpts.signal. D-V3-3 invariant: when
  // combined with --all, each source gets its OWN AbortController + countdown
  // inside runOne so the budget is per-source, not shared across the fan-out.
  //
  // Validation: --timeout requires --source OR --all. Bare `gbrain sync
  // --timeout 60` (no source scope) is rejected at parse time — the natural
  // single-source case requires the user to either name the source or opt
  // into the global fan-out, so the error message tells them which to add.
  const timeoutStr = args.find((a, i) => args[i - 1] === '--timeout');
  let timeoutSeconds: number | undefined;
  try {
    timeoutSeconds = parseDurationSeconds(timeoutStr, '--timeout');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const explicitSourceArg = args.find((a, i) => args[i - 1] === '--source');
  if (timeoutSeconds !== undefined && !syncAll && !explicitSourceArg) {
    console.error(`--timeout requires either --source <id> or --all to scope the per-source budget.`);
    process.exit(1);
  }
  return { serialFlag, noAutoEmbed, maxSources, strategyArg, srcSubpath, excludePatterns, includeHiddenPatterns, concurrency, timeoutSeconds, explicitSourceArg };
}

export type SyncFanoutFlags = ReturnType<typeof parseSyncFanoutFlags>;
