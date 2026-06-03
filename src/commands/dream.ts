/**
 * gbrain dream — run one brain maintenance cycle.
 *
 * The README brand promise: "the agent runs while I sleep, the dream
 * cycle ... I wake up and the brain is smarter." Cron-friendly, JSON
 * report, phase-selectable.
 *
 * Thin alias over runCycle (src/core/cycle.ts). Both this command and
 * `gbrain autopilot` converge on the same primitive so there's one
 * source of truth for what "overnight maintenance" means.
 *
 * Usage:
 *   gbrain dream                       # full 6-phase cycle
 *   gbrain dream --dry-run             # preview, no writes
 *   gbrain dream --json                # CycleReport JSON (for agents)
 *   gbrain dream --phase lint          # run a single phase
 *   gbrain dream --pull                # also git pull the brain repo
 *   gbrain dream --dir /path/to/brain  # explicit brain location
 *
 * Cron: 0 2 * * * gbrain dream --json >> /var/log/gbrain-dream.log
 *
 * Related: `gbrain autopilot --install` for continuous daemonized
 * maintenance. dream is the one-shot, autopilot is the scheduler.
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  runCycle,
  ALL_PHASES,
  type CyclePhase,
  type CycleReport,
} from '../core/cycle.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { fetchSource } from '../core/sources-load.ts';
import { existsSync } from 'fs';
import { resolve } from 'node:path';

interface DreamArgs {
  json: boolean;
  dryRun: boolean;
  pull: boolean;
  phase: CyclePhase | null;
  dir: string | null;
  help: boolean;
  /** v0.21: ad-hoc transcript file path; implies --phase synthesize. */
  inputFile: string | null;
  /** v0.21: restrict synthesize to a single date (YYYY-MM-DD). */
  date: string | null;
  /** v0.21: backfill range start (YYYY-MM-DD). */
  from: string | null;
  /** v0.21: backfill range end (YYYY-MM-DD). */
  to: string | null;
  /**
   * v0.23.2: disable the synthesize phase's self-consumption guard.
   * Long-form flag name to discourage casual use; loud stderr warning fires when set.
   * Never auto-applied for --input (codex finding #3).
   */
  bypassDreamGuard: boolean;
  /**
   * v0.41.13: per-source cycle scoping. Threaded into runCycle as
   * `sourceId` so `cycle.ts:1947-1967` writes `last_full_cycle_at`
   * to `sources.config` on success — without it, `gbrain doctor`'s
   * `cycle_freshness` check stays stale forever. Accepts `--source
   * <id>` and the alias `--source-id <id>` (the v0.37.7.0 #1167
   * canonical name across import/extract/graph-query); both work
   * until a follow-up CLI cleanup picks one. Supersedes PR #1559.
   */
  source: string | null;
  /**
   * issue #1678: bounded single-hold backlog drain. `--drain` (currently only
   * for `--phase extract_atoms`) holds the cycle lock once and loops bounded
   * batches, rediscovering eligibility each batch, until the backlog empties or
   * `--window` seconds elapse. Reports {extracted, skipped, remaining}; exits
   * non-zero when remaining > 0 so a cron/agent loop knows to run again.
   */
  drain: boolean;
  /** Drain wallclock budget in seconds. Default 300 (5 min). */
  windowSeconds: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DRAIN_WINDOW_SECONDS = 300;
/** Exit code for "drain ran but the backlog isn't empty — run again". */
const EXIT_DRAIN_INCOMPLETE = 3;

/**
 * Collect every occurrence of `--<flag> <value>` in argv. Used to
 * detect repeated flags with different values (e.g.
 * `--source X --source Y`) and to surface a clean usage error
 * instead of silently last-wins. Repeated identical values are
 * collapsed to one (no-op). Missing values (flag at end of argv)
 * return null to let the caller raise an explicit usage error
 * rather than fall through with `undefined`.
 */
function collectFlagValues(args: string[], flag: string): string[] | null {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const v = args[i + 1];
    if (v === undefined) return null; // flag at end of argv
    values.push(v);
  }
  return values;
}

