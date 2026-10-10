/**
 * #5575 (CEO-25 / ENG-17) read-only write-gate exposure scan: how much
 * existing memory the gate would flag or quarantine, by projected trust tier
 * and reason family, before any default is set.
 *
 * Pure reads (keyset batches over pages, facts, takes and timeline entries);
 * it writes nothing (no receipts, holds, config or markers). The caller runs
 * it inside a READ ONLY transaction (`scripts/trust-dry-run-scan.ts`), so the
 * database refuses any write. The report holds counts and pattern names only,
 * never content, slugs or ids.
 *
 * Tiers are projected from the same deterministic signals the backfill uses
 * (A8, CEO-17), never guessed: connector sources, webhook and web-clipper
 * pages are `external_untrusted`; `mcp:*` / capture / transcript pages and
 * agent-relayed or derived rows are `agent_written`; managed sync and import
 * requests are `operator_curated`; the lowest signal wins, and a row with no
 * signal is `unknown`.
 */
import type { BrainEngine } from './engine.ts';
import {
  assessFactForGate, assessPageForGate, assessTakeForGate, assessTimelineForGate, DEFAULT_WRITE_GATE_CONFIG,
  WRITE_GATE_DETECTOR_VERSION, WRITE_GATE_TIERS, isWriteGateTier,
  type WriteGateAssessment, type WriteGateConfig, type WriteGateTier, type WriteGateVerdict,
} from './write-gate.ts';
import { WRITE_GATE_REASON_FAMILIES, type WriteGateReasonFamily } from './write-gate-patterns.ts';
import { minTrust } from './trust/tier.ts';

export type WriteGateScanTable = 'pages' | 'facts' | 'takes' | 'timeline_entries';
export const WRITE_GATE_SCAN_TABLES: readonly WriteGateScanTable[] = ['pages', 'facts', 'takes', 'timeline_entries'];

export interface WriteGateScanTierStats {
  rows: number;
  /** Rows the detector matched, whatever the tier (the rate the gate would see if it ran there). */
  detector_hits: number;
  /** Verdicts under the scan's config at this tier (owner tiers are always `allow`). */
  verdicts: Record<WriteGateVerdict, number>;
  families: Record<WriteGateReasonFamily, number>;
}

export interface WriteGateScanTableReport {
  scanned: number;
  /** A per-table row limit stopped the scan early. */
  truncated: boolean;
  by_tier: Record<WriteGateTier, WriteGateScanTierStats>;
  /** Detector hits per pattern name across all tiers. */
  patterns: Record<string, number>;
}

export interface WriteGateScanReport {
  schema_version: 1;
  detector_version: number;
  config: WriteGateConfig;
  read_only: true;
  source_id: string | null;
  tables: Partial<Record<WriteGateScanTable, WriteGateScanTableReport>>;
  totals: {
    rows: number;
    flagged: number;
    quarantined: number;
    rejected: number;
    detector_hits: number;
    /** detector_hits / rows across all tiers: the flag rate if every row were agent_written. */
    hit_rate: number;
  };
}

export interface WriteGateScanOptions {
  sourceId?: string;
  tables?: readonly WriteGateScanTable[];
  /** Max rows per table (default: all). */
  limitPerTable?: number;
  batchSize?: number;
  cfg?: WriteGateConfig;
  onBatch?: (table: WriteGateScanTable, scanned: number) => void;
}

type Exec = Pick<BrainEngine, 'executeRaw'>;

/** Lowest of the present signals; `unknown` when none. */
export function projectTier(signals: ReadonlyArray<string | null | undefined>): WriteGateTier {
  const [first, ...rest] = signals.filter(isWriteGateTier);
  return first ? minTrust(first, ...rest) : 'unknown';
}

/** Page-level signal on alias `pg` (with sources alias `src`): connector/webhook/clipper -> external, agent channels -> agent. */
const PAGE_SIGNAL = (pg: string, src: string) => `CASE
  WHEN ${src}.config->>'kind' IN ('google','github') OR ${pg}.source_kind = 'webhook' OR COALESCE(${pg}.frontmatter, '{}'::jsonb) ? 'source_url' THEN 'external_untrusted'
  WHEN ${pg}.source_kind LIKE 'mcp:%' OR ${pg}.ingested_via LIKE 'mcp:%' OR ${pg}.source_kind = 'capture-cli'
    OR ${pg}.frontmatter->>'capturedVia' IS NOT NULL OR COALESCE(${pg}.frontmatter, '{}'::jsonb) ? 'transcript_import' THEN 'agent_written'
  END`;

