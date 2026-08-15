/**
 * `gbrain sweep --once` [CX2-5] — trusted local entry for the maintenance
 * sweep.
 *
 * CLI_ONLY — never exposed over MCP. The sweep normally lives inside the
 * serve process (the PGLite lock owner; see src/mcp/server.ts startup arm
 * + src/commands/serve.ts idle timer). This command exists for the case
 * where NO serve is live: `bootstrap verify`'s deterministic graph-floor
 * seam (write via op → `sweep --once` → edge query) and operator-driven
 * catch-up runs. cli.ts hands us an engine from its normal connectEngine
 * path — which succeeds precisely because no serve holds the lock.
 *
 * Exit codes: 0 on success AND on partial (budget-stopped / single-pass
 * failures — the report says what was skipped); nonzero only on total
 * failure (every pass errored, or the sweep's structural catch fired).
 */

import type { BrainEngine } from '../core/engine.ts';
import { runMaintenanceSweep, type SweepReport } from '../core/sweep.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

export const SWEEP_HELP = `gbrain sweep — run the serve-resident maintenance sweep once, locally

Usage:
  gbrain sweep --once [--source <id>] [--budget-ms <n>] [--batch-limit <n>] [--json]

Runs the three bounded sweep passes against the connected brain:
  1. facts-fence reconciliation (zero-LLM): recently-modified pages with a
     "## Facts" fence get their facts DB index reconciled.
  2. link/timeline extraction (zero-LLM): the same deterministic extraction
     "gbrain extract" runs, over recently-modified pages.
  3. corpus ingest (spend-gated): unprocessed transcript .txt files run
     through facts extraction. Skipped in keyless mode (no provider key).

Flags:
  --once             Required. One bounded sweep, then exit.
  --source <id>      Source to sweep (default: GBRAIN_SOURCE or 'default').
  --budget-ms <n>    Wall-clock budget; sweep stops between items (default 5000).
  --batch-limit <n>  Max pages / corpus files per pass (default 20).
  --json             Print the SweepReport as JSON on stdout.

Exit codes: 0 = success or partial (see "skipped" in the report);
1 = total failure (every pass errored). Local-only; never runs over MCP.
`;

function parseIntFlag(args: string[], flag: string): number | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const raw = args[idx + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} requires a non-negative integer. Got: ${JSON.stringify(raw ?? '(missing)')}`);
  }
  return n;
}

/** Total failure = structural catch fired, or every pass reported an error. */
export function isTotalFailure(report: SweepReport): boolean {
  const reasons = new Set(report.skipped.map(s => s.reason));
  if (reasons.has('sweep_error')) return true;
  return (
    reasons.has('facts_fence_error') &&
    reasons.has('links_timeline_error') &&
    (reasons.has('corpus_error') || reasons.has('corpus_file_error'))
  );
}

export async function runSweep(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(SWEEP_HELP);
    return;
  }
  if (!args.includes('--once')) {
    console.error('gbrain sweep: --once is required (one bounded sweep, then exit).');
    console.error('Run `gbrain sweep --help` for usage.');
    setCliExitVerdict(2);
    return;
  }

  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 && args[sourceIdx + 1]
    ? args[sourceIdx + 1]
    : (process.env.GBRAIN_SOURCE || 'default');

  let budgetMs: number | undefined;
  let batchLimit: number | undefined;
  try {
    budgetMs = parseIntFlag(args, '--budget-ms');
    batchLimit = parseIntFlag(args, '--batch-limit');
  } catch (e) {
    console.error(`gbrain sweep: ${e instanceof Error ? e.message : String(e)}`);
    setCliExitVerdict(2);
    return;
  }

  const jsonMode = args.includes('--json');

  const report = await runMaintenanceSweep(engine, {
    sourceId,
    ...(budgetMs !== undefined ? { budgetMs } : {}),
    ...(batchLimit !== undefined ? { batchLimit } : {}),
    // Progress/diagnostics to stderr — stdout stays clean for --json.
    log: (msg: string) => process.stderr.write(msg + '\n'),
  });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Sweep complete (${report.durationMs}ms, source=${sourceId}):`);
    console.log(`  facts reconciled:   ${report.factsReconciled}`);
    console.log(`  links extracted:    ${report.linksExtracted}`);
    console.log(`  timeline extracted: ${report.timelineExtracted}`);
    console.log(`  corpus ingested:    ${report.corpusIngested}`);
    if (report.skipped.length > 0) {
      console.log('  skipped:');
      for (const s of report.skipped) {
        console.log(`    ${s.reason}: ${s.count}`);
      }
    }
  }

  if (isTotalFailure(report)) {
    console.error('gbrain sweep: total failure — every pass errored. See skipped reasons above.');
    setCliExitVerdict(1);
  }
}
