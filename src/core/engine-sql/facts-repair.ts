/**
 * Group 5 facts statements, repair classifiers and loop retirement (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved.
 */
import { contextHeadSql, PAGE_EXTRACTION_SOURCE_LIST } from '../facts/gone-page-facts.ts';
import { withdrawalCoversFactSql } from '../access/member-facts.ts';
import { NOT_CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';
import { factProvenanceSlugSql } from '../facts/private-fact-pages.ts';
import { derivationPrivateSql, privateSnapshotFilterFragment } from '../search/private-visibility.ts';
import type { FactAttribution } from '../engine.ts';
import type { UnfencedFactRow } from '../facts/unfenced-facts.ts';
import type { FactPreimage } from '../generations/adapters/fact-rows.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Loop fact retirement (src/core/persistence/loop-fact-retirement.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface LoopFactDriftRow { loop_id: number; source_id: string; fact_id: number; status: string; slug: string | null }

/** Closed loops whose commitment fact is still active and retirable (same source, no other open loop references it), in id order. */
export async function loopFactDrift(raw: EngineRawRead, sourceIds: string[], loopId: number | null): Promise<LoopFactDriftRow[]> {
  return raw<LoopFactDriftRow>(
    `SELECT l.id AS loop_id, l.source_id, l.fact_id, l.status, f.source_markdown_slug AS slug
       FROM open_loops l JOIN facts f ON f.id=l.fact_id AND f.source_id=l.source_id
      WHERE l.source_id=ANY($1::text[]) AND l.status IN ('done','dropped') AND f.expired_at IS NULL
        AND ($2::bigint IS NULL OR l.id=$2::bigint)
        AND NOT EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=l.fact_id AND o.status='open')
      ORDER BY l.id`, [sourceIds, loopId]);
}

export interface ClosedLoopRow { id: number; status: string; fact_id: number }

/** A loop already closed whose commitment fact is still active (the retry path of `loops_close`); `sourceId` null is unscoped. */
export async function closedLoopWithActiveFact(raw: EngineRawRead, sourceId: string | null, loopId: number): Promise<ClosedLoopRow | null> {
  const [row] = await raw<ClosedLoopRow>(
    `SELECT l.id, l.status, l.fact_id FROM open_loops l JOIN facts f ON f.id=l.fact_id
      WHERE l.id=$1 AND ($2::text IS NULL OR l.source_id=$2) AND l.status IN ('done','dropped') AND f.expired_at IS NULL`, [loopId, sourceId]);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// agent-session-facts (src/core/repair/agent-session-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface SessionFactRow {
  id: number | string; source_id: string; source_session: string | null; fact: string; visibility: string; entity_slug: string | null;
  row_num: number | null; source_markdown_slug: string | null; attributed_to: string | null; context: string | null;
}

/** Active, unsuperseded facts of the capture `lanes` in these sources whose attribution is the user or unset, optionally only `ids`, in (source, id) order. */
export async function listSessionFactsForClassification(raw: EngineRawRead, sourceIds: string[], lanes: string[], ids: number[] | null): Promise<SessionFactRow[]> {
  return raw<SessionFactRow>(`
    SELECT f.id, f.source_id, f.source_session, f.fact, f.visibility, f.entity_slug, f.row_num, f.source_markdown_slug, f.attributed_to, f.context
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.source=ANY($2::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
       AND (f.attributed_to IS NULL OR f.attributed_to='user') AND ($3::bigint[] IS NULL OR f.id=ANY($3::bigint[]))
     ORDER BY f.source_id COLLATE "C", f.id`, [sourceIds, lanes, ids]);
}

export interface SessionFactTwinRow { id: number | string; owner_twin: boolean; twin_sessions: Array<string | null> | null }

/** For each fact in `ids`: whether an owner twin exists outside the capture `lanes`, and the sessions of its capture-lane twins. */
export async function listSessionFactTwins(raw: EngineRawRead, ids: number[], lanes: string[]): Promise<SessionFactTwinRow[]> {
  return raw<SessionFactTwinRow>(`
    SELECT f.id,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id=f.source_id AND a.visibility IN ('private','world') AND gbrain_fact_fingerprint(a.fact)=gbrain_fact_fingerprint(f.fact)
             AND a.id<>f.id AND a.expired_at IS NULL AND a.superseded_by IS NULL AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug
             AND (a.attributed_to IS NULL OR a.attributed_to='user') AND COALESCE(a.source,'') <> ALL($2::text[])) AS owner_twin,
           ARRAY(SELECT DISTINCT COALESCE(a.source_session,'') FROM facts a WHERE a.source_id=f.source_id AND a.visibility IN ('private','world')
             AND gbrain_fact_fingerprint(a.fact)=gbrain_fact_fingerprint(f.fact) AND a.id<>f.id AND a.expired_at IS NULL AND a.superseded_by IS NULL
             AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug AND (a.attributed_to IS NULL OR a.attributed_to='user') AND a.source=ANY($2::text[])) AS twin_sessions
      FROM facts f
     WHERE f.id=ANY($1::bigint[])`, [ids, lanes]);
}

// ---------------------------------------------------------------------------------------------------------------------
// captured-facts (src/core/repair/captured-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface CapturedFactRow {
  id: number | string; source_id: string; source: string; source_session: string | null; fact: string; visibility: string;
  entity_slug: string | null; row_num: number | null; source_markdown_slug: string | null; fingerprint: string; legit_twin: boolean;
}

/** Active, unsuperseded capture-lane facts of these sources with their fingerprint and whether a legitimate (other-lane) twin exists, in (source, id) order. */
export async function listCapturedFactsForClassification(raw: EngineRawRead, sourceIds: string[], lanes: string[], ids: number[] | null): Promise<CapturedFactRow[]> {
  return raw<CapturedFactRow>(`
    SELECT f.id, f.source_id, f.source, f.source_session, f.fact, f.visibility, f.entity_slug, f.row_num, f.source_markdown_slug,
           gbrain_fact_fingerprint(f.fact) AS fingerprint,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id=f.source_id AND a.id<>f.id AND a.expired_at IS NULL
             AND a.visibility=f.visibility AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug
             AND gbrain_fact_fingerprint(a.fact)=gbrain_fact_fingerprint(f.fact)
             AND COALESCE(a.source,'') <> ALL($2::text[])) AS legit_twin
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.source=ANY($2::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
       AND ($3::bigint[] IS NULL OR f.id=ANY($3::bigint[]))
     ORDER BY f.source_id COLLATE "C", f.id`, [sourceIds, lanes, ids]);
}

