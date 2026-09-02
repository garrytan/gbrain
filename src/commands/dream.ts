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
  resolveSourceForDir,
  ALL_PHASES,
  type CyclePhase,
  type CycleReport,
} from '../core/cycle.ts';
import { isResolverUserError, resolveImplicitDefaultSourceId, resolveSourceId } from '../core/source-resolver.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { fetchSource } from '../core/sources-load.ts';
import { existsSync } from 'fs';
import { resolve } from 'node:path';

interface DreamArgs {
  json: boolean;
  dryRun: boolean;
  pull: boolean;
  /**
   * #4493: every explicitly-named (or --input/--drain-implied) phase, order
   * preserved, deduped. Empty = full/default cycle. Previously a single
   * `phase` scalar read from the FIRST --phase flag, so repeats were
   * silently dropped.
   */
  phases: CyclePhase[];
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
  /**
   * issue #2860 — `--once`. One-shot bypass of the named `--phase`'s own
   * `dream.<phase>.enabled` / `cycle.<phase>.enabled` config gate, for this
   * invocation only. Never reads or writes config — unlike the old
   * "toggle enabled true, run, toggle back to false" workaround, a crash
   * mid-run can't leave any global state stuck. Requires an explicit
   * `--phase <name>`; bare `--once` is a usage error (there'd be no single
   * phase to target). Applies only to phases with a config `.enabled` gate
   * (patterns, synthesize, conversation_facts_backfill, enrich_thin,
   * skillopt, drift) — a no-op for phases that always run when named directly.
   */
  once: boolean;
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
  // #4493: collect EVERY --phase occurrence. `args.indexOf('--phase')` used
  // to read only the FIRST flag, so `--phase a --phase b --phase c` silently
  // ran phase a alone and exited 0 with a report covering one phase. Each
  // value is validated, order is preserved, repeats of the same value
  // collapse (same contract as the repeated --source handling below).
  const phaseValues = collectFlagValues(args, '--phase');
  if (phaseValues === null) {
    console.error('--phase <name>: missing value. Usage: gbrain dream --phase <name>');
    process.exit(2);
  }
  // issue #2860 (Codex P3): captured BEFORE --input/--drain get a chance to
  // implicitly default `phases` below, so --once's validation can require
  // the user actually TYPED --phase, not merely that some phase ended up
  // resolved. Without this, `--input <f> --once` and `--drain --once`
  // slip past the "explicit --phase required" contract (the derived
  // phase value is already non-null by the time that check runs) and
  // --once becomes silently ineffective for both.
  const phaseWasExplicit = phaseValues.length > 0;
  let phases: CyclePhase[] = [];
  for (const rawPhase of phaseValues) {
    if (!(ALL_PHASES as string[]).includes(rawPhase)) {
      console.error(`Unknown phase "${rawPhase}". Valid: ${ALL_PHASES.join(', ')}`);
      process.exit(1);
    }
    if (!phases.includes(rawPhase as CyclePhase)) phases.push(rawPhase as CyclePhase);
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
  if (inputFile && phases.length === 0) phases = ['synthesize'];

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
    if (phases.length === 0) phases = ['extract_atoms'];
    else if (phases.length > 1 || phases[0] !== 'extract_atoms') {
      console.error(`--drain currently supports only --phase extract_atoms (got "${phases.join(', ')}")`);
      process.exit(2);
    }
  }

  // issue #2860: --once requires an EXPLICIT single --phase target (typed
  // by the user, not merely implied by --input/--drain — see
  // `phaseWasExplicit` above). Bare `--once` (full/default cycle) has no
  // single phase to bypass the gate for, and force-enabling EVERY
  // currently-disabled phase at once would be exactly the kind of
  // surprise-spend risk the flag exists to prevent. An implicit phase
  // (from --input or --drain) is rejected too: --drain returns before
  // onceForPhase is ever read, and --input already bypasses the
  // synthesize gate on its own, so --once would silently do nothing in
  // either case — reject loudly instead of pretending it worked (Codex
  // review finding).
  //
  // Codex review finding: `--help` must short-circuit BEFORE this exits(2),
  // matching the "IRON RULE" pinned by test/dream.test.ts's
  // "--help --source whatever prints help and exits 0" case — `gbrain
  // dream --help --once` (no --phase) must show help, not a usage error.
  const once = args.includes('--once');
  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (once && !phaseWasExplicit && !wantsHelp) {
    console.error(
      '--once requires an explicit --phase <name> (bypasses that one ' +
      'phase\'s dream.<phase>.enabled / cycle.<phase>.enabled gate for ' +
      'this run only; never touches config). A phase implied by --input ' +
      'or --drain does not count — --once would silently do nothing for ' +
      'those. Usage: gbrain dream --phase <name> --once',
    );
    process.exit(2);
  }
  // #4493 corollary: --once bypasses ONE phase's enabled gate; with several
  // named phases there is no single target, and force-enabling them all at
  // once is the surprise-spend risk #2860 exists to prevent.
  if (once && phases.length > 1 && !wantsHelp) {
    console.error(
      `--once supports a single --phase target; got [${phases.join(', ')}]. ` +
      'Run each phase in its own --phase <name> --once invocation.',
    );
    process.exit(2);
  }