/** Request-level signal (CEO-17) on persistence_requests alias `pr`. */
const REQUEST_SIGNAL = (pr: string) => `CASE
  WHEN ${pr}.id IS NULL THEN NULL
  WHEN ${pr}.intent->>'kind' LIKE 'connector_%' OR ${pr}.intent->>'kind' LIKE 'managed_connector_%' THEN 'external_untrusted'
  WHEN ${pr}.authority->>'remote' = 'true' THEN 'agent_written'
  WHEN ${pr}.intent->>'kind' LIKE 'managed_sync_%' OR ${pr}.intent->>'kind' IN ('managed_file_import','managed_file_repair','canonical_reconcile','managed_grandfather') THEN 'operator_curated'
  WHEN ${pr}.operation IN ('put_page','capture','edit_page','remember','takes_add','takes_update','takes_supersede','add_timeline_entry','extract_facts','restore_page','revert_version') THEN 'agent_written'
  END`;

/** Fact provenance tags of agent writes and derivers (extraction, backstop, hooks): capped at agent_written. */
const FACT_SOURCE_SIGNAL = `CASE WHEN f.source LIKE 'mcp:%' OR f.source LIKE 'hook:%' OR f.source LIKE 'sweep:%' OR f.source LIKE 'cli:%'
  OR f.source IN ('sync:import','file_upload','code_import') THEN 'agent_written' END`;

interface ScanRow { id: string; source_id: string; page_signal: string | null; request_signal: string | null; row_signal?: string | null }

function emptyTier(): WriteGateScanTierStats {
  return {
    rows: 0, detector_hits: 0, verdicts: { allow: 0, flag: 0, quarantine: 0, reject: 0 },
    families: Object.fromEntries(WRITE_GATE_REASON_FAMILIES.map(f => [f, 0])) as Record<WriteGateReasonFamily, number>,
  };
}

function emptyTable(): WriteGateScanTableReport {
  return { scanned: 0, truncated: false, by_tier: Object.fromEntries(WRITE_GATE_TIERS.map(t => [t, emptyTier()])) as Record<WriteGateTier, WriteGateScanTierStats>, patterns: {} };
}

/** Which request-attribution joins the scanned schema supports (pre-v193 brains have none). */
interface ScanCaps { requests: boolean; pageRequest: boolean; factRequest: boolean; takeRequest: boolean; timelineRequest: boolean }

const requestSql = (enabled: boolean) => enabled ? REQUEST_SIGNAL('pr') : 'NULL';
const requestJoin = (enabled: boolean, row: string, column: string) => enabled ? `LEFT JOIN persistence_requests pr ON pr.id = ${row}.${column}` : '';

interface TableSpec<R extends ScanRow> {
  sql: (scoped: boolean, caps: ScanCaps) => string;
  assess: (row: R, tier: WriteGateTier, cfg: WriteGateConfig) => WriteGateAssessment;
}

const SPECS: { [T in WriteGateScanTable]: TableSpec<ScanRow & Record<string, unknown>> } = {
  pages: {
    sql: (scoped, caps) => `SELECT p.id::text AS id, p.source_id, p.title, p.compiled_truth, p.timeline, p.frontmatter,
        ${PAGE_SIGNAL('p', 's')} AS page_signal, ${requestSql(caps.pageRequest)} AS request_signal
      FROM pages p LEFT JOIN sources s ON s.id = p.source_id ${requestJoin(caps.pageRequest, 'p', 'revision_write_request_id')}
      WHERE p.deleted_at IS NULL AND p.id > $1::bigint ${scoped ? 'AND p.source_id = $3' : ''} ORDER BY p.id LIMIT $2`,
    assess: (r, tier, cfg) => assessPageForGate({
      title: r.title as string | null, compiled_truth: String(r.compiled_truth ?? ''), timeline: r.timeline as string | null,
      frontmatter: (typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter) as Record<string, unknown> | null,
    }, { tier }, cfg),
  },
  facts: {
    sql: (scoped, caps) => `SELECT f.id::text AS id, f.source_id, f.fact, f.context, f.value, f.source,
        ${PAGE_SIGNAL('sp', 's')} AS page_signal, ${requestSql(caps.factRequest)} AS request_signal, ${FACT_SOURCE_SIGNAL} AS row_signal
      FROM facts f LEFT JOIN sources s ON s.id = f.source_id
        LEFT JOIN pages sp ON sp.source_id = f.source_id AND sp.slug = f.source_markdown_slug
        ${requestJoin(caps.factRequest, 'f', 'write_request_id')}
      WHERE f.expired_at IS NULL AND f.id > $1::bigint ${scoped ? 'AND f.source_id = $3' : ''} ORDER BY f.id LIMIT $2`,
    assess: (r, tier, cfg) => assessFactForGate({ fact: String(r.fact ?? ''), context: r.context as string | null, value: r.value as string | null, source: r.source as string | null }, { tier }, cfg),
  },
  takes: {
    sql: (scoped, caps) => `SELECT t.id::text AS id, p.source_id, t.claim, t.source,
        ${PAGE_SIGNAL('p', 's')} AS page_signal, ${requestSql(caps.takeRequest)} AS request_signal, 'agent_written' AS row_signal
      FROM takes t JOIN pages p ON p.id = t.page_id LEFT JOIN sources s ON s.id = p.source_id
        ${requestJoin(caps.takeRequest, 't', 'write_request_id')}
      WHERE t.active AND t.id > $1::bigint ${scoped ? 'AND p.source_id = $3' : ''} ORDER BY t.id LIMIT $2`,
    assess: (r, tier, cfg) => assessTakeForGate({ claim: String(r.claim ?? ''), source: r.source as string | null }, { tier }, cfg),
  },
  timeline_entries: {
    sql: (scoped, caps) => `SELECT te.id::text AS id, p.source_id, te.summary, te.detail, te.source,
        ${PAGE_SIGNAL('p', 's')} AS page_signal, ${requestSql(caps.timelineRequest)} AS request_signal
      FROM timeline_entries te JOIN pages p ON p.id = te.page_id LEFT JOIN sources s ON s.id = p.source_id
        ${requestJoin(caps.timelineRequest, 'te', 'write_request_id')}
      WHERE te.id > $1::bigint ${scoped ? 'AND p.source_id = $3' : ''} ORDER BY te.id LIMIT $2`,
    assess: (r, tier, cfg) => assessTimelineForGate({ summary: String(r.summary ?? ''), detail: r.detail as string | null, source: r.source as string | null }, { tier }, cfg),
  },
};