// ---------------------------------------------------------------------------------------------------------------------
// conversation-labels (src/core/repair/conversation-labels.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The constants the label count binds; the caller owns them (repair/conversation-labels.ts). */
export interface LabelFactCountArgs {
  /** The segment extractor's source (`f.source = $2`). */
  segmentSource: string;
  /** The `LIKE` pattern of the default epoch-segment context (`f.context LIKE $3`). */
  contextLike: string;
  /** The metadata label line regular expression (`~* $4`). */
  labelLine: string;
  /** The two audit sources whose active stamped row marks a page as already decided. */
  terminalSource: string;
  nonExtractableSource: string;
}

/** The bounded count of the default (evidenced) set of label facts: the classification's exclusions applied in SQL, capped at `cap`. */
export async function countLabelFacts(raw: EngineRawRead, sourceIds: string[], cap: number, args: LabelFactCountArgs): Promise<{ count: number; capped: boolean }> {
  const rows = await raw<{ id: number }>(`SELECT f.id FROM facts f
      JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
     WHERE f.source_id=ANY($1::text[]) AND f.source LIKE 'cli:extract-conversation-facts%' AND f.source=$2 AND f.expired_at IS NULL
       AND f.context LIKE $3 AND (p.compiled_truth ~* $4 OR COALESCE(p.timeline,'') ~* $4)
       AND NOT EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=f.source_markdown_slug
         AND o.source IN ($6, $7) AND o.expired_at IS NULL AND o.context ~ 'extractor_version=[0-9]+$')
       AND f.superseded_by IS NULL AND NOT EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)
       AND NOT EXISTS (SELECT 1 FROM open_loops l WHERE l.fact_id=f.id)
       AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
         AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact)) AND (w.subject='*' OR w.subject=f.entity_slug))
     LIMIT $5`, [sourceIds, args.segmentSource, args.contextLike, args.labelLine, cap + 1, args.terminalSource, args.nonExtractableSource]);
  return { count: Math.min(rows.length, cap), capped: rows.length > cap };
}

// ---------------------------------------------------------------------------------------------------------------------
// extractor-facts (src/core/repair/extractor-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The source prefix of conversation-extractor facts. */
export const EXTRACTOR_FACTS_SOURCE_PREFIX = 'cli:extract-conversation-facts';

/** The exact instant as text (UTC, microseconds); compared as text, as a bound timestamp can lose its microseconds. */
const expiryTextSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ExtractorFactRow {
  id: number | string; source_id: string; slug: string; fact: string; visibility: string; entity_slug: string | null;
  superseded: boolean; expired_at: string; page_id: number | string | null; page_deleted: boolean | null;
  withdrawn: boolean; active_duplicate: boolean; fence_history: boolean; fingerprint: string;
  receipt: string | null; receipt_consumer: string | null;
}

