/**
 * takes-quality-eval/trend — DB-backed quality-over-time view.
 *
 * Reads eval_takes_quality_runs ordered by created_at DESC, optionally
 * filtered by rubric_version (codex review #3 — segregates rubric epochs
 * so a v1.0 → v1.1 transition doesn't lie about quality moving).
 *
 * Plain text table for stdout; JSON for programmatic consumers.
 */
import type { BrainEngine } from '../engine.ts';

export interface TrendRow {
  id: number;
  ts: string;
  rubric_version: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  overall_score: number;
  cost_usd: number;
  corpus_sha8: string;
}

export interface TrendOpts {
  /** Number of rows to return. Default 20. */
  limit?: number;
  /** Filter to a specific rubric version (default: all). */
  rubricVersion?: string;
}

export async function loadTrend(engine: BrainEngine, opts: TrendOpts = {}): Promise<TrendRow[]> {
  const limit = Math.min(opts.limit ?? 20, 200); // cap at 200 to keep stdout manageable
  const params: unknown[] = [];
  let where = '';
  if (opts.rubricVersion) {
    params.push(opts.rubricVersion);
    where = `WHERE rubric_version = $${params.length}`;
  }
  params.push(limit);
  const rows = await engine.executeRaw<{
    id: number | string;
    created_at: string;
    rubric_version: string;
    verdict: string;
    overall_score: number;
    cost_usd: number;
    receipt_sha8_corpus: string;
  }>(
    `SELECT id, created_at, rubric_version, verdict, overall_score, cost_usd, receipt_sha8_corpus
       FROM eval_takes_quality_runs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.map(r => ({
    id: typeof r.id === 'string' ? parseInt(r.id, 10) : r.id,
    ts: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
    rubric_version: r.rubric_version,
    verdict: r.verdict as TrendRow['verdict'],
    overall_score: Number(r.overall_score),
    cost_usd: Number(r.cost_usd),
    corpus_sha8: r.receipt_sha8_corpus,
  }));
}

/** Render the trend table as plain text for stdout. */
export function renderTrendTable(rows: TrendRow[]): string {
  if (rows.length === 0) {
    return 'No takes-quality runs recorded yet. Run `gbrain eval takes-quality run` to get started.';
  }
  const header = ['ts', 'rubric', 'verdict', 'overall', 'cost', 'corpus'].join('  ');
  const sep = '─'.repeat(header.length + 8);
  const lines = rows.map(r =>
    [
      r.ts.slice(0, 19),
      r.rubric_version.padEnd(6),
      r.verdict.padEnd(12),
      r.overall_score.toFixed(1).padStart(6),
      `$${r.cost_usd.toFixed(2)}`.padStart(7),
      r.corpus_sha8,
    ].join('  '),
  );
  return [header, sep, ...lines].join('\n');
}
