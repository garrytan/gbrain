/**
 * gbrain eval replay — replay captured eval_candidates against current brain (v0.25.0).
 *
 * The contributor-facing half of BrainBench-Real:
 *
 *   1. capture some real traffic    (default-on, lands in eval_candidates)
 *   2. snapshot it                  (gbrain eval export --since 7d > baseline.ndjson)
 *   3. make a code change           (tune RRF_K, edit hybrid.ts, swap an embed model)
 *   4. replay against the snapshot  (gbrain eval replay --against baseline.ndjson)
 *
 * Outputs three numbers a contributor can read at a glance:
 *
 *   - mean Jaccard@k between captured retrieved_slugs and current run's slugs
 *   - top-1 stability rate (was the #1 result the same?)
 *   - mean latency delta (current - captured), positive = slower now
 *
 * Best-effort by design. Replay is NOT pure — your brain has more pages than
 * when the capture was taken, embeddings may have drifted, and the OPENAI key
 * may be different. The metrics describe "did this change hurt retrieval on
 * the queries you actually serve" not "do these match the baseline byte for
 * byte." Use it before merging anything that touches src/core/search/ or the
 * query/search op handlers.
 *
 * Usage:
 *   gbrain eval replay --against captured.ndjson [--limit N] [--json]
 *                      [--top-regressions K] [--verbose]
 */

import { readFileSync, existsSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import type { SearchResult } from '../core/types.ts';
import { hybridSearch } from '../core/search/hybrid.ts';

interface ReplayOpts {
  help?: boolean;
  against?: string;
  limit?: number;
  json?: boolean;
  verbose?: boolean;
  topRegressions?: number;
}

interface RowResult {
  /** Captured row's id, for back-referencing into the source NDJSON. */
  id: number;
  tool_name: 'query' | 'search';
  query: string;
  /** Set-overlap score in [0, 1]. 1.0 = identical retrieved set. */
  jaccard: number;
  /** True when current top result matches captured top result. */
  top1Match: boolean;
  /** Captured retrieved_slugs (as-is from NDJSON). */
  captured_slugs: string[];
  /** Current run's slugs (deduped, in result order). */
  current_slugs: string[];
  /** Wall-clock latency (ms) of the current re-run. */
  current_latency_ms: number;
  /** latency delta = current - captured. Positive = slower now. */
  latency_delta_ms: number;
  /** True if the row was skipped (e.g. captured query was empty). */
  skipped?: boolean;
  /** Reason the row was skipped, if any. */
  skip_reason?: string;
  /** True if the row threw during replay; current_slugs is empty. */
  errored?: boolean;
  error_message?: string;
}

function parseArgs(args: string[]): ReplayOpts {
  const opts: ReplayOpts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--against':
        if (!next) break;
        opts.against = next;
        i++;
        break;
      case '--limit':
        if (!next) break;
        opts.limit = parseInt(next, 10);
        i++;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--top-regressions':
        if (!next) break;
        opts.topRegressions = parseInt(next, 10);
        i++;
        break;
    }
  }
  return opts;
}

function printHelp(): void {
  console.error(`gbrain eval replay — replay captured queries against current brain

USAGE:
  gbrain eval replay --against FILE.ndjson [flags]

FLAGS:
  --against FILE        NDJSON file from \`gbrain eval export\` (required).
  --limit N             Replay at most N rows (default: replay all).
                        Each row hits OpenAI once for query embedding —
                        cap aggressively when iterating locally.
  --top-regressions K   Print the K rows with the worst Jaccard scores.
                        Default 5 in human mode, 0 in --json.
  --json                Emit one JSON object on stdout instead of a table.
                        Stable shape for CI consumption.
  --verbose             Include every row's per-row diff (large output).
  --help, -h            Show this help.

OUTPUT (human mode):
  Replayed N captured queries (M skipped, K errored)
  Mean Jaccard@k:   0.873
  Top-1 stability:  87% (N=87 / 100)
  Mean latency Δ:   +12ms (current slower)

  Top 5 regressions:
    0.20  "find every reference to widget-co"   captured=12  current=3
    ...

EXIT CODE:
  0 — replay completed (regardless of regression magnitude).
  1 — invalid args, --against not found, or NDJSON parse failure.

NOTES:
  Replay is best-effort. Your brain has more pages than when the snapshot
  was taken; embeddings may have drifted; OPENAI_API_KEY may be different.
  Use the metrics to spot regressions on REAL queries, not as a hash check.
`);
}

