/**
 * generated-report — read-only report over dream/synthesis-generated pages
 * (#2570 v1).
 *
 * Zero writes by contract: this module only SELECTs. It enumerates pages
 * carrying the durable dream-provenance marker stamped by #2569
 * (`dream_generated: true` + a valid `dream_cycle_date` in `pages.frontmatter`)
 * and classifies each page's inbound links into an adoption bucket:
 *
 *   external          — at least one classification-eligible inbound origin
 *                       that is NOT itself dream-generated (adoption signal)
 *   generated_cluster — at least one non-summary origin, and every eligible
 *                       origin is itself dream-generated (provenance artifact)
 *   summary_only      — the only eligible origins are the source's own
 *                       `dream-cycle-summaries/<cycle-date>` index pages
 *   none              — no classification-eligible inbound origins at all
 *
 * Precedence is fixed (most-adopted wins): external > generated_cluster >
 * summary_only > none, evaluated per DISTINCT inbound origin page (JOIN by
 * page_id — never by slug).
 *
 * link_source treatment (classification eligibility):
 *   - 'mentions'          — EXCLUDED. Auto-extracted body-text mentions are
 *                           extraction artifacts, not adoption evidence; they
 *                           never promote a page to `external`. They are still
 *                           counted in the raw edge total so nothing is hidden.
 *   - 'markdown'          — eligible (explicit [Name](path) / [[slug]] body refs).
 *   - 'frontmatter'       — eligible (explicit YAML edges).
 *   - 'wikilink-resolved' — eligible (opt-in global-basename [[name]], #972).
 *   - 'manual'            — eligible (user/tool-created edges).
 *   - NULL / other tags   — eligible (legacy pre-v0.13 rows and external
 *                           derivers; treated as explicit until proven
 *                           otherwise — only 'mentions' is a known artifact).
 *
 * #2569 caveat: the child-page DB stamp is per-row best-effort (a failed stamp
 * never fails the synthesize phase), so this report covers "generated pages
 * with a durable marker" — NOT a guaranteed-complete enumeration. The report
 * surfaces a cheap coverage signal (`summary_linked_unstamped`): live pages
 * that a dream-cycle summary links to but that lack the durable marker.
 *
 * The classifier is a pure function (DB rows in → bucket out) so it is
 * unit-testable without an engine; `buildGeneratedPagesReport` is the thin
 * query + assembly layer shared by the CLI (`gbrain generated list`) and the
 * MCP op (`list_generated_pages`).
 */

import type { BrainEngine } from './engine.ts';
import { createProgress, startHeartbeat } from './progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from './cli-options.ts';

// --- Contract constants ---

/** Bump on any breaking change to the JSON report shape. */
export const GENERATED_REPORT_SCHEMA_VERSION = 1;

/** Default cap on the candidates list (`--limit` overrides; 0 = no cap). */
export const DEFAULT_CANDIDATE_LIMIT = 10;

export type AdoptionBucket = 'external' | 'generated_cluster' | 'summary_only' | 'none';

/**
 * Deterministic candidate ordering: least-adopted first. Within a bucket,
 * newest cycle first, then (source_id, slug) for a total order.
 */
const BUCKET_SORT_RANK: Record<AdoptionBucket, number> = {
  none: 0,
  summary_only: 1,
  generated_cluster: 2,
  external: 3,
};

/**
 * link_source values excluded from classification. Only 'mentions' today:
 * auto-linked body-text mentions are extraction artifacts, not adoption
 * evidence (see module header for the full link_source table).
 */
export const CLASSIFICATION_INELIGIBLE_LINK_SOURCES: ReadonlySet<string> = new Set(['mentions']);

/**
 * Dream-cycle summary index slug, as written by synthesize.ts
 * (`dream-cycle-summaries/${summaryDate}`).
 */
const DREAM_SUMMARY_SLUG_RE = /^dream-cycle-summaries\/\d{4}-\d{2}-\d{2}$/;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- Pure predicates ---

/** True when `v` is a syntactically valid, real UTC calendar date `YYYY-MM-DD`. */
export function isValidCycleDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

