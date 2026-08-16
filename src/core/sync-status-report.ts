/**
 * Per-source sync status report (`gbrain sources status` + the
 * get_status_snapshot MCP op). Peeled out of src/commands/sync.ts
 * (containment sprint C13-C14) as a pure move.
 */
import type { BrainEngine } from './engine.ts';
import { loadConfig } from './config.ts';
import { unacknowledgedSyncFailures } from './sync.ts';
// lagFromContentMs is the remote/column comparator (buildSyncStatusReport
// backs the get_status_snapshot MCP op — must NOT shell out to git).
import { lagFromContentMs } from './source-health.ts';

/**
 * v0.40.3.0 — read-only per-source dashboard for `gbrain sources status`.
 *
 * Aggregates from existing tables (no schema changes):
 *   - sources:        last_commit, last_sync_at, archived, config.syncEnabled
 *                     (filtered: archived=false, local_path IS NOT NULL)
 *   - pages:          per-source page count (excluding soft-deleted)
 *   - content_chunks: per-source total + count of unembedded chunks for
 *                     the ACTIVE embedding column (resolved via the
 *                     registry — see `src/core/search/embedding-column.ts`).
 *                     Voyage / multimodal / non-default-column brains
 *                     see counts against the column they actually use.
 *   - sync-failures.jsonl: unacknowledged failures (brain-global; the
 *     JSONL log isn't per-source. v0.40.4 TODO source-scopes it.)
 *
 * Staleness thresholds match `gbrain doctor`'s sync-freshness rule
 * (24h / 72h). Sources that have NEVER synced (last_sync_at IS NULL)
 * report `staleness_hours: null` so callers can disambiguate "first run
 * pending" from "32h since last successful sync".
 *
 * Errors propagate. Pre-v0.40.3.0 the dashboard swallowed all DB errors
 * and reported zero counts, which lied at exactly the moment it mattered
 * (Q2 sub-fix from Codex review). The dashboard is read-only — a thrown
 * error surfaces the real problem (DB down, permission denied, statement
 * timeout) instead of misleading the operator with a "0 chunks" report.
 */
export interface SyncStatusReportSource {
  source_id: string;
  name: string;
  local_path: string | null;
  sync_enabled: boolean;
  last_sync_at: string | null;
  /** Raw wall-clock hours since the last successful sync — the honest human
   * number. Distinct from staleness_hours, which is threshold-relative. */
  hours_since_last_sync: number | null;
  /** Threshold-relative lag driving staleness_class. For a source whose
   * content is OLDER than its last sync this is the ceiling-ramped value
   * (see lagFromContentMs), which deliberately under-reads raw wall-clock so
   * the warn tier fires before the fail tier — display hours_since_last_sync
   * when a human asks "how long since we synced". */
  staleness_hours: number | null;
  staleness_class: 'fresh' | 'stale' | 'severe' | 'unknown';
  last_commit: string | null;
  pages: number;
  chunks_total: number;
  chunks_unembedded: number;
  embedding_coverage_pct: number;
  // v0.41.31: embed-backfill job visibility (federated_v2 defers embedding
  // to these jobs; without this an operator can't see queued/lagging work
  // after `sync --all` exits 0). Best-effort — all 0 / null on brains
  // without the minion_jobs table.
  backfill_queued: number;
  backfill_active: number;
  backfill_last_completed_at: string | null;
}

export interface SyncStatusReport {
  schema_version: 1;
  generated_at: string;
  sources: SyncStatusReportSource[];
  unacknowledged_failures: number;
  /** The embedding column counts were computed against. Useful for
   *  operators verifying their Voyage / multimodal setup is reported
   *  correctly. */
  embedding_column: string;
}

