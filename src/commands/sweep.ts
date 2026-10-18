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
import { jsonRequested, setCliExitVerdict } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import { writeCliRefusal } from '../cli/cli-error.ts';

export const SWEEP_HELP = `gbrain sweep — run the serve-resident maintenance sweep once, locally

Usage:
  gbrain sweep --once [--source <id>] [--budget-ms <n>] [--batch-limit <n>] [--json]
  gbrain sweep --assign-corpus <source> [--session <id>] [--apply] [--json]
  gbrain sweep --retry-failed [--apply] [--json]

Runs the three bounded sweep passes against the connected brain:
  1. facts-fence reconciliation (zero-LLM): recently-modified pages with a
     "## Facts" fence get their facts DB index reconciled.
  2. link/timeline extraction (zero-LLM): the same deterministic extraction
     "gbrain extract" runs, over recently-modified pages.
  3. corpus ingest (spend-gated): unprocessed transcript .txt files run
     through facts extraction in turn-boundary windows (8 per file and 32
     total per sweep; GBRAIN_CORPUS_WINDOWS_PER_SWEEP overrides the total);
     longer files finish over later sweeps. Skipped in keyless mode.

Flags:
  --once             Required. One bounded sweep, then exit.
  --source <id>      Source to sweep (default: GBRAIN_SOURCE or 'default').
  --budget-ms <n>    Wall-clock budget; sweep stops between items (default 5000).
  --batch-limit <n>  Max pages / corpus files per pass (default 20).
  --json             Print the SweepReport as JSON on stdout.

Held session files (#6268): a captured session file is extracted into the
source its name or its session record carries. Files written before session
files recorded their source (on a brain with more than one source), and
sessions whose source never resolved, are held. --assign-corpus previews
which held sessions would be mapped to <source>; --apply records the
mapping (a session that already names a source is never changed), and the
next sweep extracts them there. --session limits it to one session.

Failed windows (#6785): a corpus window whose extraction fails after the
model call (the fence write was refused, the provider errored) is retried
on the next sweep, then after 10, 20 and 40 minutes, then no longer paid
for: the sweep skips it as corpus_window_dead_lettered. An extraction-config change (model, provider,
key presence) retries it once more. --retry-failed lists the files waiting
or stopped; --apply clears their failure counts so the next sweep pays to
extract those windows again.

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
  if (args.includes('--assign-corpus')) {
    await runAssignCorpus(engine, args);
    return;
  }
  if (args.includes('--retry-failed')) {
    await runRetryFailed(engine, args);
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
    console.log(`  links removed:      ${report.linksRemoved}`);
    console.log(`  timeline extracted: ${report.timelineExtracted}`);
    console.log(`  corpus ingested:    ${report.corpusIngested}`);
    for (const f of report.corpus_files) {
      console.log(`    ${f.file}: ${f.windows_done} window(s) extracted, ${f.windows_remaining} remaining`);
    }
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

async function sessionCorpusDir(engine: BrainEngine): Promise<string> {
  const dir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  if (dir) return dir;
  const { configDir } = await import('../core/config.ts');
  const { join } = await import('node:path');
  return join(configDir(), 'transcripts', 'corpus');
}

/** #6785: preview (default) or clear the failure counts of corpus windows that keep failing after the model call. */
async function runRetryFailed(engine: BrainEngine, args: string[]): Promise<void> {
  const json = jsonRequested(args);
  const apply = args.includes('--apply');
  const { CORPUS_SPOOL_SUBDIR, CORPUS_WINDOW_FAILURE_CAP, corpusSpoolDir, listCorpusFailures } = await import('../core/context/corpus-segments.ts');
  const { clearCorpusFailure } = await import('../core/context/corpus-windows.ts');
  const dir = await sessionCorpusDir(engine);
  const files = [
    ...listCorpusFailures(corpusSpoolDir(dir)).map(f => ({ ...f, label: `${CORPUS_SPOOL_SUBDIR}/${f.name}` })),
    ...listCorpusFailures(dir).map(f => ({ ...f, label: f.name })),
  ];
  if (apply) for (const f of files) await clearCorpusFailure(f.full);
  const rows = files.map(f => ({
    file: f.label,
    attempts: f.record.count,
    stopped: f.record.count >= CORPUS_WINDOW_FAILURE_CAP,
    last_code: f.record.last_code,
    last_failed_at: new Date(f.record.last_at).toISOString(),
  }));
  if (json) {
    console.log(JSON.stringify({ applied: apply, cap: CORPUS_WINDOW_FAILURE_CAP, files: rows }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('No corpus window is waiting on a failed extraction.');
    return;
  }
  console.log(apply
    ? `Cleared the failure counts of ${rows.length} corpus file(s); the next sweep pays to extract their windows again (gbrain sweep --once).`
    : `${rows.length} corpus file(s) have a window that failed after the model call:`);
  for (const r of rows) {
    console.log(`  ${r.file}: ${r.attempts} failed attempt(s), last ${r.last_code} at ${r.last_failed_at}${r.stopped ? ' (stopped)' : ' (retrying with backoff)'}`);
  }
  if (!apply) console.log('Fix the cause first (the last code names it), then retry them (paid): gbrain sweep --retry-failed --apply');
}

/** #6268: preview (default) or apply the operator's source mapping for held session files. */
async function runAssignCorpus(engine: BrainEngine, args: string[]): Promise<void> {
  const json = jsonRequested(args);
  const sourceId = args[args.indexOf('--assign-corpus') + 1];
  const sessionIdx = args.indexOf('--session');
  const onlySession = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
  const { isValidSourceId } = await import('../core/source-id.ts');
  const rows = isValidSourceId(sourceId)
    ? await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id = $1', [sourceId])
    : [];
  if (!rows.length || rows[0].archived) {
    setCliExitVerdict(writeCliRefusal(opError('invalid_source',
      `gbrain sweep --assign-corpus: ${JSON.stringify(sourceId ?? '')} is not an active source of this brain`,
      'Ask the user which source the held session files belong to; `gbrain sources list` shows the active sources.',
      { why: 'Held session files are mapped only to a source that exists and is not archived.',
        fix: { argv: ['gbrain', 'sources', 'list'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Lists the active sources to choose from.', verify: { argv: ['gbrain', 'doctor', '--only', 'memory_writeback', '--json'] } } }),
      'sweep', { json }));
    return;
  }
  const dir = await sessionCorpusDir(engine);
  const { assignCorpusSessions, listCorpusSourceHolds } = await import('../core/context/corpus-source.ts');
  const sources = await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id LIMIT 2');
  const holds = listCorpusSourceHolds(dir, sources.length === 1);
  const sessions = holds.sessions.filter(s => onlySession === undefined || s === onlySession);
  const apply = args.includes('--apply');
  const assigned = apply ? assignCorpusSessions(dir, sessions, sourceId) : [];
  const out = { source: sourceId, applied: apply, held_sessions: sessions, assigned_sessions: assigned };
  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else if (!apply) {
    console.log(`${sessions.length} held session(s) would be mapped to source ${sourceId}:`);
    for (const s of sessions) console.log(`  ${s}`);
    if (sessions.length) console.log(`Apply: gbrain sweep --assign-corpus ${sourceId}${onlySession ? ` --session ${onlySession}` : ''} --apply`);
  } else {
    console.log(`Mapped ${assigned.length} held session(s) to source ${sourceId}; the next sweep extracts them (gbrain sweep --once).`);
  }
}