function parseArgs(args: string[]): DreamArgs {
  const phaseIdx = args.indexOf('--phase');
  const rawPhase = phaseIdx !== -1 ? args[phaseIdx + 1] : null;
  let phase = rawPhase && (ALL_PHASES as string[]).includes(rawPhase)
    ? (rawPhase as CyclePhase)
    : null;
  if (rawPhase && !phase) {
    console.error(`Unknown phase "${rawPhase}". Valid: ${ALL_PHASES.join(', ')}`);
    process.exit(1);
  }

  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 ? args[dirIdx + 1] : null;

  const inputIdx = args.indexOf('--input');
  const inputFile = inputIdx !== -1 ? args[inputIdx + 1] ?? null : null;

  const dateIdx = args.indexOf('--date');
  const date = dateIdx !== -1 ? args[dateIdx + 1] ?? null : null;
  if (date && !ISO_DATE_RE.test(date)) {
    console.error(`--date must be YYYY-MM-DD; got "${date}"`);
    process.exit(2);
  }

  const fromIdx = args.indexOf('--from');
  const from = fromIdx !== -1 ? args[fromIdx + 1] ?? null : null;
  if (from && !ISO_DATE_RE.test(from)) {
    console.error(`--from must be YYYY-MM-DD; got "${from}"`);
    process.exit(2);
  }

  const toIdx = args.indexOf('--to');
  const to = toIdx !== -1 ? args[toIdx + 1] ?? null : null;
  if (to && !ISO_DATE_RE.test(to)) {
    console.error(`--to must be YYYY-MM-DD; got "${to}"`);
    process.exit(2);
  }
  if (from && to && from > to) {
    console.error(`--from (${from}) is after --to (${to}); empty range`);
    process.exit(2);
  }

  // --input + --date / --from / --to is incoherent: --input is a single
  // file, the date filters scan a directory.
  if (inputFile && (date || from || to)) {
    console.error('--input cannot be combined with --date / --from / --to');
    process.exit(2);
  }

  // --input implies --phase synthesize.
  if (inputFile && !phase) phase = 'synthesize';

  // v0.41.13: --source <id> (and the --source-id alias) drives per-source
  // cycle scoping. Resolution rules:
  //   - missing value (flag at end of argv) → exit 2 with usage
  //   - repeated with different values (e.g. --source X --source Y) → exit 2
  //   - --source X --source-id Y (conflicting flag aliases) → exit 2
  //   - --source X --source X (or --source-id repeated with same value) → accepted
  //   - --help short-circuits BEFORE this block fires (see runDream).
  // Closes the PR #1559 silent-no-op class through a clean argv contract.
  const sourceValues = collectFlagValues(args, '--source');
  const sourceIdValues = collectFlagValues(args, '--source-id');
  if (sourceValues === null) {
    console.error('--source <id>: missing value. Usage: gbrain dream --source <source-id>');
    process.exit(2);
  }
  if (sourceIdValues === null) {
    console.error('--source-id <id>: missing value. Usage: gbrain dream --source-id <source-id>');
    process.exit(2);
  }
  const uniqSource = Array.from(new Set(sourceValues));
  const uniqSourceId = Array.from(new Set(sourceIdValues));
  if (uniqSource.length > 1) {
    console.error(`specify --source once; got [${uniqSource.map(v => `"${v}"`).join(', ')}]`);
    process.exit(2);
  }
  if (uniqSourceId.length > 1) {
    console.error(`specify --source-id once; got [${uniqSourceId.map(v => `"${v}"`).join(', ')}]`);
    process.exit(2);
  }
  if (uniqSource.length === 1 && uniqSourceId.length === 1 && uniqSource[0] !== uniqSourceId[0]) {
    console.error(
      `use --source OR --source-id, not both (different values): ` +
      `--source="${uniqSource[0]}" vs --source-id="${uniqSourceId[0]}"`,
    );
    process.exit(2);
  }
  const source = uniqSource[0] ?? uniqSourceId[0] ?? null;

  // issue #1678: --drain [--window <seconds>]. Only extract_atoms is drainable
  // this wave (it has a real eligibility predicate; synthesize_concepts does
  // not — Codex #12). --drain with no --phase defaults to extract_atoms.
  const drain = args.includes('--drain');
  const windowIdx = args.indexOf('--window');
  let windowSeconds = DEFAULT_DRAIN_WINDOW_SECONDS;
  if (windowIdx !== -1) {
    const raw = args[windowIdx + 1];
    if (raw === undefined || !/^\d+$/.test(raw.trim()) || parseInt(raw, 10) <= 0) {
      console.error(`--window must be a positive integer (seconds); got "${raw}"`);
      process.exit(2);
    }
    windowSeconds = parseInt(raw, 10);
  }
  if (drain) {
    if (!phase) phase = 'extract_atoms';
    else if (phase !== 'extract_atoms') {
      console.error(`--drain currently supports only --phase extract_atoms (got "${phase}")`);
      process.exit(2);
    }
  }

  return {
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    pull: args.includes('--pull'),
    phase,
    dir,
    help: args.includes('--help') || args.includes('-h'),
    inputFile,
    date,
    from,
    to,
    bypassDreamGuard: args.includes('--unsafe-bypass-dream-guard'),
    source,
    drain,
    windowSeconds,
  };
}