/** Expired fenceless extractor facts of these sources (or of one page) with the page, withdrawal, duplicate, fence and receipt evidence, in (source, page, id) order. */
export async function listExtractorFactsForClassification(raw: EngineRawRead, sourceIds: string[], slug: string | null): Promise<ExtractorFactRow[]> {
  // The receipts CTE order never reaches output: DISTINCT ON picks by completed_at and sequence, and the outer ORDER BY below is what callers see.
  const { text, params } = renderFragment(sqlFragment`
    WITH cand AS (
      SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.fact, f.visibility, f.entity_slug, f.expired_at AS expired,
             f.superseded_by IS NOT NULL AS superseded, gbrain_fact_fingerprint(f.fact) AS fingerprint
        FROM facts f
       WHERE f.source_id=ANY(${sourceIds}::text[]) AND f.source LIKE '${trustedSql(EXTRACTOR_FACTS_SOURCE_PREFIX)}%'
         AND f.expired_at IS NOT NULL AND f.row_num IS NULL AND f.source_markdown_slug IS NOT NULL
         AND COALESCE(f.context, '') NOT LIKE '%retired: conversation-labels%'
         AND (${slug}::text IS NULL OR f.source_markdown_slug=${slug}::text)
    ), receipts AS (
      SELECT DISTINCT ON (r.source_id, r.slug, r.completed_at) r.source_id, r.slug, r.completed_at,
             r.request_id::text AS request_id, r.consumer_version
        FROM persistence_requests r
        JOIN (SELECT DISTINCT source_id, slug, expired FROM cand) k
          ON k.source_id=r.source_id AND k.slug=r.slug AND k.expired=r.completed_at
       WHERE r.state='committed'
       ORDER BY r.source_id, r.slug, r.completed_at, r.sequence
    ), fenced AS (
      SELECT DISTINCT g.source_id, g.source_markdown_slug AS slug FROM facts g
        JOIN (SELECT DISTINCT source_id, slug FROM cand) k ON k.source_id=g.source_id AND k.slug=g.source_markdown_slug
       WHERE COALESCE(g.source,'') NOT LIKE '${trustedSql(EXTRACTOR_FACTS_SOURCE_PREFIX)}%'
    )
    SELECT c.id, c.source_id, c.slug, c.fact, c.visibility, c.entity_slug, c.superseded, c.fingerprint,
           ${trustedSql(expiryTextSql('c.expired'))} AS expired_at,
           p.id AS page_id, p.deleted_at IS NOT NULL AS page_deleted,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=c.source_id AND w.visibility=c.visibility
             AND w.fact_hash IN (gbrain_fact_fingerprint(c.fact), gbrain_fact_fingerprint_v2(c.fact), gbrain_fact_fingerprint_v1(c.fact))
             AND (w.subject='*' OR w.subject=c.entity_slug)) AS withdrawn,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id=c.source_id AND a.visibility=c.visibility
             AND gbrain_fact_fingerprint(a.fact)=c.fingerprint AND a.source_markdown_slug=c.slug AND a.expired_at IS NULL
             AND a.entity_slug IS NOT DISTINCT FROM c.entity_slug) AS active_duplicate,
           fenced.slug IS NOT NULL AS fence_history,
           r.request_id AS receipt, r.consumer_version AS receipt_consumer
      FROM cand c
      LEFT JOIN pages p ON p.source_id=c.source_id AND p.slug=c.slug
      LEFT JOIN receipts r ON r.source_id=c.source_id AND r.slug=c.slug AND r.completed_at=c.expired
      LEFT JOIN fenced ON fenced.source_id=c.source_id AND fenced.slug=c.slug
     ORDER BY c.source_id COLLATE "C", c.slug COLLATE "C", c.id`);
  return raw<ExtractorFactRow>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// purged-page-facts (src/core/repair/purged-page-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The gone page's slug: the head of the fact's context. */
export const PURGED_HEAD_SQL = contextHeadSql('f');
/** The page-extraction sources as a SQL list. */
export const PURGED_SOURCES_SQL = PAGE_EXTRACTION_SOURCE_LIST.map(s => `'${s}'`).join(', ');
/** The page purge ledger records the slug after the fact was written. */
export const PURGED_PAGE_SQL = `EXISTS (SELECT 1 FROM page_purges pp WHERE pp.source_id = f.source_id AND pp.slug = ${PURGED_HEAD_SQL} AND pp.purged_at >= f.created_at)`;
/** The exclusion predicates over alias f; constant text with no input. */
export const PURGED_EXCLUDED_SQL = {
  withdrawn: `EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
    AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact)) AND (w.subject = '*' OR w.subject = f.entity_slug))`,
  superseded: 'f.superseded_by IS NOT NULL',
  referenced: 'EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by = f.id)',
  open_loop: 'EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id = f.id)',
} as const;

/**
 * Doctor's bounded count of the retirable candidates by class, capped at `cap`. The facts whose page is gone are found
 * first, so the purge-record and exclusion checks run only on those, never on every active fact of a healthy brain.
 */
export async function countPurgedPageFacts(raw: EngineRawRead, sourceIds: string[], cap: number): Promise<{ evidenced: number; ambiguous: number; capped: boolean }> {
  const HEAD = PURGED_HEAD_SQL;
  const { text, params } = renderFragment(sqlFragment`WITH f AS MATERIALIZED (
    SELECT f.id, f.source_id, f.fact, f.context, f.entity_slug, f.visibility, f.superseded_by, f.created_at FROM facts f
     WHERE f.source_id = ANY(${sourceIds}::text[]) AND f.expired_at IS NULL AND f.source_markdown_slug IS NULL AND f.source = ANY(${PAGE_EXTRACTION_SOURCE_LIST}::text[])
       AND ${trustedSql(HEAD)} <> '' AND ${trustedSql(HEAD)} !~ '[[:space:]]' AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = ${trustedSql(HEAD)}))
    SELECT ${trustedSql(PURGED_PAGE_SQL)} AS purged FROM f WHERE (strpos(${trustedSql(HEAD)}, '/') > 0 OR ${trustedSql(PURGED_PAGE_SQL)})
      AND NOT (${trustedSql(PURGED_EXCLUDED_SQL.withdrawn)} OR ${trustedSql(PURGED_EXCLUDED_SQL.superseded)} OR ${trustedSql(PURGED_EXCLUDED_SQL.referenced)} OR ${trustedSql(PURGED_EXCLUDED_SQL.open_loop)})
    LIMIT ${cap + 1}`);
  const rows = await raw<{ purged: boolean }>(text, params);
  const kept = rows.slice(0, cap);
  return { evidenced: kept.filter(r => r.purged).length, ambiguous: kept.filter(r => !r.purged).length, capped: rows.length > cap };
}

// ---------------------------------------------------------------------------------------------------------------------
// unwithdrawn-facts (src/core/repair/unwithdrawn-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

const instantTextSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface UnwithdrawnFactRow {
  id: number | string; source_id: string; slug: string; fact: string; visibility: string; entity_slug: string | null; attributed_to: FactAttribution | null; superseded: boolean;
  generation_id: number | string; generation: number | string; retired_at: string; expired_at: string; preimage: FactPreimage;
  page_id: number | string | null; page_deleted: boolean | null; history_gap: boolean | null; withdrawn: boolean; active_duplicate: boolean; fingerprint: string;
}

/** Facts a facts-fence generation retired that no withdrawal covers, in (source, page) byte order, then id; `fenceKind` is the generation kind (generations/fence.ts FACT_FENCE_KIND). */
export async function listUnwithdrawnFacts(raw: EngineRawRead, sourceIds: string[], slug: string | null, fenceKind: string): Promise<UnwithdrawnFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`
    WITH retired AS (
      SELECT DISTINCT ON ((i.preimage->>'id')::bigint) (i.preimage->>'id')::bigint AS fact_id, g.id AS generation_id, g.generation, g.source_id,
             substr(g.owner_key, 6) AS slug, ${trustedSql(instantTextSql('g.created_at'))} AS retired_at, i.preimage
        FROM derived_generation_items i JOIN derived_generations g ON g.id = i.generation_id
       WHERE g.kind = ${fenceKind} AND g.source_id = ANY(${sourceIds}::text[]) AND g.state <> 'held' AND i.action = 'retired' AND left(g.owner_key, 5) = 'page:'
         AND jsonb_typeof(i.preimage) = 'object' AND i.preimage ? 'id' AND i.preimage->>'expired_at' IS NULL AND i.preimage->>'row_num' IS NOT NULL
         AND (${slug}::text IS NULL OR g.owner_key = 'page:' || ${slug}::text)
       ORDER BY (i.preimage->>'id')::bigint, g.id DESC
    )
    SELECT f.id, r.source_id, r.slug, f.fact, f.visibility, f.entity_slug, f.attributed_to, f.superseded_by IS NOT NULL AS superseded, r.generation_id, r.generation,
           r.retired_at, ${trustedSql(instantTextSql('f.expired_at'))} AS expired_at, r.preimage, gbrain_fact_fingerprint(f.fact) AS fingerprint,
           p.id AS page_id, p.deleted_at IS NOT NULL AS page_deleted, p.version_history_gap_at IS NOT NULL AS history_gap,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact))
             AND ${trustedSql(withdrawalCoversFactSql('w', 'f'))}) AS withdrawn,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id = f.source_id AND a.source_markdown_slug = r.slug
             AND a.expired_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
             AND gbrain_fact_fingerprint(a.fact) = gbrain_fact_fingerprint(f.fact) AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug
             AND (a.attributed_to IS NULL OR f.attributed_to IS NULL OR a.attributed_to = f.attributed_to)) AS active_duplicate
      FROM retired r
      JOIN facts f ON f.id = r.fact_id AND f.source_id = r.source_id
      LEFT JOIN pages p ON p.source_id = r.source_id AND p.slug = r.slug
     WHERE f.expired_at IS NOT NULL AND f.row_num IS NULL AND f.fact = r.preimage->>'fact' AND f.visibility = r.preimage->>'visibility'
       AND COALESCE(f.source, '') NOT LIKE 'cli:extract-conversation-facts%'
     ORDER BY r.source_id COLLATE "C", r.slug COLLATE "C", f.id`);
  return raw<UnwithdrawnFactRow>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// visibility (src/core/repair/visibility.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface WorldFactFromPrivateSourceRow { id: number; source_id: string; row_num: number | null; source_markdown_slug: string | null; entity_slug: string | null; readable: boolean }