interface CapturedRow {
  schema_version: number;
  id: number;
  tool_name: 'query' | 'search';
  query: string;
  retrieved_slugs: string[];
  retrieved_chunk_ids?: number[];
  source_ids?: string[];
  expand_enabled?: boolean | null;
  detail?: 'low' | 'medium' | 'high' | null;
  detail_resolved?: 'low' | 'medium' | 'high' | null;
  vector_enabled?: boolean;
  expansion_applied?: boolean;
  latency_ms: number;
  remote?: boolean;
  job_id?: number | null;
  subagent_id?: number | null;
  created_at?: string;
}

/**
 * Parse NDJSON. One object per non-blank line. Single bad line throws — it's
 * a corrupt export and silently dropping rows would mask real bugs.
 */
function parseNdjson(content: string): CapturedRow[] {
  const lines = content.split('\n');
  const rows: CapturedRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: CapturedRow;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`NDJSON parse error on line ${i + 1}: ${(err as Error).message}`);
    }
    if (typeof row.schema_version !== 'number') {
      throw new Error(`Line ${i + 1} missing schema_version — not from \`gbrain eval export\`?`);
    }
    if (row.schema_version !== 1) {
      throw new Error(
        `Line ${i + 1} has schema_version=${row.schema_version}; this replay only supports v1. ` +
        `Upgrade gbrain or re-export.`,
      );
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Set-Jaccard between two slug arrays. Order ignored, dupes collapsed.
 * Both empty → 1.0 (identical empty sets, no information lost).
 */
function jaccardSlugs(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const s of setA) if (setB.has(s)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

async function replayRow(engine: BrainEngine, row: CapturedRow): Promise<RowResult> {
  const captured_slugs = row.retrieved_slugs ?? [];
  const startedAt = Date.now();

  // Default replay limit matches hybridSearch's default (20).
  const limit = Math.max(captured_slugs.length, 20);

  // search → bare keyword path. query → hybrid path (vector + keyword + RRF).
  // detail and expansion are threaded in from the captured row so the same
  // logic runs that produced the original retrieval.
  let current: SearchResult[];
  try {
    if (row.tool_name === 'search') {
      const dedupedRaw = await engine.searchKeyword(row.query, { limit });
      current = dedupedRaw;
    } else {
      current = await hybridSearch(engine, row.query, {
        limit,
        detail: row.detail ?? undefined,
        expansion: row.expand_enabled ?? false,
      });
    }
  } catch (err) {
    return {
      id: row.id,
      tool_name: row.tool_name,
      query: row.query,
      jaccard: 0,
      top1Match: false,
      captured_slugs,
      current_slugs: [],
      current_latency_ms: Date.now() - startedAt,
      latency_delta_ms: Date.now() - startedAt - row.latency_ms,
      errored: true,
      error_message: (err as Error).message ?? String(err),
    };
  }

  const current_latency_ms = Date.now() - startedAt;
  // Dedup slugs while preserving order — same convention as search results.
  const seen = new Set<string>();
  const current_slugs: string[] = [];
  for (const r of current) {
    if (!seen.has(r.slug)) {
      seen.add(r.slug);
      current_slugs.push(r.slug);
    }
  }

  return {
    id: row.id,
    tool_name: row.tool_name,
    query: row.query,
    jaccard: jaccardSlugs(captured_slugs, current_slugs),
    top1Match: captured_slugs[0] !== undefined && current_slugs[0] === captured_slugs[0],
    captured_slugs,
    current_slugs,
    current_latency_ms,
    latency_delta_ms: current_latency_ms - row.latency_ms,
  };
}

interface ReplaySummary {
  rows_total: number;
  rows_replayed: number;
  rows_skipped: number;
  rows_errored: number;
  /** Mean Jaccard across non-skipped, non-errored rows. */
  mean_jaccard: number;
  top1_stability_rate: number;
  mean_latency_delta_ms: number;
  /** Rows where current latency is more than 2x captured (regression alarm). */
  rows_over_2x_latency: number;
}

function summarize(results: RowResult[]): ReplaySummary {
  const eligible = results.filter(r => !r.skipped && !r.errored);
  const meanJaccard = eligible.length === 0
    ? 0
    : eligible.reduce((a, r) => a + r.jaccard, 0) / eligible.length;
  const top1Rate = eligible.length === 0
    ? 0
    : eligible.filter(r => r.top1Match).length / eligible.length;
  const meanLatencyDelta = eligible.length === 0
    ? 0
    : eligible.reduce((a, r) => a + r.latency_delta_ms, 0) / eligible.length;
  const over2x = eligible.filter(r => {
    const captured = results.find(x => x.id === r.id);
    return captured && captured.current_latency_ms > 2 * (captured.current_latency_ms - captured.latency_delta_ms);
  }).length;

  return {
    rows_total: results.length,
    rows_replayed: eligible.length,
    rows_skipped: results.filter(r => r.skipped).length,
    rows_errored: results.filter(r => r.errored).length,
    mean_jaccard: meanJaccard,
    top1_stability_rate: top1Rate,
    mean_latency_delta_ms: meanLatencyDelta,
    rows_over_2x_latency: over2x,
  };
}

function printHumanSummary(summary: ReplaySummary, results: RowResult[], topRegressions: number): void {
  const total = summary.rows_total;
  const eligible = summary.rows_replayed;
  console.log(`Replayed ${eligible} of ${total} captured queries (${summary.rows_skipped} skipped, ${summary.rows_errored} errored)`);
  console.log(`Mean Jaccard@k:    ${summary.mean_jaccard.toFixed(3)}`);
  console.log(`Top-1 stability:   ${(summary.top1_stability_rate * 100).toFixed(1)}%`);
  const sign = summary.mean_latency_delta_ms >= 0 ? '+' : '';
  console.log(`Mean latency Δ:    ${sign}${summary.mean_latency_delta_ms.toFixed(0)}ms (current vs captured)`);
  if (summary.rows_over_2x_latency > 0) {
    console.log(`⚠ ${summary.rows_over_2x_latency} row(s) ran more than 2× slower than captured`);
  }

  if (topRegressions > 0) {
    const sorted = [...results]
      .filter(r => !r.skipped && !r.errored)
      .sort((a, b) => a.jaccard - b.jaccard)
      .slice(0, topRegressions);
    if (sorted.length > 0 && sorted[0]!.jaccard < 1.0) {
      console.log(`\nTop ${sorted.length} regression(s):`);
      for (const r of sorted) {
        const truncQuery = r.query.length > 60 ? r.query.slice(0, 57) + '...' : r.query;
        console.log(
          `  jaccard=${r.jaccard.toFixed(2)}  captured=${r.captured_slugs.length}  current=${r.current_slugs.length}  ` +
          `"${truncQuery}"`,
        );
      }
    }
  }

  if (summary.rows_errored > 0) {
    const errors = results.filter(r => r.errored).slice(0, 3);
    console.log(`\n${summary.rows_errored} row(s) errored. First ${errors.length}:`);
    for (const r of errors) {
      const truncQuery = r.query.length > 60 ? r.query.slice(0, 57) + '...' : r.query;
      console.log(`  id=${r.id}  "${truncQuery}"  ${r.error_message ?? ''}`);
    }
  }
}

export async function runEvalReplay(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.against) {
    console.error('Error: --against FILE.ndjson is required\n');
    printHelp();
    process.exit(1);
  }
  if (!existsSync(opts.against)) {
    console.error(`Error: file not found: ${opts.against}`);
    process.exit(1);
  }

  let rows: CapturedRow[];
  try {
    const content = readFileSync(opts.against, 'utf-8');
    rows = parseNdjson(content);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.error(`Error: ${opts.against} is empty (no NDJSON rows)`);
    process.exit(1);
  }

  const capped = opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
  if (!opts.json) {
    console.error(
      `Replaying ${capped.length}${capped.length < rows.length ? ` of ${rows.length}` : ''} captured queries…`,
    );
  }

  const results: RowResult[] = [];
  for (const row of capped) {
    if (!row.query || row.query.length === 0) {
      results.push({
        id: row.id,
        tool_name: row.tool_name,
        query: row.query ?? '',
        jaccard: 0,
        top1Match: false,
        captured_slugs: row.retrieved_slugs ?? [],
        current_slugs: [],
        current_latency_ms: 0,
        latency_delta_ms: 0,
        skipped: true,
        skip_reason: 'empty query',
      });
      continue;
    }
    const r = await replayRow(engine, row);
    results.push(r);
    if (!opts.json && results.length % 25 === 0) {
      process.stderr.write(`  ...${results.length}/${capped.length}\n`);
    }
  }

  const summary = summarize(results);
  if (opts.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      summary,
      results: opts.verbose ? results : undefined,
    }, null, 2));
    return;
  }

  const topN = opts.topRegressions ?? 5;
  printHumanSummary(summary, results, topN);
}