/**
 * Resolve the brain directory without the `findRepoRoot` footgun.
 *
 * Resolution order (v0.41.30 — postgres support):
 *   1. An explicit --dir argument (exits 1 if it doesn't exist — a real mistake).
 *   2. T1: when --source resolved to a source that has an on-disk `local_path`,
 *      use it (matches `gbrain sync`, lets that source's filesystem phases run).
 *   3. The legacy `sync.repo_path` config key (pre-v0.18 default-source brains).
 *   4. `null` — no local checkout. The cycle then SKIPS filesystem phases
 *      (lint/backlinks/sync/synthesize/extract/patterns) with reason
 *      `no_brain_dir` and runs the DB-only phases (resolve_symbol_edges, embed,
 *      orphans, ...). This is what makes `gbrain dream` work on a postgres /
 *      Supabase brain with no checkout. `runDream` owns the only hard error:
 *      no checkout AND no engine = truly nothing to run.
 *
 * Still never walks cwd for a `.git` — only the explicit / source / config
 * signals are trusted.
 */
async function resolveBrainDir(
  engine: BrainEngine | null,
  explicit: string | null,
  resolvedSourceId?: string,
): Promise<string | null> {
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`--dir path does not exist: ${explicit}`);
      process.exit(1);
    }
    // Resolve to absolute so downstream writeFileSync(join(brainDir, slug))
    // can't silently land at cwd when explicit is `.` / `./brain` / etc.
    return resolve(explicit);
  }

  // T1: the user scoped to a specific source via --source/--source-id; if that
  // source has a checkout on disk, use it so its filesystem phases can run.
  if (engine && resolvedSourceId) {
    const src = await fetchSource(engine, resolvedSourceId);
    if (src?.local_path && existsSync(src.local_path)) {
      return resolve(src.local_path);
    }
    // Explicit --source whose checkout isn't on disk → DB-only (skip FS phases).
    // Do NOT fall through to the global sync.repo_path below: that path belongs
    // to the default/unscoped brain, and running FS phases (sync/lint/extract)
    // against it while the DB phases AND the last_full_cycle_at stamp target
    // <resolvedSourceId> would mix scopes — syncing one source's checkout while
    // marking a different source fresh. (codex P1 review finding.)
    return null;
  }

  if (engine) {
    const configured = await engine.getConfig('sync.repo_path');
    if (configured && existsSync(configured)) {
      return resolve(configured);
    }
  }

  // No checkout found. Return null (NOT exit) — DB-only phases can still run
  // against the engine. The both-null hard error lives in runDream.
  return null;
}