/**
 * Marker fields as extracted from a pages row via `frontmatter->>'…'`
 * (jsonb `->>` renders booleans as the text 'true'/'false').
 *
 * Canonical-boolean strictness lives at the extraction site: the report SQL
 * projects `dream_generated` through `CASE WHEN jsonb_typeof(frontmatter->
 * 'dream_generated') = 'boolean' THEN frontmatter->>'dream_generated' END`,
 * so a noncanonical string marker (`dream_generated: "true"`) arrives here
 * as NULL and never satisfies the predicate. `->>` alone cannot make that
 * distinction (it renders both as the text 'true').
 */
export interface GeneratedMarkerFields {
  /** `frontmatter->>'dream_generated'`, NULL unless a canonical jsonb boolean. */
  dream_generated: string | null;
  /** `frontmatter->>'dream_cycle_date'` */
  dream_cycle_date: string | null;
  /** `pages.type` */
  page_type: string | null;
  /** `frontmatter->>'type'` */
  fm_type: string | null;
}

/**
 * The durable generated-page marker condition (#2569 + #2570 contract):
 * `dream_generated: true` AND a valid `dream_cycle_date`, excluding
 * `extract_receipt` pages (they reuse `dream_generated: true` purely as an
 * anti-ingestion-loop guard — see receipt-writer.ts — and are not
 * dream/synthesis knowledge pages).
 */
export function hasDurableDreamMarker(f: GeneratedMarkerFields): boolean {
  if (f.dream_generated !== 'true') return false;
  if (!isValidCycleDate(f.dream_cycle_date)) return false;
  if (f.page_type === 'extract_receipt' || f.fm_type === 'extract_receipt') return false;
  return true;
}

/** True when `slug` is a dream-cycle summary index page. */
export function isDreamSummarySlug(slug: string): boolean {
  return DREAM_SUMMARY_SLUG_RE.test(slug);
}

/**
 * Resolve a `--since` spec to an inclusive UTC cycle-date floor.
 * Accepts `YYYY-MM-DD` (used as-is), `<N>d`, or `<N>w` (relative to `nowUtc`).
 * Returns null when `since` is absent (no window filter). Throws on
 * unparseable input. Comparison target is `dream_cycle_date` — NOT
 * `updated_at` — per the #2570 alignment contract.
 */
export function resolveSinceWindow(since: string | null | undefined, nowUtc: Date): string | null {
  if (since === null || since === undefined || since.trim() === '') return null;
  const s = since.trim();
  if (ISO_DATE_RE.test(s)) {
    if (!isValidCycleDate(s)) {
      throw new Error(`--since: "${s}" is not a real calendar date`);
    }
    return s;
  }
  const m = /^(\d+)([dw])$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const days = m[2] === 'w' ? n * 7 : n;
    const floorMs = Date.UTC(
      nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(),
    ) - days * 86_400_000;
    return new Date(floorMs).toISOString().slice(0, 10);
  }
  throw new Error(
    `--since: could not parse "${since}" (expected YYYY-MM-DD, "30d", or "4w")`,
  );
}

// --- Pure classifier ---

/** One inbound link edge row (target join already applied by the caller). */
export interface InboundEdgeRow {
  /** links.from_page_id (origin pages.id) — classification joins by page_id. */
  origin_id: number;
  origin_slug: string;
  origin_source_id: string;
  link_source: string | null;
  /** origin pages.type */
  origin_page_type: string | null;
  /** origin `frontmatter->>'type'` */
  origin_fm_type: string | null;
  /** origin `frontmatter->>'dream_generated'` */
  origin_dream_generated: string | null;
  /** origin `frontmatter->>'dream_cycle_date'` */
  origin_cycle_date: string | null;
}

export interface InboundStats {
  /**
   * All live inbound edges regardless of link_source (mentions included),
   * EXCLUDING self-links (broken out below) and edges whose origin page is
   * soft-deleted (filtered at query time).
   */
  raw_edges: number;
  /** Inbound edges where origin_id === target page id (never adoption signal). */
  self_link_edges: number;
  /** Non-self edges with a classification-eligible link_source (mentions excluded). */
  eligible_edges: number;
  /** Distinct origin pages contributing at least one eligible edge. */
  eligible_origins: number;
  /** Distinct non-self origins whose ONLY edges are ineligible (mentions). */
  mentions_only_origins: number;
  /** Distinct eligible origins by kind (external / generated / summary). */
  origin_kinds: { external: number; generated: number; summary: number };
}

