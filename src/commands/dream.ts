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
import { existsSync } from 'fs';

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
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  };
}

/**
 * Resolve the brain directory without the `findRepoRoot` footgun.
 *
 * Prior dream.ts walked up 10 levels of cwd looking for `.git` and would
 * happily run lint + sync against an unrelated git repo the user happened
 * to be cd'd into. This resolver only trusts two sources:
 *   1. An explicit --dir argument.
 *   2. The `sync.repo_path` config key set by `gbrain init` (engine-backed).
 *
 * If neither is available, we error out instead of guessing.
 */
async function resolveBrainDir(
  engine: BrainEngine | null,
  explicit: string | null,
): Promise<string> {
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`--dir path does not exist: ${explicit}`);
      process.exit(1);
    }
    return explicit;
  }

  if (engine) {
    const configured = await engine.getConfig('sync.repo_path');
    if (configured && existsSync(configured)) {
      return configured;
    }
  }

  console.error(
    'No brain directory found. Pass --dir <path> or configure one via `gbrain init`.',
  );
  process.exit(1);
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
  --dir <path>        Brain directory (default: configured brain)

  --input <file>      Synthesize a specific transcript file (implies
                      --phase synthesize). Bypasses corpus-dir scan.
  --date YYYY-MM-DD   Synthesize transcripts dated for one specific day.
  --from YYYY-MM-DD   Backfill range start (use with --to).
  --to   YYYY-MM-DD   Backfill range end.

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
  gbrain config set dream.synthesize.enabled true

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

export async function runDream(engine: BrainEngine | null, args: string[]): Promise<CycleReport | void> {
  const opts = parseArgs(args);

  if (opts.help) {
    printHelp();
    return;
  }

  const brainDir = await resolveBrainDir(engine, opts.dir);
  const phases: CyclePhase[] | undefined = opts.phase ? [opts.phase] : undefined;

  const report = await runCycle(engine, {
    brainDir,
    dryRun: opts.dryRun,
    pull: opts.pull,
    phases,
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