function printHelp() {
  console.log(`Usage: gbrain dream [options]

Run one brain maintenance cycle. Eight phases:
  lint -> backlinks -> sync -> synthesize -> extract -> patterns -> embed -> orphans

The synthesize + patterns phases (v0.21) consolidate yesterday's
conversation transcripts into reflections, originals, and cross-session
pattern pages. Designed for cron (exits when done).

Options:
  --dry-run           Preview all fixes without writing. Note: synthesize
                      runs the cheap Haiku significance filter (caches
                      verdicts), but skips the Sonnet synthesis pass.
                      "--dry-run" does NOT mean "zero LLM calls."
  --json              Emit the CycleReport as JSON (agent-readable)
  --phase <name>      Run a single phase: ${ALL_PHASES.join(' | ')}
  --pull              git pull the brain repo before syncing (default: no pull)
  --dir <path>        Brain directory (default: configured brain). On a
                      postgres/remote brain with no local checkout, the
                      filesystem phases (lint, backlinks, sync, synthesize,
                      extract, patterns) are skipped (reason: no_brain_dir)
                      and the DB-only phases still run.

  --source <id>       Scope the cycle to one source so doctor's
                      cycle_freshness check sees a fresh stamp on
                      completion. Without this, gbrain dream's
                      timestamp never lands and federated brains
                      see "stale cycle" forever.
  --source-id <id>    Alias for --source. Matches the v0.37.7.0+
                      naming used by import/extract/graph-query.

  --input <file>      Synthesize a specific transcript file (implies
                      --phase synthesize). Bypasses corpus-dir scan.
  --date YYYY-MM-DD   Synthesize transcripts dated for one specific day.
  --from YYYY-MM-DD   Backfill range start (use with --to).
  --to   YYYY-MM-DD   Backfill range end.

  --drain             Bounded backlog drain for --phase extract_atoms
                      (the default phase when --drain is set). Holds the
                      cycle lock once, processes batches until the backlog
                      empties or --window elapses, reports {extracted,
                      remaining}, and exits 3 when the backlog isn't empty
                      so a cron/agent loop knows to run again. Use this to
                      grind down an extract_atoms backlog on a brain whose
                      pack doesn't run the phase in the routine cycle.
  --window <seconds>  Drain wallclock budget. Default 300 (5 min).

  --unsafe-bypass-dream-guard
                      Disable the self-consumption guard. Use only when you
                      know the input file is NOT dream-cycle output but the
                      guard is firing. Loud stderr warning + cost reminder
                      fires every run.

  --help, -h          Show this help

Examples:
  gbrain dream
  gbrain dream --dry-run --json
  gbrain dream --phase lint
  gbrain dream --phase synthesize --input ~/transcripts/2026-04-25.txt
  gbrain dream --phase synthesize --from 2026-04-01 --to 2026-04-25
  0 2 * * * gbrain dream --json         # nightly via cron

Configure synthesize:
  gbrain config set dream.synthesize.session_corpus_dir /path/to/transcripts
  gbrain config set dream.synthesize.session_corpus_dir /path/to/transcripts

Related:
  gbrain autopilot --install            # continuous maintenance as a daemon
  gbrain autopilot                      # same maintenance cycle, scheduled
`);
}

// ─── Human-friendly report printing ────────────────────────────────

function printHuman(report: CycleReport) {
  if (report.status === 'skipped') {
    if (report.reason === 'cycle_already_running') {
      console.log(`Skipped: another cycle is already running. (locked)`);
    } else if (report.reason === 'no_database') {
      console.log(`Skipped: no database available.`);
    } else {
      console.log(`Skipped: ${report.reason ?? 'unknown reason'}.`);
    }
    return;
  }

  if (report.status === 'clean') {
    console.log(
      `Brain is healthy. ${report.phases.length} phase(s) checked in ${(report.duration_ms / 1000).toFixed(1)}s.`,
    );
    return;
  }

  console.log(`Dream cycle (${report.status}) in ${(report.duration_ms / 1000).toFixed(1)}s:`);
  for (const p of report.phases) {
    const icon =
      p.status === 'ok' ? '✓' :
      p.status === 'warn' ? '!' :
      p.status === 'skipped' ? '-' : '✗';
    const line = `  ${icon} ${p.phase.padEnd(10)}  ${p.summary}`;
    console.log(line);
    if (p.error) {
      const hint = p.error.hint ? ` (${p.error.hint})` : '';
      console.log(`      [${p.error.class}/${p.error.code}] ${p.error.message}${hint}`);
    }
  }

  const t = report.totals;
  const hasTotals =
    t.lint_fixes > 0 || t.backlinks_added > 0 || t.pages_synced > 0 ||
    t.pages_extracted > 0 || t.pages_embedded > 0 || t.orphans_found > 0 ||
    t.transcripts_processed > 0 || t.synth_pages_written > 0 || t.patterns_written > 0;
  if (hasTotals) {
    console.log(
      `  totals: lint=${t.lint_fixes} backlinks=${t.backlinks_added} synced=${t.pages_synced} ` +
      `extracted=${t.pages_extracted} embedded=${t.pages_embedded} orphans=${t.orphans_found} ` +
      `synth_transcripts=${t.transcripts_processed} synth_pages=${t.synth_pages_written} ` +
      `patterns=${t.patterns_written}`,
    );
  }
}