/**
 * Kind of a single inbound origin, relative to a target page:
 *   'summary'   — the target's own source's dream-cycle summary index page
 *                 (matched by slug shape + same source_id; slug-based on
 *                 purpose so a summary whose best-effort stamp failed still
 *                 classifies as a summary, not as external).
 *   'generated' — any page carrying the `dream_generated: true` provenance
 *                 flag. Deliberately LOOSER than the target-side durable
 *                 marker: for origin classification the question is "is this
 *                 link from autonomous generated provenance?", and the flag
 *                 alone answers it (extract receipts and pages with a
 *                 missing/invalid cycle date are still machine provenance —
 *                 their links must not count as external adoption).
 *   'external'  — everything else (human/curated provenance).
 */
export function classifyOriginKind(
  edge: Pick<
    InboundEdgeRow,
    'origin_slug' | 'origin_source_id' | 'origin_dream_generated'
  >,
  targetSourceId: string,
): 'summary' | 'generated' | 'external' {
  if (isDreamSummarySlug(edge.origin_slug) && edge.origin_source_id === targetSourceId) {
    return 'summary';
  }
  if (edge.origin_dream_generated === 'true') return 'generated';
  return 'external';
}

/**
 * Pure classifier: raw inbound edge rows in → adoption bucket + counts out.
 *
 * Fixed precedence (most-adopted wins): external > generated_cluster >
 * summary_only > none. Evaluated over DISTINCT eligible origin pages;
 * duplicate edges from the same origin (e.g. a markdown ref AND a
 * frontmatter ref) count once for classification.
 */
export function classifyInbound(
  targetId: number,
  targetSourceId: string,
  edges: InboundEdgeRow[],
): { bucket: AdoptionBucket; inbound: InboundStats } {
  let selfLinkEdges = 0;
  let rawEdges = 0;
  let eligibleEdges = 0;
  const eligibleByOrigin = new Map<number, InboundEdgeRow>();
  const rawOrigins = new Set<number>();

  for (const e of edges) {
    if (e.origin_id === targetId) {
      selfLinkEdges++;
      continue;
    }
    rawEdges++;
    rawOrigins.add(e.origin_id);
    const ineligible =
      e.link_source !== null && CLASSIFICATION_INELIGIBLE_LINK_SOURCES.has(e.link_source);
    if (ineligible) continue;
    eligibleEdges++;
    if (!eligibleByOrigin.has(e.origin_id)) eligibleByOrigin.set(e.origin_id, e);
  }

  const kinds = { external: 0, generated: 0, summary: 0 };
  for (const e of eligibleByOrigin.values()) {
    kinds[classifyOriginKind(e, targetSourceId)]++;
  }

  const bucket: AdoptionBucket =
    kinds.external > 0
      ? 'external'
      : kinds.generated > 0
        ? 'generated_cluster'
        : kinds.summary > 0
          ? 'summary_only'
          : 'none';

  return {
    bucket,
    inbound: {
      raw_edges: rawEdges,
      self_link_edges: selfLinkEdges,
      eligible_edges: eligibleEdges,
      eligible_origins: eligibleByOrigin.size,
      mentions_only_origins: rawOrigins.size - eligibleByOrigin.size,
      origin_kinds: kinds,
    },
  };
}

// --- Report assembly ---

export interface GeneratedPageCandidate {
  slug: string;
  source_id: string;
  title: string;
  type: string;
  dream_cycle_date: string;
  bucket: AdoptionBucket;
  inbound: InboundStats;
}

export interface GeneratedPagesReport {
  schema_version: number;
  report: 'generated_pages';
  window: { since: string | null };
  /** Explicit source scope, or null for brain-wide. */
  source_scope: string[] | null;
  summary: {
    generated_pages_scanned: number;
    buckets: Record<AdoptionBucket, number>;
  };
  coverage: {
    /**
     * Live pages linked from a dream-cycle summary but lacking the durable
     * marker — the cheap #2569 best-effort-stamp signal. Includes pre-#2569
     * cycles whose pages were never DB-stamped. When > 0, the scan above is
     * an under-enumeration.
     */
    summary_linked_unstamped: number;
    note: string;
  };
  /**
   * Review candidates: pages WITHOUT an external adoption signal
   * (none / summary_only / generated_cluster), least-adopted first,
   * newest cycle first within a bucket, capped by `limit`.
   */
  candidates: GeneratedPageCandidate[];
  candidates_truncated: boolean;
  total_candidates: number;
}