/** Scan existing memory and report what the gate would do, writing nothing. Run it inside a READ ONLY transaction. */
export async function scanWriteGateExposure(exec: Exec, opts: WriteGateScanOptions = {}): Promise<WriteGateScanReport> {
  const cfg = opts.cfg ?? { ...DEFAULT_WRITE_GATE_CONFIG };
  const batch = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
  const report: WriteGateScanReport = {
    schema_version: 1, detector_version: WRITE_GATE_DETECTOR_VERSION, config: cfg, read_only: true, source_id: opts.sourceId ?? null, tables: {},
    totals: { rows: 0, flagged: 0, quarantined: 0, rejected: 0, detector_hits: 0, hit_rate: 0 },
  };
  const cols = new Set((await exec.executeRaw<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [['pages', 'facts', 'takes', 'timeline_entries', 'persistence_requests']])).map(r => `${r.t}.${r.c}`));
  const requests = ['operation', 'intent', 'authority'].every(c => cols.has(`persistence_requests.${c}`));
  const caps: ScanCaps = {
    requests,
    pageRequest: requests && cols.has('pages.revision_write_request_id'),
    factRequest: requests && cols.has('facts.write_request_id'),
    takeRequest: requests && cols.has('takes.write_request_id'),
    timelineRequest: requests && cols.has('timeline_entries.write_request_id'),
  };
  for (const table of opts.tables ?? WRITE_GATE_SCAN_TABLES) {
    const spec = SPECS[table];
    const out = emptyTable();
    report.tables[table] = out;
    let cursor = '0';
    for (;;) {
      const room = opts.limitPerTable === undefined ? batch : Math.min(batch, opts.limitPerTable - out.scanned);
      if (room <= 0) { out.truncated = true; break; }
      const rows = await exec.executeRaw<ScanRow & Record<string, unknown>>(spec.sql(!!opts.sourceId, caps),
        [cursor, room, ...(opts.sourceId ? [opts.sourceId] : [])]);
      for (const row of rows) {
        const tier = projectTier([row.page_signal, row.request_signal, row.row_signal]);
        const stats = out.by_tier[tier];
        stats.rows++;
        const asIfGated = spec.assess(row, 'agent_written', cfg.agentMode === 'off' ? { ...cfg, agentMode: 'flag' } : cfg);
        if (asIfGated.hits.length) {
          stats.detector_hits++;
          for (const h of asIfGated.hits) out.patterns[h.pattern] = (out.patterns[h.pattern] ?? 0) + 1;
        }
        const actual = (tier === 'agent_written' || tier === 'unknown') && cfg.agentMode !== 'off' ? asIfGated : spec.assess(row, tier, cfg);
        stats.verdicts[actual.verdict]++;
        for (const f of actual.families) stats.families[f]++;
      }
      out.scanned += rows.length;
      opts.onBatch?.(table, out.scanned);
      if (rows.length < room) break;
      cursor = rows[rows.length - 1]!.id;
    }
    for (const stats of Object.values(out.by_tier)) {
      report.totals.rows += stats.rows;
      report.totals.flagged += stats.verdicts.flag;
      report.totals.quarantined += stats.verdicts.quarantine;
      report.totals.rejected += stats.verdicts.reject;
      report.totals.detector_hits += stats.detector_hits;
    }
  }
  report.totals.hit_rate = report.totals.rows ? Number((report.totals.detector_hits / report.totals.rows).toFixed(4)) : 0;
  return report;
}