/**
 * Active `world` facts held in, or extracted from, a page that is private by its `visibility`, its declared lineage or a
 * privacy alias. `readable` says a remote caller can recall the row today: its holding page does not hide it through the
 * provenance filter.
 */
export async function listWorldFactsFromPrivateSources(raw: EngineRawRead, sourceIds: string[], ids: number[] | null): Promise<WorldFactFromPrivateSourceRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.id,f.source_id,f.row_num,f.source_markdown_slug,f.entity_slug,
      (f.source_markdown_slug IS NULL OR h.id IS NULL OR ${trustedSql(privateSnapshotFilterFragment('h'))}) AS readable
    FROM facts f
      LEFT JOIN pages h ON h.source_id=f.source_id AND h.slug=f.source_markdown_slug
      LEFT JOIN pages o ON o.source_id=f.source_id AND o.slug=${trustedSql(factProvenanceSlugSql('f'))} AND o.deleted_at IS NULL
    WHERE f.visibility='world' AND f.expired_at IS NULL AND f.source_id=ANY(${sourceIds}::text[]) AND (${ids}::bigint[] IS NULL OR f.id=ANY(${ids}::bigint[]))
      AND ((h.id IS NOT NULL AND h.deleted_at IS NULL AND ${trustedSql(derivationPrivateSql('h'))}) OR (o.id IS NOT NULL AND ${trustedSql(derivationPrivateSql('o'))}))
    ORDER BY f.id`);
  return raw<WorldFactFromPrivateSourceRow>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// Repair previews: consolidate-ties, facts-rehome, ontology-facts and duplicate-facts (src/core/repair/*.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface ClosedTieRow {
  source_id: string; id: number | string; entity_slug: string; take_id: number | string; valid_from: string;
  partners: Array<number | string> | null;
}

/** Every active typed fact the pre-#6023 consolidation writeback closed at its own instant, with the facts of its take that state the same claim then (`partners`, null for none), in (source, id) order. */
export async function listClosedConsolidationTies(raw: EngineRawRead, sourceIds: string[]): Promise<ClosedTieRow[]> {
  return raw<ClosedTieRow>(`
    SELECT f.source_id, f.id, f.entity_slug, f.consolidated_into AS take_id, f.valid_from::text AS valid_from,
           (SELECT array_agg(g.id ORDER BY g.id) FROM facts g
             WHERE g.source_id = f.source_id AND g.id <> f.id AND g.consolidated_into = f.consolidated_into
               AND g.claim_metric = f.claim_metric AND g.claim_unit IS NOT DISTINCT FROM f.claim_unit
               AND g.claim_period IS NOT DISTINCT FROM f.claim_period AND g.valid_from = f.valid_from) AS partners
      FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.claim_metric IS NOT NULL
       AND f.consolidated_into IS NOT NULL AND f.valid_until = f.valid_from AND f.entity_slug IS NOT NULL
     ORDER BY f.source_id COLLATE "C", f.id`, [sourceIds]);
}

export interface PagelessEntityRow { source_id: string; slug: string; ids: Array<number | string> | null; fenced: number | string }

/** Every `entity_slug` of these sources that no live page answers for, with its database-only fact ids (null for none) and its fenced fact count, in (source, slug) order. */
export async function listPagelessEntityFacts(raw: EngineRawRead, sourceIds: string[]): Promise<PagelessEntityRow[]> {
  return raw<PagelessEntityRow>(`
    SELECT f.source_id, f.entity_slug AS slug,
           array_agg(f.id ORDER BY f.id) FILTER (WHERE f.row_num IS NULL) AS ids,
           count(*) FILTER (WHERE f.row_num IS NOT NULL) AS fenced
      FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.entity_slug IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     GROUP BY f.source_id, f.entity_slug
     ORDER BY f.source_id COLLATE "C", f.entity_slug COLLATE "C"`, [sourceIds]);
}

/** The expiry instant as UTC text with microseconds; a bound timestamp parameter can lose them. */
export const EXPIRY_TEXT = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** An observation with the same dedup key as `f` once its provenance is restored (the ontology unique index). */
export const DUPLICATE_SQL = (f: string) => `EXISTS (SELECT 1 FROM facts d WHERE d.source_id=${f}.source_id AND d.entity_slug=${f}.entity_slug
  AND d.dimension=${f}.dimension AND d.value_hash=${f}.value_hash AND d.source_markdown_slug=${f}.source
  AND d.valid_from=${f}.valid_from AND d.id<>${f}.id)`;

export interface OntologyCandidateRow {
  id: number | string; source_id: string; entity_slug: string; dimension: string; source: string; page: string | null;
  row_num: number | string | null; expired_at: string | null; withdrawn: boolean; consolidated: boolean; duplicate: boolean;
}

/** Ontology rows of these sources that carry the fence step's signature (a fence row number or a provenance other than `source`), with whether a withdrawal covers each, whether it was consolidated and whether restoring it would duplicate an observation, in id order. Reads fact_withdrawals. */
export async function listOntologyFactCandidates(raw: EngineRawRead, sourceIds: string[]): Promise<OntologyCandidateRow[]> {
  const { text, params } = renderFragment(sqlFragment`
    SELECT f.id, f.source_id, f.entity_slug, f.dimension, f.source, f.source_markdown_slug AS page, f.row_num,
           ${trustedSql(expiryTextSql('f.expired_at'))} AS expired_at,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
             AND (w.subject='*' OR w.subject=f.entity_slug)
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact))) AS withdrawn,
           f.consolidated_into IS NOT NULL AS consolidated,
           ${trustedSql(DUPLICATE_SQL('f'))} AS duplicate
      FROM facts f
     WHERE f.source_id=ANY(${sourceIds}::text[]) AND f.dimension IS NOT NULL AND f.entity_slug IS NOT NULL AND f.source IS NOT NULL
       AND (f.row_num IS NOT NULL OR f.source_markdown_slug IS DISTINCT FROM f.source) AND ${trustedSql(NOT_CONVERSATION_SLOT_SQL)}
     ORDER BY f.id`);
  return raw<OntologyCandidateRow>(text, params);
}

export interface DuplicateFactRow {
  id: number | string; source_id: string; visibility: string; fp: string; fact: string; entity_slug: string | null;
  fenced: boolean; row_num: number | string | null; source_markdown_slug: string | null; speaker: string;
}

/** The active, unexpired, valid, unsuperseded facts of these sources (less the audit sources `excludedSources`) that share a source, visibility, speaker and fingerprint with another such fact, in (source, visibility, fingerprint, speaker, fenced first, created_at, id) order. */
export async function listDuplicateFactRows(raw: EngineRawRead, sourceIds: string[], excludedSources: string[]): Promise<DuplicateFactRow[]> {
  // The statement's `SELECT *` also returns `created_at` (the order) and `n` (the filter); the row keeps the columns its caller reads.
  const rows = await raw<DuplicateFactRow>(`
    SELECT * FROM (
      SELECT f.id, f.source_id, f.visibility, gbrain_fact_fingerprint(f.fact) AS fp, f.fact, f.entity_slug, f.row_num, f.source_markdown_slug, f.created_at,
             COALESCE(f.attributed_to, '') AS speaker,
             (f.row_num IS NOT NULL AND f.source_markdown_slug IS NOT NULL AND COALESCE(f.source, '') NOT LIKE 'cli:%') AS fenced,
             count(*) OVER (PARTITION BY f.source_id, f.visibility, COALESCE(f.attributed_to, ''), gbrain_fact_fingerprint(f.fact)) AS n
        FROM facts f
       WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
         AND f.superseded_by IS NULL AND COALESCE(f.source, '') <> ALL($2::text[])
    ) d WHERE d.n > 1
    ORDER BY d.source_id COLLATE "C", d.visibility COLLATE "C", d.fp COLLATE "C", d.speaker COLLATE "C", d.fenced DESC, d.created_at, d.id`, [sourceIds, excludedSources]);
  return rows.map(r => ({ id: r.id, source_id: r.source_id, visibility: r.visibility, fp: r.fp, fact: r.fact, entity_slug: r.entity_slug, fenced: r.fenced,
    row_num: r.row_num, source_markdown_slug: r.source_markdown_slug, speaker: r.speaker }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Repair previews: fact-claim-dates, url-clone-fences and purged-page-facts (src/core/repair/*.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface FactClaimDayRow {
  id: number | string; entity_slug: string | null; fact: string; row_num: number | string | null; source_markdown_slug: string | null;
  valid_from: string; valid_until_day: string | null;
}

/** The active facts of a source whose `valid_from` falls on the UTC day `day` (`YYYY-MM-DD`), in id order. Backs `gbrain repair fact-claim-dates`' preview. */
export async function listFactsOnValidDay(raw: EngineRawRead, sourceId: string, day: string): Promise<FactClaimDayRow[]> {
  return raw<FactClaimDayRow>(`SELECT f.id, f.entity_slug, f.fact, f.row_num, f.source_markdown_slug, f.valid_from::text AS valid_from,
        to_char(f.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS valid_until_day
      FROM facts f WHERE f.source_id = $1 AND f.expired_at IS NULL AND (f.valid_from AT TIME ZONE 'UTC')::date = $2::date ORDER BY f.id`, [sourceId, day]);
}

/** The live page of a source recorded at `path` (the lowest id), or null. Backs `gbrain repair url-clone-fences`' preview and its identity recheck. */
export async function readLivePageByPath(raw: EngineRawRead, sourceId: string, path: string): Promise<{ id: number | string; slug: string } | null> {
  const [row] = await raw<{ id: number | string; slug: string }>(
    'SELECT id, slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL ORDER BY id LIMIT 1', [sourceId, path]);
  return row ?? null;
}

export interface PurgedCandidateRow {
  id: number | string; source_id: string; slug: string; fact: string; context: string; entity_slug: string | null; visibility: string; source: string;
  withdrawn: boolean; superseded: boolean; referenced: boolean; open_loop: boolean; purged: boolean;
}

/** Every candidate fact of a purged page of these sources (or only these ids) with its exclusion flags and whether a purge record names its page, in (source, slug, id) order. Reads page_purges, fact_withdrawals and open_loops. */
export async function listPurgedPageFactCandidates(raw: EngineRawRead, sourceIds: string[], ids: number[] | null): Promise<PurgedCandidateRow[]> {
  const HEAD = PURGED_HEAD_SQL;
  const PURGED_SQL = PURGED_PAGE_SQL;
  const EXCLUDED_SQL = PURGED_EXCLUDED_SQL;
  const candidateWhere = sqlFragment`f.source_id = ANY(${sourceIds}::text[]) AND f.expired_at IS NULL AND f.source_markdown_slug IS NULL AND f.source = ANY(${[...PAGE_EXTRACTION_SOURCE_LIST]}::text[])
     AND ${trustedSql(HEAD)} <> '' AND ${trustedSql(HEAD)} !~ '[[:space:]]' AND (strpos(${trustedSql(HEAD)}, '/') > 0 OR ${trustedSql(PURGED_SQL)})
     AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = ${trustedSql(HEAD)})`;
  const { text, params } = renderFragment(sqlFragment`
    SELECT f.id, f.source_id, ${trustedSql(HEAD)} AS slug, f.fact, f.context, f.entity_slug, f.visibility, f.source,
           ${trustedSql(EXCLUDED_SQL.withdrawn)} AS withdrawn, ${trustedSql(EXCLUDED_SQL.superseded)} AS superseded, ${trustedSql(EXCLUDED_SQL.referenced)} AS referenced,
           ${trustedSql(EXCLUDED_SQL.open_loop)} AS open_loop, ${trustedSql(PURGED_SQL)} AS purged
      FROM facts f
     WHERE ${candidateWhere} AND (${ids}::bigint[] IS NULL OR f.id = ANY(${ids}::bigint[]))
     ORDER BY f.source_id, ${trustedSql(HEAD)}, f.id`);
  return raw<PurgedCandidateRow>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// facts-home (src/core/facts/facts-home.ts, src/core/persistence/prepared-maintenance.ts readFacts)
// ---------------------------------------------------------------------------------------------------------------------

export type FactsHomeCandidateRow = UnfencedFactRow & { dimension: string | null; page_deleted: boolean };

/** The active facts of a source with no fence position (ontology rows too), with whether the entity has a live and a deleted page, entity (no entity first) then id. Backs `gbrain repair facts-home`'s scan. */
export async function listFactsHomeCandidates(raw: EngineRawRead, sourceId: string): Promise<FactsHomeCandidateRow[]> {
  return raw<FactsHomeCandidateRow>(`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, f.dimension, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists,
    EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NOT NULL) AS page_deleted FROM facts f
    WHERE f.source_id=$1 AND f.row_num IS NULL AND f.expired_at IS NULL ORDER BY f.entity_slug COLLATE "C" NULLS FIRST, f.id`, [sourceId]);
}

export type HeldHomeRow = UnfencedFactRow & { held_since: string; old: boolean; from_slug: string };

/** The fence rows held on a holding page of the source that name an entity (not a holding slug), with whether the entity has a live page, when the row was written and whether that was over `days` days ago, entity then id. */
export async function listHeldHomeRows(raw: EngineRawRead, sourceId: string, days: number): Promise<HeldHomeRow[]> {
  return raw<HeldHomeRow>(`SELECT f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to, EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL) AS page_exists, f.source_markdown_slug AS from_slug,
      to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS held_since, f.created_at < now() - ($2 || ' days')::interval AS old
     FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = $1 AND (hp.slug = 'memory/unattributed' OR hp.slug LIKE '%/memory/unattributed')) AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
      AND f.entity_slug IS NOT NULL AND NOT (f.entity_slug = 'memory/unattributed' OR f.entity_slug LIKE '%/memory/unattributed') ORDER BY f.entity_slug COLLATE "C", f.id`, [sourceId, String(days)]);
}

/** The active fence rows of a source whose page is not live, with that page's slug, by id. */
export async function listOrphanedFenceRows(raw: EngineRawRead, sourceId: string): Promise<Array<{ id: number | string; slug: string }>> {
  return raw<{ id: number | string; slug: string }>(`SELECT f.id, f.source_markdown_slug AS slug FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
      AND f.expired_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL) ORDER BY f.id`, [sourceId]);
}

export interface FactSnapshotRow { id: number | string; value: Record<string, unknown> }

/** Whole fact rows of a source as comparable snapshots (`lock`: FOR UPDATE, inside a transaction), by id. */
export async function readFactSnapshots(raw: EngineRawRead, sourceId: string, ids: number[], lock: boolean): Promise<FactSnapshotRow[]> {
  return raw<FactSnapshotRow>(lock
    ? `SELECT f.id,jsonb_build_object(
      'source_id',f.source_id,'entity_slug',f.entity_slug,'source_markdown_slug',f.source_markdown_slug,'row_num',f.row_num,
      'fact',f.fact,'kind',f.kind,'visibility',f.visibility,'notability',f.notability,'context',f.context,
      'valid_from',f.valid_from,'valid_until',f.valid_until,'expired_at',f.expired_at,'superseded_by',f.superseded_by,
      'consolidated_at',f.consolidated_at,'consolidated_into',f.consolidated_into,
      'source',f.source,'source_session',f.source_session,'confidence',f.confidence,
      'claim_metric',f.claim_metric,'claim_value',f.claim_value,'claim_unit',f.claim_unit,'claim_period',f.claim_period,
      'event_type',f.event_type,'dimension',f.dimension,'value',f.value,'dim_status',f.dim_status,'attributed_to',f.attributed_to
    ) AS value FROM facts f
    WHERE f.source_id=$1 AND f.id=ANY($2::integer[]) ORDER BY f.id FOR UPDATE`
    : `SELECT f.id,jsonb_build_object(
      'source_id',f.source_id,'entity_slug',f.entity_slug,'source_markdown_slug',f.source_markdown_slug,'row_num',f.row_num,
      'fact',f.fact,'kind',f.kind,'visibility',f.visibility,'notability',f.notability,'context',f.context,
      'valid_from',f.valid_from,'valid_until',f.valid_until,'expired_at',f.expired_at,'superseded_by',f.superseded_by,
      'consolidated_at',f.consolidated_at,'consolidated_into',f.consolidated_into,
      'source',f.source,'source_session',f.source_session,'confidence',f.confidence,
      'claim_metric',f.claim_metric,'claim_value',f.claim_value,'claim_unit',f.claim_unit,'claim_period',f.claim_period,
      'event_type',f.event_type,'dimension',f.dimension,'value',f.value,'dim_status',f.dim_status,'attributed_to',f.attributed_to
    ) AS value FROM facts f
    WHERE f.source_id=$1 AND f.id=ANY($2::integer[]) ORDER BY f.id`, [sourceId, ids]);
}

// ---------------------------------------------------------------------------------------------------------------------
// visibility (src/core/repair/visibility.ts): the preview reads that carry no privacy predicate
// ---------------------------------------------------------------------------------------------------------------------

export interface VisibilityPageRow { id: number; source_id: string; slug: string; type: string; visibility: string | null; chars: number }

/** The live synthesized concepts of these sources (only `conceptIds` when given) with their stored visibility and size, by id. Backs `gbrain repair visibility`'s lineage class. */
export async function listConceptLineageRows(raw: EngineRawRead, sourceIds: string[], conceptIds: number[] | null, timeoutMs: number): Promise<VisibilityPageRow[]> {
  return raw<VisibilityPageRow>(`SELECT c.id,c.source_id,c.slug,c.type,c.frontmatter->>'visibility' AS visibility,
      length(c.compiled_truth) AS chars
    FROM pages c WHERE c.type='concept' AND c.frontmatter->>'synthesized_by' IS NOT NULL AND c.deleted_at IS NULL
      AND c.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR c.id=ANY($2::integer[])) ORDER BY c.id`, [sourceIds, conceptIds], { timeoutMs });
}

export interface ConceptInputRow { concept_id: number; atom_id: number; linked: boolean }

/** Each (concept, atom) input of these concepts: from a concept-provenance link (`linked`) or only from the atom's `concepts:` list. */
export async function listConceptInputRows(raw: EngineRawRead, conceptIds: number[], timeoutMs: number): Promise<ConceptInputRow[]> {
  return raw<ConceptInputRow>(`WITH c AS MATERIALIZED (
      SELECT id,source_id,regexp_replace(slug,'^concepts/','') AS name FROM pages WHERE id=ANY($1::integer[])),
    refs AS MATERIALIZED (
      SELECT a.id AS atom_id,a.source_id,regexp_replace(ref,'^.*/','') AS name FROM pages a
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.frontmatter->'concepts')='array' THEN a.frontmatter->'concepts' ELSE '[]'::jsonb END) ref
        WHERE a.type='atom' AND a.deleted_at IS NULL AND a.source_id IN (SELECT source_id FROM c)),
    members AS (
      SELECT l.from_page_id AS concept_id,l.to_page_id AS atom_id,true AS linked FROM links l
        JOIN c ON c.id=l.from_page_id JOIN pages a ON a.id=l.to_page_id AND a.source_id=c.source_id AND a.type='atom' AND a.deleted_at IS NULL
        WHERE l.link_source='concept-provenance' AND l.link_type='synthesized_from'
      UNION ALL
      SELECT c.id,r.atom_id,false FROM refs r JOIN c ON c.source_id=r.source_id AND c.name=r.name)
    SELECT concept_id,atom_id,bool_or(linked) AS linked FROM members GROUP BY concept_id,atom_id`, [conceptIds], { timeoutMs });
}

/** The live pages of these sources named by slug with their stored visibility, size and whether a label guard is raised, by id. Backs `gbrain repair visibility --slug`. */
export async function listNamedVisibilityRows(raw: EngineRawRead, sourceIds: string[], slugs: string[], timeoutMs: number): Promise<Array<VisibilityPageRow & { guarded: boolean }>> {
  return raw<VisibilityPageRow & { guarded: boolean }>(`SELECT p.id,p.source_id,p.slug,p.type,p.frontmatter->>'visibility' AS visibility,COALESCE(p.body_bytes, 0) AS chars,
      EXISTS (SELECT 1 FROM page_label_guards g WHERE g.page_id = p.id) AS guarded
    FROM pages p WHERE p.deleted_at IS NULL AND p.source_id=ANY($1::text[]) AND p.slug=ANY($2::text[]) ORDER BY p.id`, [sourceIds, slugs], { timeoutMs });
}

// ---------------------------------------------------------------------------------------------------------------------
// Repair command statements (src/core/repair/agent-session-facts.ts, captured-facts.ts, facts-rehome.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The ids of the sources that are not archived, in id order (the repair preview command names `--source` when more than one). */
export async function listActiveSourceIds(raw: EngineRawRead): Promise<Array<{ id: string }>> {
  return raw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id COLLATE "C"');
}

/** The brain id a repair preview hashes, or null when the brain has no `persistence_brain` row (the callers fall back to `host`). */
export async function readRepairBrainId(raw: EngineRawRead): Promise<string | null> {
  const [brain] = await raw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  return brain?.brain_id ?? null;
}

export interface AgentSessionTakeCandidateRow {
  id: number | string; source_id: string; slug: string; row_num: number | string; claim: string;
  fact_ids: Array<number | string>; user_fact_ids: Array<number | string>; noted: boolean;
}

/**
 * Active, unresolved `kind: fact` / `holder: self` takes of these sources with every fact consolidated into each, grouped in one
 * pass over the sources' facts (never one pass per take): `user_fact_ids` are the contributors attributed to the user or unset,
 * `noted` says a non-user contributor already carries `noteMark`. `ids` null is every take; the caller keeps the takes whose
 * user facts are all re-attributed.
 */
export async function listAgentSessionTakeCandidates(raw: EngineRawRead, sourceIds: string[], ids: number[] | null, noteMark: string): Promise<AgentSessionTakeCandidateRow[]> {
  return raw<AgentSessionTakeCandidateRow>(`
    WITH contributing AS (
      SELECT f.consolidated_into AS take_id, array_agg(f.id ORDER BY f.id) AS fact_ids,
             COALESCE(array_agg(f.id ORDER BY f.id) FILTER (WHERE f.attributed_to IS NULL OR f.attributed_to='user'), '{}'::bigint[]) AS user_fact_ids,
             COALESCE(bool_or(f.attributed_to='other' AND position($3::text in COALESCE(f.context,''))>0), false) AS noted,
             min(f.consolidated_at) AS first_consolidated_at
        FROM facts f
       WHERE f.source_id=ANY($1::text[]) AND f.consolidated_into IS NOT NULL AND ($2::bigint[] IS NULL OR f.consolidated_into=ANY($2::bigint[]))
       GROUP BY f.consolidated_into)
    SELECT t.id, p.source_id, p.slug, t.row_num, t.claim, c.fact_ids, c.user_fact_ids, c.noted
      FROM contributing c JOIN takes t ON t.id=c.take_id JOIN pages p ON p.id=t.page_id
     WHERE p.source_id=ANY($1::text[]) AND t.kind='fact' AND t.holder='self' AND t.active AND t.resolved_at IS NULL
       AND t.created_at >= c.first_consolidated_at - interval '1 second'
     ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C", t.id`, [sourceIds, ids, noteMark]);
}