export async function buildSyncStatusReport(
  engine: BrainEngine,
  sources: Array<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> }>,
): Promise<SyncStatusReport> {
  // Resolve the active embedding column via the registry. Brains pointed
  // at Voyage / multimodal / any non-default column get accurate counts
  // for the column they actually use (D16 → A, Codex P2 #10).
  const { resolveEmbeddingColumn, quoteIdentifier } = await import('./search/embedding-column.ts');
  // loadConfig() returns null when ~/.gbrain/config.json is missing.
  // resolveEmbeddingColumn handles missing fields via its own
  // gateway-fallback chain, so a minimal stub satisfies the call shape.
  const cfg = loadConfig() ?? ({ engine: engine.kind } as Parameters<typeof resolveEmbeddingColumn>[1]);
  const resolved = resolveEmbeddingColumn(undefined, cfg);
  const embeddingColIdent = quoteIdentifier(resolved.name);

  const sourceIds = sources.map((s) => s.id);
  type SourceRow = {
    id: string;
    last_commit: string | null;
    last_sync_at: string | Date | null;
    // v0.41.32.0: remote staleness reads this column (no git subprocess).
    newest_content_at: string | Date | null;
  };
  type CountRow = {
    source_id: string;
    pages: string | number;
    chunks_total: string | number;
    chunks_unembedded: string | number;
  };

  // Pull last_commit + last_sync_at fresh (caller may have called us
  // with stale rows). Empty source list → skip the round-trip.
  const sourceRows = sourceIds.length === 0
    ? []
    : await engine.executeRaw<SourceRow>(
        `SELECT id, last_commit, last_sync_at, newest_content_at FROM sources WHERE id = ANY($1::text[])`,
        [sourceIds],
      );
  const sourceMap = new Map<string, SourceRow>();
  for (const r of sourceRows) sourceMap.set(r.id, r);

  // Per-source page + chunk + unembedded-chunk counts in a single
  // round-trip. Canonical SQL (verified against
  // src/commands/doctor/checks/extraction-sync.ts: content_chunks joined on page_id
  // (NOT page_slug — Codex P0 #1), filtered for non-soft-deleted pages
  // (NOT NULL — soft-delete shipped v0.26.5), unembedded counted
  // against the resolved active embedding column (D16 → A).
  //
  // No try/catch swallow — a thrown error means DB down / permission
  // denied / statement timeout (NOT a schema variant). Surfacing the
  // real error is better than a misleading "0 chunks" report (Q2).
  let countRows: CountRow[] = [];
  if (sourceIds.length > 0) {
    countRows = await engine.executeRaw<CountRow>(
      `WITH s AS (
         SELECT unnest($1::text[]) AS source_id
       )
       SELECT
         s.source_id,
         COALESCE(p.pages, 0) AS pages,
         COALESCE(c.chunks_total, 0) AS chunks_total,
         COALESCE(c.chunks_unembedded, 0) AS chunks_unembedded
       FROM s
       LEFT JOIN (
         SELECT source_id, COUNT(*) AS pages
         FROM pages
         WHERE deleted_at IS NULL
         GROUP BY source_id
       ) p ON p.source_id = s.source_id
       LEFT JOIN (
         SELECT pg.source_id,
                COUNT(*) AS chunks_total,
                COUNT(*) FILTER (WHERE cc.${embeddingColIdent} IS NULL) AS chunks_unembedded
         FROM content_chunks cc
         JOIN pages pg ON pg.id = cc.page_id
         WHERE pg.deleted_at IS NULL
         GROUP BY pg.source_id
       ) c ON c.source_id = s.source_id`,
      [sourceIds],
    );
  }
  const countMap = new Map<string, { pages: number; chunks_total: number; chunks_unembedded: number }>();
  for (const r of countRows) {
    countMap.set(r.source_id, {
      pages: Number(r.pages) || 0,
      chunks_total: Number(r.chunks_total) || 0,
      chunks_unembedded: Number(r.chunks_unembedded) || 0,
    });
  }

  // v0.41.31: per-source embed-backfill job state. Best-effort — the
  // minion_jobs table doesn't exist on every brain (a brain that never ran
  // a worker has the pre-minions schema), and the dashboard must not crash
  // for that. A failure → empty map → all sources report 0/null.
  type BackfillRow = {
    source_id: string | null;
    queued: string | number;
    active: string | number;
    last_completed_at: string | Date | null;
  };
  const backfillMap = new Map<string, { queued: number; active: number; last_completed_at: string | null }>();
  if (sourceIds.length > 0) {
    try {
      const backfillRows = await engine.executeRaw<BackfillRow>(
        `SELECT data->>'sourceId' AS source_id,
                COUNT(*) FILTER (WHERE status IN ('waiting','delayed','waiting-children'))::int AS queued,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                MAX(finished_at) FILTER (WHERE status = 'completed') AS last_completed_at
           FROM minion_jobs
          WHERE name = 'embed-backfill' AND data->>'sourceId' = ANY($1::text[])
          GROUP BY data->>'sourceId'`,
        [sourceIds],
      );
      for (const r of backfillRows) {
        if (!r.source_id) continue;
        const last = r.last_completed_at;
        backfillMap.set(r.source_id, {
          queued: Number(r.queued) || 0,
          active: Number(r.active) || 0,
          last_completed_at: last == null ? null : (last instanceof Date ? last.toISOString() : last),
        });
      }
    } catch {
      // minion_jobs absent / unreadable → leave backfillMap empty.
    }
  }

  const now = Date.now();
  const out: SyncStatusReportSource[] = sources.map((src) => {
    const cfgEntry = (src.config || {}) as { syncEnabled?: boolean };
    const row = sourceMap.get(src.id) || { id: src.id, last_commit: null, last_sync_at: null, newest_content_at: null };
    const counts = countMap.get(src.id) || { pages: 0, chunks_total: 0, chunks_unembedded: 0 };
    const lastSyncMs = row.last_sync_at
      ? (row.last_sync_at instanceof Date ? row.last_sync_at.getTime() : Date.parse(row.last_sync_at))
      : null;
    // v0.41.32.0: commit-relative staleness from the stored column — NO git
    // subprocess (this function backs the remote get_status_snapshot MCP op,
    // so it must honor the v0.41.27.0 trust boundary). A quiet repo whose
    // newest commit predates its last sync reports 0; null column → wall-clock.
    const contentMs = row.newest_content_at
      ? (row.newest_content_at instanceof Date ? row.newest_content_at.getTime() : Date.parse(row.newest_content_at))
      : null;
    const lagSeconds = lagFromContentMs(
      Number.isFinite(contentMs as number) ? (contentMs as number) : null,
      lastSyncMs !== null && Number.isFinite(lastSyncMs) ? lastSyncMs : null,
      now,
    );
    const stalenessHours = lagSeconds === null ? null : lagSeconds / 3600;
    const hoursSinceLastSync = lastSyncMs !== null && Number.isFinite(lastSyncMs)
      ? Math.round(((now - lastSyncMs) / 3600_000) * 10) / 10
      : null;
    let stalenessClass: 'fresh' | 'stale' | 'severe' | 'unknown' = 'unknown';
    if (stalenessHours !== null) {
      if (stalenessHours < 24) stalenessClass = 'fresh';
      else if (stalenessHours < 72) stalenessClass = 'stale';
      else stalenessClass = 'severe';
    }
    const embeddingCoveragePct = counts.chunks_total === 0
      ? 100
      : Math.round(((counts.chunks_total - counts.chunks_unembedded) / counts.chunks_total) * 1000) / 10;
    const lastSyncIso = row.last_sync_at
      ? (row.last_sync_at instanceof Date ? row.last_sync_at.toISOString() : row.last_sync_at)
      : null;
    return {
      source_id: src.id,
      name: src.name,
      local_path: src.local_path,
      sync_enabled: cfgEntry.syncEnabled !== false,
      last_sync_at: lastSyncIso,
      hours_since_last_sync: hoursSinceLastSync,
      staleness_hours: stalenessHours === null ? null : Math.round(stalenessHours * 10) / 10,
      staleness_class: stalenessClass,
      last_commit: row.last_commit,
      pages: counts.pages,
      chunks_total: counts.chunks_total,
      chunks_unembedded: counts.chunks_unembedded,
      embedding_coverage_pct: embeddingCoveragePct,
      backfill_queued: backfillMap.get(src.id)?.queued ?? 0,
      backfill_active: backfillMap.get(src.id)?.active ?? 0,
      backfill_last_completed_at: backfillMap.get(src.id)?.last_completed_at ?? null,
    };
  });

  // Unacknowledged sync failures — brain-global (the JSONL log isn't
  // per-source). v0.40.4 TODO will source-scope this. Best-effort:
  // missing file / parse error returns 0, doesn't throw the dashboard.
  let unackedCount = 0;
  try {
    unackedCount = unacknowledgedSyncFailures().length;
  } catch {
    unackedCount = 0;
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    sources: out,
    unacknowledged_failures: unackedCount,
    embedding_column: resolved.name,
  };
}