export interface GeneratedReportOpts {
  sourceId?: string;
  sourceIds?: string[];
  /** `YYYY-MM-DD`, `<N>d`, or `<N>w`; inclusive floor on dream_cycle_date. */
  since?: string;
  /** Candidate list cap; 0 = uncapped. Default DEFAULT_CANDIDATE_LIMIT. */
  limit?: number;
  /** Injectable clock for tests (relative `--since` resolution). */
  now?: Date;
}

interface TargetEdgeRow {
  target_id: number;
  slug: string;
  source_id: string;
  title: string;
  page_type: string;
  fm_type: string | null;
  dream_generated: string | null;
  dream_cycle_date: string | null;
  origin_id: number | null;
  origin_slug: string | null;
  origin_source_id: string | null;
  link_source: string | null;
  origin_page_type: string | null;
  origin_fm_type: string | null;
  origin_dream_generated: string | null;
  origin_cycle_date: string | null;
}

interface SummaryLinkedRow {
  target_id: number;
  page_type: string;
  fm_type: string | null;
  dream_generated: string | null;
  dream_cycle_date: string | null;
  target_source_id: string;
  summary_slug: string;
  summary_source_id: string;
}

/** Build `(clause, params)` for an optional source filter on `<alias>.source_id`. */
function sourceFilter(
  alias: string,
  opts: { sourceId?: string; sourceIds?: string[] },
  startIndex: number,
): { clause: string; params: string[] } {
  // Mirrors sourceScopeOpts precedence: federated array > scalar > nothing.
  const ids =
    opts.sourceIds && opts.sourceIds.length > 0
      ? opts.sourceIds
      : opts.sourceId
        ? [opts.sourceId]
        : [];
  if (ids.length === 0) return { clause: '', params: [] };
  const placeholders = ids.map((_, i) => `$${startIndex + i}`).join(', ');
  return { clause: ` AND ${alias}.source_id IN (${placeholders})`, params: ids };
}

/**
 * Run the read-only generated-pages report. Zero writes; repeated runs are
 * idempotent. Deterministic output for a fixed DB state and fixed `since`
 * (relative windows resolve against `opts.now` ?? wall clock).
 */