  return {
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    pull: args.includes('--pull'),
    phases,
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
    once,
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
       gbrain dream retriage [flags]   (see: gbrain dream retriage --help)

Run one brain maintenance cycle. Eight phases:
  lint -> backlinks -> sync -> synthesize -> extract -> patterns -> embed -> orphans

The synthesize + patterns phases (v0.21) consolidate yesterday's
conversation transcripts into reflections, originals, and cross-session
pattern pages. Designed for cron (exits when done).

The synthesize phase (#4152) runs a two-stage cascade: a cheap scored triage
(model: models.dream.triage, gate: dream.triage.threshold, default 0.5) gates
the expensive per-transcript synthesis subagents (turn budget:
dream.synthesize.max_turns, default 16). Retune the threshold any time —
scores are cached, so re-gating costs zero new LLM calls. \`dream retriage\`
re-scores the corpus and reconciles the queued synthesis backlog.

Options:
  --dry-run           Preview all fixes without writing. Note: synthesize
                      runs the cheap scored triage pass (caches verdicts),
                      but skips the synthesis subagents.
                      "--dry-run" does NOT mean "zero LLM calls."
  --json              Emit the CycleReport as JSON (agent-readable)
  --phase <name>      Run only the named phase(s). Repeatable — every named
                      phase runs, in canonical cycle order (#4493).
                      Valid: ${ALL_PHASES.join(' | ')}
  --once              With --phase <name>: run that phase once even if its
                      own dream.<phase>.enabled / cycle.<phase>.enabled
                      config gate is false. Never reads or writes config —
                      unlike toggling the flag on/off around the run, a
                      crash mid-invocation can't leave it stuck. Applies to
                      patterns, synthesize, conversation_facts_backfill,
                      enrich_thin, skillopt, drift; no-op on phases with no such
                      gate. Requires an EXPLICIT --phase <name> — a phase
                      implied by --input or --drain does not count (bare
                      --once, or --once with --input/--drain and no
                      explicit --phase, is a usage error).
  --pull              git pull the brain repo before syncing (default: no pull)
  --dir <path>        Brain directory (default: configured brain). On a
                      postgres/remote brain with no local checkout, the
                      filesystem phases (lint, backlinks, sync, synthesize,
                      extract, patterns) are skipped (reason: no_brain_dir)
                      and the DB-only phases still run.

  --source <id>       Scope the cycle to one source so doctor's
                      cycle_freshness check sees a fresh stamp on
                      completion. When omitted, gbrain derives the
                      source from --dir / the configured checkout
                      when it matches a source's local_path (#1869),
                      or from the default-like source selected by
                      sources.default / sole-non-default routing.
                      A named non-default source runs the deterministic
                      freshness phases unless --phase is given
                      (explicit phases are honored verbatim). A bare
                      no --source dream against the default-like source,
                      and --source default, still run the full cycle.
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
  gbrain dream --phase patterns --once   # run once, ignore dream.patterns.enabled=false
  gbrain dream --phase synthesize --input ~/transcripts/2026-04-25.txt
  gbrain dream --phase synthesize --from 2026-04-01 --to 2026-04-25
  0 2 * * * gbrain dream --json         # nightly via cron

Configure synthesize:
  gbrain config set dream.synthesize.session_corpus_dir /path/to/transcripts
  gbrain config set cycle.timezone Asia/Kolkata  # optional; defaults to host timezone

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
    // A 'clean' cycle can still carry a skip reason worth surfacing — e.g.
    // synthesize's D8 legacy-key / D5 oversize-chunk skips leave
    // transcripts_processed/synth_pages_written at 0 (so deriveStatus sees
    // no activity) while `details.skips` names exactly why each transcript
    // was passed over. Without this, `--input <already-handled-file>`
    // prints only "Brain is healthy" with no indication anything was
    // examined and skipped.
    const skipLines: string[] = [];
    for (const p of report.phases) {
      const skips = (p.details as { skips?: Array<{ filePath: string; reason: string }> } | undefined)?.skips;
      if (Array.isArray(skips)) {
        for (const s of skips) {
          skipLines.push(`  - ${p.phase}: ${s.filePath} (${s.reason})`);
        }
      }
    }
    console.log(
      `Brain is healthy. ${report.phases.length} phase(s) checked in ${(report.duration_ms / 1000).toFixed(1)}s.`,
    );
    if (skipLines.length > 0) {
      console.log('Skipped:');
      for (const line of skipLines) console.log(line);
    }
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
    const details = p.details as Record<string, unknown> | undefined;
    const failures = Array.isArray(details?.failures) ? details.failures : [];
    if (failures.length > 0) {
      for (const f of failures) {
        // sync failures carry `source`; synthesize_concepts failures carry
        // `concept` — name whichever is present so a concept-synthesis
        // failure isn't printed as an anonymous '?'.
        const { source, concept, error } = f as { source?: string; concept?: string; error?: string };
        console.log(`      ✗ ${source ?? concept ?? '?'}: ${error ?? 'unknown error'}`);
      }
    }
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

// ── Test-only export ───────────────────────────────────────
// `__testing` re-exports otherwise-private helpers so unit tests can pin
// CLI output behavior without spawning a subprocess. Not part of the
// runtime contract.
export const __testing = {
  printHuman,
};

// ─── CLI entry ─────────────────────────────────────────────────────

// The resolver's user-facing throws (unknown/archived source, invalid --source
// / GBRAIN_SOURCE value) surface as a clean stderr line + exit 1 via the shared
// `isResolverUserError` predicate (source-resolver.ts, next to the messages it
// matches). Anything else — TypeError / connection failures / genuine bugs —
// is intentionally NOT caught and propagates with a stack trace so programmer
// bugs are never hidden as operator errors. (Plan D-T3, codex C-7.)

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
      console.log(JSON.stringify({ phase: 'extract_atoms', status: 'ok', dry_run: true, extracted: 0, skipped: 0, remaining, batches: 0, stopped: 'window', failure_count: 0, failures: [], omitted_failure_count: 0, last_error: null }, null, 2));
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

  // #4539: surface WHY the drain underperformed. Pre-fix the phase's
  // failures[] was collapsed to bare counts inside the drain adapter, so a
  // run that failed on every item printed only `stopped: no_progress` and the
  // operator had to re-run the phase by hand to see the provider/parse error.
  // Stderr (not stdout): progress/diagnostics never pollute the data stream.
  if (result.failure_count > 0) {
    // #4730: the bounded per-item records ride the --json payload; the human
    // stderr line reports the totals (and any cap overflow) so nothing is
    // silently dropped in either mode.
    const omitted = result.omitted_failure_count > 0
      ? ` (${result.failures.length} detailed, ${result.omitted_failure_count} beyond the record cap)`
      : '';
    process.stderr.write(
      `[drain] ${result.failure_count} item failure(s)${omitted}${result.last_error ? `; last error: ${result.last_error}` : ''}\n`,
    );
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
  // ─── `dream retriage` subverb (#4152) — dispatched BEFORE parseArgs so its
  // flag set never collides with the cycle flags. `dream --help` never reaches
  // here (args[0] is '--help'); `dream retriage --help` prints subcommand help
  // inside runDreamRetriage without touching the engine (same IRON RULE).
  if (args[0] === 'retriage') {
    const { runDreamRetriage } = await import('./dream-retriage.ts');
    await runDreamRetriage(engine, args.slice(1));
    return;
  }
  // Fail-loud guard (structured-review r3 P1): the CLI flag registry unions
  // retriage's flags into `dream`, so the pre-dispatch validator accepts
  // `gbrain dream --reconcile-queue` — but without the `retriage` positional,
  // parseArgs would ignore the flag and silently run the full (paid, writing)
  // maintenance cycle instead of the reconciliation the user asked for.
  {
    const RETRIAGE_ONLY_FLAGS = ['--reconcile-queue', '--cancel-unmatched', '--audit-rejects'];
    const stray = args.find(a => RETRIAGE_ONLY_FLAGS.includes(a));
    if (stray) {
      console.error(
        `gbrain dream: ${stray} belongs to the 'retriage' subcommand — ` +
        `did you mean: gbrain dream retriage ${args.join(' ')}`,
      );
      setCliExitVerdict(2);
      return;
    }
  }

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
  // #4700: a bare `gbrain dream` whose brain routes bare commands to a
  // non-default source (sources.default config, or sole-non-default routing)
  // IS the canonical default cycle for that brain — run the full implicit
  // phase set instead of the freshness-only source cycle. Explicit
  // `--source <id>` and the autopilot fanout keep the freshness boundary.
  let implicitDefaultSourceId: string | null = null;
  let fullImplicitSourceCycle = false;
  if (opts.source === null && engine !== null) {
    try {
      implicitDefaultSourceId = await resolveImplicitDefaultSourceId(engine);
    } catch (e) {
      if (isResolverUserError(e)) {
        console.error((e as Error).message);
        process.exit(1);
      }
      throw e;
    }
    if (opts.dir === null && implicitDefaultSourceId && implicitDefaultSourceId !== 'default') {
      resolvedSourceId = implicitDefaultSourceId;
      fullImplicitSourceCycle = true;
    }
  }
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

  // #1869: a path-scoped run (--dir, or the configured sync.repo_path) whose
  // directory matches a registered source's local_path IS that source's cycle
  // — derive the source id so runCycle writes last_source_cycle_at /
  // last_full_cycle_at on success and doctor's cycle_freshness check stops
  // reading perpetually stale. Explicit --source still wins (resolved above).
  // Fixed here at the command level, NOT in runCycle's stamp gate, so legacy
  // global callers (autopilot-global-maintenance runs GLOBAL_PHASES with a
  // brainDir and no sourceId) can't falsely stamp per-source freshness.
  // A derived match on an archived source is skipped silently (falls back to
  // legacy unscoped behavior) — stamping it would mask staleness on restore,
  // mirroring the explicit --source archived guard above.
  if (resolvedSourceId === undefined && engine !== null && brainDir !== null) {
    const derived = await resolveSourceForDir(engine, brainDir);
    if (derived !== undefined) {
      const src = await fetchSource(engine, derived);
      if (src?.archived !== true) {
        resolvedSourceId = derived;
        // #4700: a path-derived run that lands on the brain's default-like
        // source is still the canonical default cycle — keep the full
        // implicit phase set rather than downgrading to freshness-only.
        fullImplicitSourceCycle = opts.source === null
          && implicitDefaultSourceId === derived
          && derived !== 'default';
      }
    }
  }
  // ─── issue #1678: bounded single-hold extract_atoms drain ──────────
  if (opts.drain) {
    if (engine === null) {
      console.error('gbrain dream --drain requires a connected brain (no engine available)');
      process.exit(1);
    }
    return runDrain(engine, opts, resolvedSourceId, brainDir);
  }

  // #4493: pass EVERY named phase through (runCycle already accepts the
  // array); empty means the full/default cycle.
  const phases: CyclePhase[] | undefined = opts.phases.length > 0 ? opts.phases : undefined;

  const report = await runCycle(engine, {
    brainDir,
    dryRun: opts.dryRun,
    pull: opts.pull,
    phases,
    // Undefined for legacy unscoped runs; set for explicit source cycles,
    // path-derived cycles, and bare default-like non-default source cycles.
    sourceId: resolvedSourceId,
    fullImplicitSourceCycle,
    synthInputFile: opts.inputFile ?? undefined,
    synthDate: opts.date ?? undefined,
    synthFrom: opts.from ?? undefined,
    synthTo: opts.to ?? undefined,
    synthBypassDreamGuard: opts.bypassDreamGuard,
    // issue #2860: exactly one phase is guaranteed here when opts.once is
    // set (parseArgs enforces --once requires a single explicit --phase).
    onceForPhase: opts.once ? opts.phases[0]! : undefined,
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
