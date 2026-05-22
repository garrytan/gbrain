/**
 * gbrain eval export — stream captured eval_candidates rows as NDJSON (v0.21.0).
 *
 * Consumer: sibling gbrain-evals repo, which imports the NDJSON as a
 * BrainBench-Real fixture alongside the fictional amara-life corpus.
 *
 * Output contract (stable from v0.21.0 — schema_version:1 on every row):
 *   { "schema_version": 1, "id": N, "tool_name": "query"|"search", ... }\n
 *
 * The schema_version prefix lets gbrain-evals detect format drift and
 * warn on unknown versions instead of silently misparsing.
 *
 * Usage:
 *   gbrain eval export [--since 7d] [--limit N] [--tool query|search] > rows.ndjson
 */

import type { BrainEngine } from '../core/engine.ts';
import type { EvalCandidate } from '../core/types.ts';

const SCHEMA_VERSION = 1;

interface ExportOpts {
  help?: boolean;
  since?: Date;
  limit?: number;
  tool?: 'query' | 'search';
}

function parseDurationToMs(s: string): number | null {
  // Accepts "30d", "7d", "1h", "90m", "3600s". Same shape as gbrain eval prune + jobs prune.
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

function parseArgs(args: string[]): ExportOpts {
  const opts: ExportOpts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--since': {
        if (!next) break;
        const ms = parseDurationToMs(next);
        if (ms !== null) {
          opts.since = new Date(Date.now() - ms);
        } else {
          console.error(`Invalid --since value: ${next} (use like 7d, 1h, 30m)`);
          process.exit(1);
        }
        i++;
        break;
      }
      case '--limit':
        if (next) opts.limit = parseInt(next, 10);
        i++;
        break;
      case '--tool':
        if (next === 'query' || next === 'search') {
          opts.tool = next;
        } else if (next) {
          console.error(`Invalid --tool value: ${next} (use 'query' or 'search')`);
          process.exit(1);
        }
        i++;
        break;
    }
  }
  return opts;
}

function printHelp(): void {
  console.error(`gbrain eval export — emit captured eval_candidates as NDJSON to stdout

USAGE:
  gbrain eval export [--since DUR] [--limit N] [--tool query|search]

FLAGS:
  --since DUR    Only rows created within DUR (e.g. 7d, 1h, 30m). Default: all.
  --limit N      Cap rows returned. Default: 1000. Max: 100000.
  --tool X       Filter to a specific tool ('query' or 'search'). Default: both.
  --help, -h     Show this help.

OUTPUT:
  One JSON object per line on stdout. Every row begins with
  "schema_version": 1 so downstream consumers (gbrain-evals) can
  detect format changes.

EXAMPLES:
  gbrain eval export > rows.ndjson
  gbrain eval export --since 7d --tool query | jq '.query'
  gbrain eval export --limit 100 | head
`);
}

export async function runEvalExport(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  // Progress to stderr (stdout is reserved for NDJSON data).
  const { createProgress, startHeartbeat } = await import('../core/progress.ts');
  const { getCliOptions, cliOptsToProgressOptions } = await import('../core/cli-options.ts');
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  progress.start('eval.export');
  const stopHeartbeat = startHeartbeat(progress, 'reading eval_candidates');
  let rows: EvalCandidate[];
  try {
    rows = await engine.listEvalCandidates({
      since: opts.since,
      limit: opts.limit,
      tool: opts.tool,
    });
  } finally {
    stopHeartbeat();
  }

  // Emit NDJSON to stdout. EPIPE-safe: if the downstream process
  // (e.g. `| head`) closes its end early, we abort cleanly without a
  // stack trace. Matches src/core/progress.ts EPIPE handling precedent.
  const stdout = process.stdout;
  const abortOnEpipe = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  };
  stdout.on('error', abortOnEpipe);

  let written = 0;
  for (const row of rows) {
    // Prefix every line with schema_version:1 so gbrain-evals can detect
    // schema drift before parsing the rest of the fields.
    const line = JSON.stringify({ schema_version: SCHEMA_VERSION, ...row });
    if (!stdout.write(line + '\n')) {
      // Backpressure: wait for drain before continuing.
      await new Promise(r => stdout.once('drain', r));
    }
    written++;
    progress.tick();
  }

  stdout.off('error', abortOnEpipe);
  progress.finish();
  console.error(`exported ${written} row(s)`);
}