export async function buildGeneratedPagesReport(
  engine: BrainEngine,
  opts: GeneratedReportOpts = {},
): Promise<GeneratedPagesReport> {
  const sinceFloor = resolveSinceWindow(opts.since, opts.now ?? new Date());
  const limit = opts.limit === undefined ? DEFAULT_CANDIDATE_LIMIT : opts.limit;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`--limit: expected a non-negative integer, got "${opts.limit}"`);
  }

  const scope = { sourceId: opts.sourceId, sourceIds: opts.sourceIds };

  // One bulk query: every live page carrying the durable marker, LEFT JOINed
  // to its live inbound edges (origin page joined by page_id).
  //
  // The `targets` CTE pushes the cheap-but-exact SQL prefilters (canonical
  // boolean marker, date-shaped cycle date, receipt exclusion, `--since`
  // floor, source scope) BELOW the links join so a large brain never
  // materializes edges for pages outside the report. The TS predicate
  // (`hasDurableDreamMarker` + full calendar-date validation) re-checks every
  // row — SQL is a consistent superset filter, TS stays authoritative, and
  // the pure function the unit tests pin cannot drift from what ships.
  //
  // Marker strictness: `jsonb_typeof(... ) = 'boolean'` restricts to the
  // canonical boolean stamp written by #2569. A hand-written string
  // `dream_generated: "true"` is NOT the durable marker and is not
  // enumerated. The origin-side extraction applies the same CASE so a
  // noncanonical origin can't masquerade as generated provenance.
  //
  // Source scope applies to the TARGET side only — inbound origins are
  // counted from ANY source, mirroring findOrphans' deliberate definition
  // (see docs/architecture/KEY_FILES.md on `src/commands/orphans.ts`): a
  // page in source X linked FROM source Y is genuinely adopted, and scoping
  // origins would misreport it as `none`. Candidates never expose origin
  // slugs, only aggregate counts.
  const targetFilter = sourceFilter('tp', scope, 1);
  const targetParams: string[] = [...targetFilter.params];
  let sinceClause = '';
  if (sinceFloor !== null) {
    targetParams.push(sinceFloor);
    sinceClause = ` AND tp.frontmatter->>'dream_cycle_date' >= $${targetParams.length}`;
  }
  const targetSql = `
    WITH targets AS (
      SELECT
        tp.id                               AS target_id,
        tp.slug                             AS slug,
        tp.source_id                        AS source_id,
        tp.title                            AS title,
        tp.type                             AS page_type,
        tp.frontmatter->>'type'             AS fm_type,
        tp.frontmatter->>'dream_generated'  AS dream_generated,
        tp.frontmatter->>'dream_cycle_date' AS dream_cycle_date
      FROM pages tp
      WHERE tp.deleted_at IS NULL
        AND jsonb_typeof(tp.frontmatter->'dream_generated') = 'boolean'
        AND tp.frontmatter->>'dream_generated' = 'true'
        AND tp.frontmatter->>'dream_cycle_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND tp.type <> 'extract_receipt'
        AND COALESCE(tp.frontmatter->>'type', '') <> 'extract_receipt'${targetFilter.clause}${sinceClause}
    )
    SELECT
      t.target_id, t.slug, t.source_id, t.title, t.page_type, t.fm_type,
      t.dream_generated, t.dream_cycle_date,
      e.origin_id                         AS origin_id,
      e.origin_slug                       AS origin_slug,
      e.origin_source_id                  AS origin_source_id,
      e.link_source                       AS link_source,
      e.origin_page_type                  AS origin_page_type,
      e.origin_fm_type                    AS origin_fm_type,
      e.origin_dream_generated            AS origin_dream_generated,
      e.origin_cycle_date                 AS origin_cycle_date
    FROM targets t
    LEFT JOIN (
      SELECT l.to_page_id                     AS to_page_id,
             l.from_page_id                   AS origin_id,
             l.link_source                    AS link_source,
             op.slug                          AS origin_slug,
             op.source_id                     AS origin_source_id,
             op.type                          AS origin_page_type,
             op.frontmatter->>'type'          AS origin_fm_type,
             CASE WHEN jsonb_typeof(op.frontmatter->'dream_generated') = 'boolean'
                  THEN op.frontmatter->>'dream_generated' END AS origin_dream_generated,
             op.frontmatter->>'dream_cycle_date' AS origin_cycle_date
        FROM links l
        JOIN pages op ON op.id = l.from_page_id AND op.deleted_at IS NULL
    ) e ON e.to_page_id = t.target_id
    ORDER BY t.source_id ASC, t.slug ASC`;

  // Cheap #2569 coverage probe: live pages a live dream-cycle summary links
  // to. Marker validity is evaluated in TS with the same pure predicate.
  const coverageFilter = sourceFilter('sp', scope, 1);
  const coverageSql = `
    SELECT DISTINCT
      tp.id                               AS target_id,
      tp.type                             AS page_type,
      tp.frontmatter->>'type'             AS fm_type,
      CASE WHEN jsonb_typeof(tp.frontmatter->'dream_generated') = 'boolean'
           THEN tp.frontmatter->>'dream_generated' END AS dream_generated,
      tp.frontmatter->>'dream_cycle_date' AS dream_cycle_date,
      tp.source_id                        AS target_source_id,
      sp.slug                             AS summary_slug,
      sp.source_id                        AS summary_source_id
    FROM links l
    JOIN pages sp ON sp.id = l.from_page_id AND sp.deleted_at IS NULL
    JOIN pages tp ON tp.id = l.to_page_id AND tp.deleted_at IS NULL
    WHERE l.from_page_id <> l.to_page_id
      AND sp.slug LIKE 'dream-cycle-summaries/%'${coverageFilter.clause}`;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('generated_report.scan');
  const stopHb = startHeartbeat(progress, 'scanning generated pages + inbound links…');
  let rows: TargetEdgeRow[];
  let coverageRows: SummaryLinkedRow[];
  try {
    rows = await engine.executeRaw<TargetEdgeRow>(targetSql, targetParams);
    coverageRows = await engine.executeRaw<SummaryLinkedRow>(coverageSql, coverageFilter.params);
  } finally {
    stopHb();
    progress.finish();
  }

  // Group edge rows per target page.
  const targets = new Map<
    number,
    { meta: TargetEdgeRow; edges: InboundEdgeRow[] }
  >();
  for (const row of rows) {
    let t = targets.get(row.target_id);
    if (!t) {
      t = { meta: row, edges: [] };
      targets.set(row.target_id, t);
    }
    if (row.origin_id !== null) {
      t.edges.push({
        origin_id: row.origin_id,
        origin_slug: row.origin_slug ?? '',
        origin_source_id: row.origin_source_id ?? '',
        link_source: row.link_source,
        origin_page_type: row.origin_page_type,
        origin_fm_type: row.origin_fm_type,
        origin_dream_generated: row.origin_dream_generated,
        origin_cycle_date: row.origin_cycle_date,
      });
    }
  }

  const buckets: Record<AdoptionBucket, number> = {
    external: 0,
    generated_cluster: 0,
    summary_only: 0,
    none: 0,
  };
  const candidates: GeneratedPageCandidate[] = [];
  let scanned = 0;

  for (const { meta, edges } of targets.values()) {
    const marker: GeneratedMarkerFields = {
      dream_generated: meta.dream_generated,
      dream_cycle_date: meta.dream_cycle_date,
      page_type: meta.page_type,
      fm_type: meta.fm_type,
    };
    if (!hasDurableDreamMarker(marker)) continue;
    const cycleDate = meta.dream_cycle_date as string; // validated above
    // Inclusive UTC date comparison on dream_cycle_date (both sides are
    // validated YYYY-MM-DD strings, so lexicographic compare is date compare).
    if (sinceFloor !== null && cycleDate < sinceFloor) continue;

    scanned++;
    const { bucket, inbound } = classifyInbound(meta.target_id, meta.source_id, edges);
    buckets[bucket]++;
    if (bucket !== 'external') {
      candidates.push({
        slug: meta.slug,
        source_id: meta.source_id,
        title: meta.title,
        type: meta.page_type,
        dream_cycle_date: cycleDate,
        bucket,
        inbound,
      });
    }
  }

  candidates.sort((a, b) => {
    const rank = BUCKET_SORT_RANK[a.bucket] - BUCKET_SORT_RANK[b.bucket];
    if (rank !== 0) return rank;
    if (a.dream_cycle_date !== b.dream_cycle_date) {
      return a.dream_cycle_date < b.dream_cycle_date ? 1 : -1; // newest first
    }
    if (a.source_id !== b.source_id) return a.source_id < b.source_id ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  const totalCandidates = candidates.length;
  const capped = limit > 0 && candidates.length > limit
    ? candidates.slice(0, limit)
    : candidates;

  // Coverage: distinct summary-linked live pages missing the durable marker.
  // Window-scoped via the cycle date embedded in the summary slug so the
  // warning matches the scan window it annotates.
  const unstamped = new Set<number>();
  for (const row of coverageRows) {
    if (!isDreamSummarySlug(row.summary_slug)) continue;
    if (row.summary_source_id !== row.target_source_id) continue;
    const summaryDate = row.summary_slug.slice('dream-cycle-summaries/'.length);
    if (!isValidCycleDate(summaryDate)) continue;
    if (sinceFloor !== null && summaryDate < sinceFloor) continue;
    const marker: GeneratedMarkerFields = {
      dream_generated: row.dream_generated,
      dream_cycle_date: row.dream_cycle_date,
      page_type: row.page_type,
      fm_type: row.fm_type,
    };
    if (!hasDurableDreamMarker(marker)) unstamped.add(row.target_id);
  }

  const sourceScope =
    scope.sourceIds && scope.sourceIds.length > 0
      ? [...scope.sourceIds]
      : scope.sourceId
        ? [scope.sourceId]
        : null;

  return {
    schema_version: GENERATED_REPORT_SCHEMA_VERSION,
    report: 'generated_pages',
    window: { since: sinceFloor },
    source_scope: sourceScope,
    summary: {
      generated_pages_scanned: scanned,
      buckets,
    },
    coverage: {
      summary_linked_unstamped: unstamped.size,
      note:
        'The #2569 provenance stamp is per-row best-effort; pages linked from a ' +
        'dream-cycle summary without a durable marker are not enumerated above. ' +
        'A non-zero count means this report under-enumerates.',
    },
    candidates: capped,
    candidates_truncated: capped.length < totalCandidates,
    total_candidates: totalCandidates,
  };
}
