/**
 * gbrain eval prune — delete old eval_candidates rows (v0.21.0).
 *
 * Retention is unlimited by default (matches ingest_log precedent).
 * This command is the explicit cleanup; pairs with `gbrain eval export`
 * (snapshot first, then prune if you want to reset).
 *
 * Usage:
 *   gbrain eval prune --older-than 30d
 *   gbrain eval prune --older-than 1h --dry-run
 */

import type { BrainEngine } from '../core/engine.ts';

interface PruneOpts {
  help?: boolean;
  olderThanMs?: number;
  dryRun?: boolean;
}

function parseDurationToMs(s: string): number | null {
  const m = s.match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  const mults: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * mults[unit]!;
}

function parseArgs(args: string[]): PruneOpts {
  const opts: PruneOpts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--older-than': {
        if (!next) break;
        const ms = parseDurationToMs(next);
        if (ms === null) {
          console.error(`Invalid --older-than value: ${next} (use like 30d, 1h, 90m)`);
          process.exit(1);
        }
        opts.olderThanMs = ms;
        i++;
        break;
      }
      case '--dry-run':
        opts.dryRun = true;
        break;
    }
  }
  return opts;
}

function printHelp(): void {
  console.error(`gbrain eval prune — delete old eval_candidates rows

USAGE:
  gbrain eval prune --older-than DUR [--dry-run]

FLAGS:
  --older-than DUR   Delete rows created before now() - DUR (e.g. 30d, 7d, 1h).
                     Required — this command never deletes without a window.
  --dry-run          Report what would be deleted; don't actually delete.
  --help, -h         Show this help.

EXAMPLES:
  gbrain eval prune --older-than 30d
  gbrain eval prune --older-than 90d --dry-run
`);
}

export async function runEvalPrune(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.olderThanMs) {
    console.error('Error: --older-than is required\n');
    printHelp();
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - opts.olderThanMs);

  if (opts.dryRun) {
    // Snapshot-count the rows we *would* delete — the list call caps at
    // 100k which matches the export ceiling, so larger windows get a
    // floor-estimate that's still useful signal.
    const rows = await engine.listEvalCandidates({
      since: new Date(0),
      limit: 100_000,
    });
    const wouldDelete = rows.filter(r => new Date(r.created_at) < cutoff).length;
    console.log(`[dry-run] would delete ${wouldDelete} row(s) created before ${cutoff.toISOString()}`);
    if (rows.length === 100_000) {
      console.log('[dry-run] (count may be undercounted — the scan hit the 100k row limit)');
    }
    return;
  }

  const deleted = await engine.deleteEvalCandidatesBefore(cutoff);
  console.log(`deleted ${deleted} row(s) created before ${cutoff.toISOString()}`);
}