// ─── CLI entry ─────────────────────────────────────────────────────

/**
 * Predicate: is this error one of the resolver's user-facing throws
 * we want to surface as a clean stderr line + exit 1?
 *
 * Matches the message prefixes thrown from
 * `src/core/source-resolver.ts:resolveSourceId` and
 * `assertSourceExists`. Anything else (TypeError / ReferenceError /
 * postgres connection failures / unexpected bugs) is intentionally
 * NOT caught — those propagate to Bun's default unhandled handler
 * with a stack trace so genuine programmer bugs aren't hidden as
 * if they were operator errors. (Plan D-T3, codex C-7.)
 */
function isResolverUserError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return (m.startsWith('Source "') && m.includes(' not found.'))
      || m.startsWith('Invalid --source value')
      || m.startsWith('Invalid GBRAIN_SOURCE value');
}

/**
 * issue #1678 — bounded single-hold extract_atoms drain (see DreamArgs.drain).
 * Holds the cycle lock once (same id the routine cycle uses for this source),
 * loops bounded batches rediscovering eligibility, reports remaining, exits
 * EXIT_DRAIN_INCOMPLETE when the backlog isn't empty so a loop knows to retry.
 */
async function runDrain(
  engine: BrainEngine,
  opts: DreamArgs,
  resolvedSourceId: string | undefined,
  brainDir: string | null,
): Promise<void> {
  const { LockUnavailableError } = await import('../core/db-lock.ts');
  const { countExtractAtomsBacklog } = await import('../core/cycle/extract-atoms.ts');
  const { runExtractAtomsDrainForSource } = await import('../core/cycle/extract-atoms-drain.ts');

  const extractionSourceId = resolvedSourceId ?? 'default';

  // Dry-run: preview the backlog without holding the lock or extracting.
  if (opts.dryRun) {
    const remaining = await countExtractAtomsBacklog(engine, extractionSourceId);
    if (opts.json) {
      console.log(JSON.stringify({ phase: 'extract_atoms', status: 'ok', dry_run: true, extracted: 0, skipped: 0, remaining, batches: 0, stopped: 'window' }, null, 2));
    } else {
      console.log(`[drain] dry-run: ${remaining ?? '?'} page(s) eligible for atom extraction (no work done)`);
    }
    // null = the backlog count query FAILED — treat as incomplete, never as
    // "drained" (Codex: `remaining ?? 0` would exit 0 on a failed count and
    // make automation believe the backlog cleared when it was never verified).
    if (remaining === null || remaining > 0) process.exit(EXIT_DRAIN_INCOMPLETE);
    return;
  }

  let result;
  try {
    // DECISION 5A: the lock/batch/count wiring lives in the shared helper so
    // the CLI path, the Minion handler, and autopilot's auto-drain can't drift.
    result = await runExtractAtomsDrainForSource(engine, {
      sourceId: resolvedSourceId,
      windowSeconds: opts.windowSeconds,
      brainDir: brainDir ?? undefined,
      onBatch: opts.json ? undefined : ({ batch, extracted, remaining }) => {
        process.stderr.write(`[drain] batch ${batch}: +${extracted} atom(s), ~${remaining ?? '?'} remaining\n`);
      },
    });
  } catch (e) {
    if (e instanceof LockUnavailableError) {
      if (opts.json) {
        console.log(JSON.stringify({ phase: 'extract_atoms', status: 'skipped', reason: 'cycle_already_running' }, null, 2));
      } else {
        console.log('[drain] skipped: another cycle holds the lock (cycle_already_running) — run again shortly');
      }
      process.exit(EXIT_DRAIN_INCOMPLETE);
    }
    throw e;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[drain] extracted ${result.extracted} atom(s) across ${result.batches} batch(es); ${result.remaining ?? '?'} remaining (stopped: ${result.stopped})`);
  }
  // null remaining = the final count query failed; do not report success.
  if (result.remaining === null || result.remaining > 0) process.exit(EXIT_DRAIN_INCOMPLETE);
}

export async function runDream(engine: BrainEngine | null, args: string[]): Promise<CycleReport | void> {
  const opts = parseArgs(args);

  // ─── IRON RULE: --help short-circuits BEFORE any engine-bearing work ─
  // Tests pin this ordering so `gbrain dream --help --source whatever`
  // ALWAYS prints help and exits 0, never reaching the engine-null gate
  // below. If you reorder this, dream-cli-flags.test.ts will fail.
  if (opts.help) {
    printHelp();
    return;
  }

  // v0.41.13: --source <id> resolution. Three guards in order:
  //   1. engine null → exit 1 (the writeback in cycle.ts requires a
  //      DB connection; without engine we'd silently fail the same way
  //      PR #1559 was created to fix)
  //   2. resolveSourceId throws on unknown id → typed-error catch
  //      surfaces clean message; non-resolver throws propagate
  //   3. archived source → exit 1 with restore hint (writing
  //      last_full_cycle_at to an archived source would mask data
  //      staleness when the source is later restored)
  let resolvedSourceId: string | undefined;
  if (opts.source !== null) {
    if (engine === null) {
      console.error(
        'gbrain dream --source <id> requires a connected brain ' +
        '(no engine available); omit --source or run `gbrain init` first',
      );
      process.exit(1);
    }
    try {
      resolvedSourceId = await resolveSourceId(engine, opts.source);
    } catch (e) {
      if (isResolverUserError(e)) {
        console.error((e as Error).message);
        process.exit(1);
      }
      throw e; // genuine bugs propagate with stack trace
    }
    // Archived-source guard via fetchSource from sources-load.ts
    // (single-row SELECT that projects `archived` and falls back to
    // pre-v0.26.5 schemas via isUndefinedColumnError catch — same
    // legacy-safety net the rest of the codebase uses). engine's
    // built-in listAllSources defaults to includeArchived=false AND
    // doesn't project the archived column, so it cannot be used here.
    const src = await fetchSource(engine, resolvedSourceId);
    if (src?.archived === true) {
      console.error(
        `source ${resolvedSourceId} is archived; restore with ` +
        `\`gbrain sources restore ${resolvedSourceId}\` before cycling`,
      );
      process.exit(1);
    }
  }

  const brainDir = await resolveBrainDir(engine, opts.dir, resolvedSourceId);
  // Both-null is the only hard error: no local checkout AND no DB connection
  // means neither filesystem phases nor DB phases can run. With an engine but
  // no checkout, the cycle skips filesystem phases and runs DB-only phases
  // (resolve_symbol_edges, embed, orphans, ...) — the postgres support path.
  if (brainDir === null && engine === null) {
    console.error(
      'No brain directory found and no database connection. ' +
      'Pass --dir <path> or configure a brain via `gbrain init`.',
    );
    process.exit(1);
  }
  // ─── issue #1678: bounded single-hold extract_atoms drain ──────────
  if (opts.drain) {
    if (engine === null) {
      console.error('gbrain dream --drain requires a connected brain (no engine available)');
      process.exit(1);
    }
    return runDrain(engine, opts, resolvedSourceId, brainDir);
  }

  const phases: CyclePhase[] | undefined = opts.phase ? [opts.phase] : undefined;

  const report = await runCycle(engine, {
    brainDir,
    dryRun: opts.dryRun,
    pull: opts.pull,
    phases,
    sourceId: resolvedSourceId, // undefined when --source not set → legacy back-compat
    synthInputFile: opts.inputFile ?? undefined,
    synthDate: opts.date ?? undefined,
    synthFrom: opts.from ?? undefined,
    synthTo: opts.to ?? undefined,
    synthBypassDreamGuard: opts.bypassDreamGuard,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  // Exit non-zero when the cycle failed overall (helps cron spot real problems).
  // 'partial' is not a failure — it means some phase warned but the cycle ran.
  if (report.status === 'failed') {
    process.exit(1);
  }

  return report;
}