/**
 * v0.40.3.0 — render a `SyncStatusReport` as a human-readable table.
 *
 * `sink` defaults to `process.stdout` so the bare `gbrain sources status`
 * invocation writes its table to stdout. `--json` callers don't use
 * this — they emit `JSON.stringify(report)` to stdout directly.
 */
export function printSyncStatusReport(
  report: SyncStatusReport,
  sink: NodeJS.WriteStream = process.stdout,
): void {
  const write = (line: string) => sink.write(line + '\n');
  write(`\nSync status — generated ${report.generated_at}`);
  write(`Embedding column: ${report.embedding_column}\n`);
  if (report.sources.length === 0) {
    write('  (no sources registered)');
    return;
  }
  const headers = ['SOURCE', 'STATE', 'STALENESS', 'PAGES', 'EMBEDDED', 'BACKFILL', 'LAST SYNC'];
  const rows = report.sources.map((s) => {
    const stale = s.staleness_hours === null
      ? 'never'
      : `${s.staleness_hours.toFixed(1)}h`;
    const stateBits: string[] = [];
    if (!s.sync_enabled) stateBits.push('disabled');
    stateBits.push(s.staleness_class);
    // BACKFILL: active beats queued beats idle for the at-a-glance cell.
    const backfill = s.backfill_active > 0
      ? `active(${s.backfill_active})`
      : s.backfill_queued > 0
        ? `queued(${s.backfill_queued})`
        : 'idle';
    return [
      s.name,
      stateBits.join(','),
      stale,
      String(s.pages),
      `${s.embedding_coverage_pct}%`,
      backfill,
      s.last_sync_at ?? '(never)',
    ];
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  // Numeric columns (STALENESS=2, PAGES=3, EMBEDDED=4) right-pad-left so
  // digits align cleanly. Text columns (incl. BACKFILL=5) left-pad-right
  // per the existing `sources list` convention.
  const NUMERIC_COLS = new Set([2, 3, 4]);
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (NUMERIC_COLS.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  write(fmt(headers));
  write(fmt(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) write(fmt(r));
  write(`\nUnacknowledged sync failures (brain-wide): ${report.unacknowledged_failures}`);
  const severe = report.sources.filter((s) => s.staleness_class === 'severe').length;
  if (severe > 0) {
    write(`WARNING: ${severe} source(s) are SEVERELY stale (>72h). Run \`gbrain sync --all\` to refresh.`);
  }
}