/** The named facts of the source that already read back as `other` and unexpired, unsuperseded, with their context (a re-attribution that settled). */
export async function listSettledSessionFacts(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<Array<{ id: number | string; context: string | null }>> {
  return raw<{ id: number | string; context: string | null }>(
    "SELECT id, context FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND attributed_to='other' AND expired_at IS NULL AND superseded_by IS NULL", [sourceId, ids]);
}

/**
 * Re-attributes each named database-only fact still user-attributed and active to `other`, appending its note once after
 * `separator`; the checks run in the UPDATE, under the row locks. Returns the changed ids.
 */
export async function reattributeSessionFacts(raw: EngineRawRead, sourceId: string, facts: Array<{ id: number; note: string }>, separator: string): Promise<Array<{ id: number | string }>> {
  return raw<{ id: number | string }>(`UPDATE facts f
      SET attributed_to='other',
          context=CASE WHEN position(r.note in COALESCE(f.context,''))>0 THEN f.context ELSE concat_ws($3::text, NULLIF(f.context,''), r.note) END
     FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, note text)
    WHERE f.source_id=$1 AND f.id=r.id AND (f.attributed_to IS NULL OR f.attributed_to='user') AND f.expired_at IS NULL AND f.superseded_by IS NULL
      AND f.row_num IS NULL
    RETURNING f.id`, [sourceId, JSON.stringify(facts), separator]);
}

/**
 * Retires each named take still active, unresolved, `kind: fact` / `holder: self` on a page of the source whose every
 * contributing fact is non-user; the checks run in the UPDATE, under the row locks. Returns the retired ids.
 */
export async function retireSessionTakes(raw: EngineRawRead, sourceId: string, takeIds: number[]): Promise<Array<{ id: number | string }>> {
  return raw<{ id: number | string }>(`UPDATE takes t SET active=false, updated_at=now()
     FROM pages p
    WHERE p.id=t.page_id AND p.source_id=$1 AND t.id=ANY($2::bigint[]) AND t.active AND t.resolved_at IS NULL AND t.kind='fact' AND t.holder='self'
      AND t.created_at >= (SELECT min(f.consolidated_at) FROM facts f WHERE f.consolidated_into=t.id) - interval '1 second'
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.consolidated_into=t.id AND (f.attributed_to IS NULL OR f.attributed_to='user'))
    RETURNING t.id`, [sourceId, takeIds]);
}

/** The named unexpired facts of the source with the claim and fence row number a fenced rewrite matches against the page body. */
export async function listFenceRewriteRows(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<Array<{ id: number | string; fact: string; row_num: number }>> {
  return raw<{ id: number | string; fact: string; row_num: number }>(
    'SELECT id, fact, row_num FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL', [sourceId, ids]);
}

/** The named facts of the source attributed to `other` (the ones a fenced re-attribution reads back as done). */
export async function listOtherAttributedFactIds(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<Array<{ id: number | string }>> {
  return raw<{ id: number | string }>("SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND attributed_to='other'", [sourceId, ids]);
}

/** The named takes that read back inactive (the ones a fenced retirement struck). */
export async function listInactiveTakeIds(raw: EngineRawRead, ids: number[]): Promise<Array<{ id: number | string }>> {
  return raw<{ id: number | string }>('SELECT id FROM takes WHERE id=ANY($1::bigint[]) AND active=false', [ids]);
}

/** Expires each named active database-only fact of the source, putting `context` before its own; returns the expired ids. */
export async function expireCapturedFacts(raw: EngineRawRead, sourceId: string, ids: number[], context: string): Promise<Array<{ id: number | string }>> {
  return raw<{ id: number | string }>(`UPDATE facts
    SET expired_at=now(), context=concat_ws(' | ', $3::text, NULLIF(context,''))
  WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NULL AND row_num IS NULL RETURNING id`, [sourceId, ids, context]);
}

/** The named facts of the source that read back expired (the ones a fenced strike expired). */
export async function listExpiredFactIds(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<Array<{ id: number | string }>> {
  return raw<{ id: number | string }>('SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) AND expired_at IS NOT NULL', [sourceId, ids]);
}

/** The same row as `PagelessEntityRow` (main's name); `listPagelessEntityFacts` above serves both callers. */
export type PagelessEntityFactRow = PagelessEntityRow;

export interface EntityRehomeState { from_live: boolean; to_live: boolean; ids: Array<number | string> | null }

/** Whether the `from` and `to` pages are live in the source, and the database-only fact ids keyed under `from`, in id order; null when no row answers. */
export async function readEntityRehomeState(raw: EngineRawRead, sourceId: string, fromSlug: string, toSlug: string): Promise<EntityRehomeState | null> {
  const [state] = await raw<EntityRehomeState>(`
        SELECT EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL) AS from_live,
               EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $3 AND deleted_at IS NULL) AS to_live,
               (SELECT array_agg(id ORDER BY id) FROM facts WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL) AS ids`,
    [sourceId, fromSlug, toSlug]);
  return state ?? null;
}

/** Re-keys the database-only facts of the source from `fromSlug` to `toSlug`; fence-held facts stay. */
export async function rehomeEntityFacts(raw: EngineRawRead, sourceId: string, fromSlug: string, toSlug: string): Promise<void> {
  await raw('UPDATE facts SET entity_slug = $3 WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL', [sourceId, fromSlug, toSlug]);
}
