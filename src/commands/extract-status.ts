/**
 * v0.42 Wave D1 — `gbrain extract status` dashboard CLI.
 *
 *   gbrain extract status [--source-id ID] [--kind X] [--run-id Y] [--json]
 *
 * Reads `extract_rollup_7d` (migration v106) and emits per-kind +
 * (optionally) per-source aggregates from the last 7 days. Operator-
 * discoverability surface for the v0.42 extract framework.
 *
 * Human output: kubectl-style right-aligned table.
 * JSON envelope: stable `schema_version: 1` for monitoring pipelines.
 *
 * Filters:
 *   - --source-id ID    only rows for this source (default: all)
 *   - --kind X          only rows for this extractor kind (default: all)
 *   - --run-id Y        future surface for trace-id grouping; v0.42 stub
 *                       (rollup table doesn't carry run_id since it's an
 *                       aggregate; receipt pages do via slug)
 */

import type { BrainEngine } from '../core/engine.ts';

export interface ExtractStatusRow {
  kind: string;
  source_id: string;
  cost_7d_usd: number;
  eval_pass_count: number;
  eval_fail_count: number;
  halt_count: number;
  round_completed_count: number;
  halt_rate: number;
  last_updated_at: string | null;
}

export interface ExtractStatusReport {
  schema_version: 1;
  rows: ExtractStatusRow[];
  filters: {
    source_id?: string;
    kind?: string;
  };
}

/**
 * Pure helper: build the report from raw rollup rows. Exported for tests.
 */
export function buildStatusReport(
  rollupRows: Array<{
    kind: string;
    source_id: string;
    cost_7d_usd: number | string | null;
    eval_pass_count: number | string | null;
    eval_fail_count: number | string | null;
    halt_count: number | string | null;
    round_completed_count: number | string | null;
    last_updated_at: Date | string | null;
  }>,
  filters: { source_id?: string; kind?: string },
): ExtractStatusReport {
  const rows: ExtractStatusRow[] = rollupRows.map(r => {
    const halts = Number(r.halt_count) || 0;
    const completed = Number(r.round_completed_count) || 0;
    const total = halts + completed;
    return {
      kind: r.kind,
      source_id: r.source_id,
      cost_7d_usd: Number(r.cost_7d_usd) || 0,
      eval_pass_count: Number(r.eval_pass_count) || 0,
      eval_fail_count: Number(r.eval_fail_count) || 0,
      halt_count: halts,
      round_completed_count: completed,
      halt_rate: total > 0 ? halts / total : 0,
      last_updated_at: r.last_updated_at
        ? new Date(r.last_updated_at).toISOString()
        : null,
    };
  });

  // Sort by (halt_rate desc, cost desc) — operator's eye lands on the
  // most-troubled kinds first.
  rows.sort((a, b) => {
    if (b.halt_rate !== a.halt_rate) return b.halt_rate - a.halt_rate;
    return b.cost_7d_usd - a.cost_7d_usd;
  });

  return { schema_version: 1, rows, filters };
}

/**
 * Pure helper: format the human-readable table. kubectl-style right-aligned
 * columns. Top 5 by halt rate; pass verbose=true to show all.
 */
export function formatStatusTable(report: ExtractStatusReport, verbose: boolean): string {
  if (report.rows.length === 0) {
    const filterDesc =
      (report.filters.source_id ? ` source=${report.filters.source_id}` : '') +
      (report.filters.kind ? ` kind=${report.filters.kind}` : '');
    return `No extract events in last 7 days${filterDesc}.`;
  }

  const shown = verbose ? report.rows : report.rows.slice(0, 5);

  // Column widths
  const KIND = Math.max(4, ...shown.map(r => r.kind.length));
  const SOURCE = Math.max(6, ...shown.map(r => r.source_id.length));

  const lines: string[] = [];
  lines.push(
    `${'KIND'.padEnd(KIND)}  ` +
    `${'SOURCE'.padEnd(SOURCE)}  ` +
    `${'COST_7D_USD'.padStart(11)}  ` +
    `${'COMPLETED'.padStart(9)}  ` +
    `${'HALTS'.padStart(5)}  ` +
    `${'HALT_RATE'.padStart(9)}  ` +
    `${'EVAL_PASS'.padStart(9)}  ` +
    `${'EVAL_FAIL'.padStart(9)}  ` +
    `LAST_RUN`,
  );
  for (const r of shown) {
    const last = r.last_updated_at ? r.last_updated_at.slice(0, 19) + 'Z' : '—';
    lines.push(
      `${r.kind.padEnd(KIND)}  ` +
      `${r.source_id.padEnd(SOURCE)}  ` +
      `${('$' + r.cost_7d_usd.toFixed(4)).padStart(11)}  ` +
      `${String(r.round_completed_count).padStart(9)}  ` +
      `${String(r.halt_count).padStart(5)}  ` +
      `${(r.halt_rate * 100).toFixed(1).padStart(8) + '%'}  ` +
      `${String(r.eval_pass_count).padStart(9)}  ` +
      `${String(r.eval_fail_count).padStart(9)}  ` +
      `${last}`,
    );
  }
  if (!verbose && report.rows.length > 5) {
    lines.push('');
    lines.push(`... +${report.rows.length - 5} more rows (pass --verbose for all)`);
  }
  return lines.join('\n');
}

/**
 * CLI entry: `gbrain extract status`.
 */
export async function runExtractStatus(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const json = args.includes('--json');
  const verbose = args.includes('--verbose');
  const sourceIdIdx = args.indexOf('--source-id');
  const kindIdx = args.indexOf('--kind');
  const sourceId = sourceIdIdx >= 0 && sourceIdIdx + 1 < args.length ? args[sourceIdIdx + 1] : undefined;
  const kind = kindIdx >= 0 && kindIdx + 1 < args.length ? args[kindIdx + 1] : undefined;

  const conds: string[] = ['day >= CURRENT_DATE - 7'];
  const params: unknown[] = [];
  let pIdx = 1;
  if (sourceId) {
    conds.push(`source_id = $${pIdx++}`);
    params.push(sourceId);
  }
  if (kind) {
    conds.push(`kind = $${pIdx++}`);
    params.push(kind);
  }

  type Row = {
    kind: string;
    source_id: string;
    cost_7d_usd: number | string | null;
    eval_pass_count: number | string | null;
    eval_fail_count: number | string | null;
    halt_count: number | string | null;
    round_completed_count: number | string | null;
    last_updated_at: Date | string | null;
  };

  let rows: Row[] = [];
  try {
    rows = await engine.executeRaw<Row>(
      `SELECT
         kind,
         source_id,
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count) AS eval_pass_count,
         SUM(eval_fail_count) AS eval_fail_count,
         SUM(halt_count) AS halt_count,
         SUM(round_completed_count) AS round_completed_count,
         MAX(updated_at) AS last_updated_at
       FROM extract_rollup_7d
       WHERE ${conds.join(' AND ')}
       GROUP BY kind, source_id`,
      params,
    );
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (/extract_rollup_7d.*does not exist|no such table/i.test(msg)) {
      if (json) {
        console.log(JSON.stringify({
          schema_version: 1,
          rows: [],
          filters: { source_id: sourceId, kind },
          note: 'extract_rollup_7d not yet present (pre-v0.42 brain or fresh init)',
        }, null, 2));
      } else {
        console.log('No extract_rollup_7d table found (pre-v0.42 brain or fresh init).');
        console.log('Run: gbrain apply-migrations --yes');
      }
      return;
    }
    throw err;
  }

  const report = buildStatusReport(rows, { source_id: sourceId, kind });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatStatusTable(report, verbose));
}
