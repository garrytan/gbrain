/**
 * Group 5 facts statements, doctor checks (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved.
 *
 * Two statements splice shared SQL fragments that carry their own hand-numbered placeholders (`embedding-identity.ts`),
 * so the fragments pass through small wrapper builders (registered in scripts/check-engine-sql-dynamic.ts) and the
 * values are passed alongside, numbered as the shared fragments number them.
 */
import { holdAppliesToPageSql } from '../write-gate-binding.ts';
import { AUDIT_ROW_SOURCES, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE } from '../facts/audit-sources.ts';
import { ENTITY_LINKABLE_SQL } from '../facts/attribution.ts';
import { conversationPaidSql, conversationTriedSql } from '../facts/conversation-memo.ts';
import { eligibleFactEmbedding, partiallyEmbeddedFact, staleFactEmbedding } from '../facts/embedding-identity.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** A fact the conversation extractor derived from its page (fact alias `f`). */
const DERIVED = `f.source LIKE 'cli:extract-conversation-facts%'`;
const ORIGIN = `CASE WHEN ${DERIVED} THEN 'conversation' WHEN f.source = 'mcp:put_page' THEN 'mcp:put_page'
  WHEN f.source LIKE 'mcp:%' OR f.source LIKE 'sync:%' OR f.source LIKE 'hook:%' OR f.source IN ('file_upload', 'code_import') THEN 'extraction'
  ELSE 'remember' END`;
const INFERRED = `(f.context LIKE 'entity inferred from %' OR f.context LIKE '% — entity inferred from %')`;
const INFERRED_TIER = `substring(f.context from 'entity inferred from ([a-z]+)')`;

/** Wrapper builders over shared constant fragments (each is constant text, no values). */
/** The constant ENTITY_LINKABLE_SQL predicate (a vetted builder of check-engine-sql-dynamic; fact-relink-writes.ts shares it). */
export function entityLinkableSql(): string { return ENTITY_LINKABLE_SQL; }
/** The constant conversationTriedSql predicate, or `false` (a vetted builder; fact-relink-writes.ts shares it). */
export function relinkTriedSql(hasAttempts: boolean): string { return hasAttempts ? conversationTriedSql : 'false'; }
function relinkPaidSql(hasAttempts: boolean): string { return hasAttempts ? conversationPaidSql : 'false'; }
function staleFactEmbeddingSql(): string { return staleFactEmbedding; }
function partiallyEmbeddedFactSql(): string { return partiallyEmbeddedFact; }
function eligibleFactEmbeddingSql(): string { return eligibleFactEmbedding; }
/** The source scope of the embedding coverage statement: `$1` is the optional source id. */
function factSourceScopeSql(): string { return '($1::text IS NULL OR f.source_id = $1)'; }

/** The active, entity-linkable facts the unlinked-fact checks count (fact alias `f`); `audit` is the audit-row source list. */
function activeUnlinkedSql(audit: string[]): SqlFragment {
  return sqlFragment`f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source <> ALL(${audit}::text[]) AND ${trustedSql(entityLinkableSql())}`;
}

export interface ConversationFactRow { source_id: string; slug: string | null; context: string | null }

/** conversation_outcomes_stale: the newest unexpired extraction-outcome rows of the sources, newest id first, at most `limit`. */
export async function listConversationFactRows(raw: EngineRawRead, sourceIds: string[], limit: number): Promise<ConversationFactRow[]> {
  return raw<ConversationFactRow>(
    `SELECT source_id, source_markdown_slug AS slug, context FROM facts
        WHERE source_id = ANY($1::text[]) AND source LIKE 'cli:extract-conversation-facts%' AND source = ANY($2::text[]) AND expired_at IS NULL
        ORDER BY id DESC LIMIT $3`, [sourceIds, [TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE], limit]);
}

/** facts_redaction_marker: active facts holding a redaction marker, in live sources (only `sourceIds` when given). */
export async function countRedactedFacts(raw: EngineRawRead, sourceIds?: string[]): Promise<number> {
  const [row] = await raw<{ n: number | string }>(`SELECT count(*)::int AS n FROM facts f
      WHERE f.expired_at IS NULL AND f.superseded_by IS NULL AND f.fact LIKE '%[redacted%'
        AND f.source_id IN (SELECT id FROM sources WHERE archived IS NOT TRUE AND ($1::text[] IS NULL OR id=ANY($1::text[])))`, [sourceIds ?? null]);
  return Number(row?.n ?? 0);
}

export interface OutsideContentFenceRow { source_id: string; slug: string; type: string; facts: number; world_facts: number; takes: number; links: number }

/** outside_content_fences: per imported page whose body a third party wrote, the fact, take and link rows indexed from its fences. */
export async function listOutsideContentFenceCounts(raw: EngineRawRead): Promise<OutsideContentFenceRow[]> {
  return raw<OutsideContentFenceRow>(
    `SELECT p.source_id, p.slug, p.type, sum(x.facts)::int AS facts, sum(x.world_facts)::int AS world_facts,
              sum(x.takes)::int AS takes, sum(x.links)::int AS links
         FROM (SELECT fp.id AS page_id, 1 AS facts, CASE WHEN f.visibility = 'world' THEN 1 ELSE 0 END AS world_facts, 0 AS takes, 0 AS links
                 FROM facts f JOIN pages fp ON fp.source_id = f.source_id AND fp.slug = f.source_markdown_slug
                WHERE f.row_num IS NOT NULL AND f.expired_at IS NULL
               UNION ALL SELECT t.page_id, 0, 0, 1, 0 FROM takes t WHERE t.active
               UNION ALL SELECT l.origin_page_id, 0, 0, 0, 1 FROM links l WHERE l.origin_field = 'links_fence') x
         JOIN pages p ON p.id = x.page_id
         JOIN sources s ON s.id = p.source_id
        WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE
          AND ((s.config->>'kind' = 'google' AND p.type IN ('email', 'meeting')) OR s.config->>'kind' = 'github'
               OR p.frontmatter ? 'transcript_import')
        GROUP BY p.source_id, p.slug, p.type
        ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"`);
}

/** facts_health: unexpired facts that name an `atoms/` page (retired atom extraction), in every source. */
export async function countAtomFacts(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts
          WHERE expired_at IS NULL AND (source_markdown_slug LIKE 'atoms/%' OR context LIKE 'atoms/%')`);
  return Number(row?.n ?? 0);
}

export interface UnpreviewedTrustFactRow { id: number; source_id: string; slug: string; row_num: number; hold_id: number; total: number }

/** trust_release_unpreviewed_fields: current user_confirmed facts a trust release raised without previewing their fence fields, by id, at most `limit`. */
export async function listUnpreviewedTrustFacts(raw: EngineRawRead, limit: number): Promise<UnpreviewedTrustFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.row_num, h.id AS hold_id, COUNT(*) OVER () AS total
         FROM facts f JOIN LATERAL (SELECT id FROM write_gate_holds WHERE kind = 'fact' AND status = 'released' AND source_id = f.source_id
          AND ${trustedSql(holdAppliesToPageSql('write_gate_holds', '(SELECT pg.id FROM pages pg WHERE pg.source_id = f.source_id AND pg.slug = f.source_markdown_slug)', 'f.source_markdown_slug'))}
          AND payload->>'row_num' = f.row_num::text
          AND request_id::text IS NOT DISTINCT FROM f.write_origin->>'request_id' ORDER BY id DESC LIMIT 1) h ON true
        WHERE f.trust_tier = 'user_confirmed' AND f.expired_at IS NULL AND f.write_origin->>'channel' = 'trust_release'
          AND f.write_origin->>'fields_previewed' IS NULL
        ORDER BY f.id LIMIT ${limit}`);
  return raw<UnpreviewedTrustFactRow>(text, params);
}

export interface UnlinkedOriginRow {
  source_id: string; origin: string; active: number; unlinked: number; fence_owned: number;
  conversation: number; conversation_tried: number; conversation_paid: number;
}

/**
 * unlinked_facts: per source and origin, the counts over each source's newest `windowPerSource` active facts. `hasAttempts`:
 * the brain has `fact_relink_attempts`, so the conversation tried/paid memos count; without it both are false.
 */
export async function countUnlinkedFactsByOrigin(raw: EngineRawRead, opts: { sourceIds: string[]; auditSources: string[]; windowPerSource: number; hasAttempts: boolean }): Promise<UnlinkedOriginRow[]> {
  const tried = relinkTriedSql(opts.hasAttempts);
  const paid = relinkPaidSql(opts.hasAttempts);
  const { text, params } = renderFragment(sqlFragment`SELECT s.id AS source_id, w.origin, COUNT(*)::int AS active, COUNT(*) FILTER (WHERE w.unlinked)::int AS unlinked,
            COUNT(*) FILTER (WHERE w.unlinked AND w.fence_owned AND NOT w.derived)::int AS fence_owned,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived)::int AS conversation,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived AND w.tried)::int AS conversation_tried,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived AND w.tried AND w.paid)::int AS conversation_paid
       FROM unnest(${opts.sourceIds}::text[]) AS s(id) CROSS JOIN LATERAL (
         SELECT ${trustedSql(ORIGIN)} AS origin, f.entity_slug IS NULL AS unlinked, ${trustedSql(DERIVED)} AS derived,
                CASE WHEN f.entity_slug IS NULL AND ${trustedSql(DERIVED)} THEN ${trustedSql(tried)} ELSE false END AS tried,
                CASE WHEN f.entity_slug IS NULL AND ${trustedSql(DERIVED)} THEN ${trustedSql(paid)} ELSE false END AS paid,
                (f.row_num IS NOT NULL OR f.source_markdown_slug IS NOT NULL) AS fence_owned
           FROM facts f WHERE f.source_id = s.id AND ${activeUnlinkedSql(opts.auditSources)}
          ORDER BY f.created_at DESC LIMIT ${opts.windowPerSource}) w
      GROUP BY s.id, w.origin`);
  return raw<UnlinkedOriginRow>(text, params);
}

export interface UnlinkedFactStatsRow {
  facts: number; unlinked: number; no_subject: number; conversation_unresolved: number; inferred_page: number; inferred_mention: number;
}

/** unlinked_facts: the active facts created in the last 7 days, with the share without an entity and the write-time inference tiers. */
export async function countUnlinkedFactStats(raw: EngineRawRead, opts: { sourceIds: string[]; auditSources: string[]; hasAttempts: boolean }): Promise<UnlinkedFactStatsRow | null> {
  const judged = opts.hasAttempts
    ? `EXISTS (SELECT 1 FROM fact_relink_attempts a WHERE a.source_id = f.source_id AND a.fact_id = f.id AND a.outcome = 'no_subject')`
    : 'false';
  const tried = relinkTriedSql(opts.hasAttempts);
  const { text, params } = renderFragment(sqlFragment`SELECT COUNT(*)::int AS facts, COUNT(*) FILTER (WHERE f.entity_slug IS NULL)::int AS unlinked,
            COUNT(*) FILTER (WHERE f.entity_slug IS NULL AND ${trustedSql(judged)})::int AS no_subject,
            COUNT(*) FILTER (WHERE f.entity_slug IS NULL AND ${trustedSql(tried)})::int AS conversation_unresolved,
            COUNT(*) FILTER (WHERE ${trustedSql(INFERRED)} AND ${trustedSql(INFERRED_TIER)} = 'page')::int AS inferred_page,
            COUNT(*) FILTER (WHERE ${trustedSql(INFERRED)} AND ${trustedSql(INFERRED_TIER)} = 'mention')::int AS inferred_mention
       FROM facts f WHERE f.source_id = ANY(${opts.sourceIds}::text[]) AND f.created_at >= now() - interval '7 days' AND ${activeUnlinkedSql(opts.auditSources)}`);
  const [row] = await raw<UnlinkedFactStatsRow>(text, params);
  return row ?? null;
}

export interface FactRelinkOutcomeRow { outcome: string; tier: string | null; n: number }

/** unlinked_facts: the relink attempts' outcomes (every no_subject, and the linked ones of the last 7 days) by outcome and tier. */
export async function countFactRelinkOutcomes(raw: EngineRawRead, sourceIds: string[]): Promise<FactRelinkOutcomeRow[]> {
  return raw<FactRelinkOutcomeRow>(
    `SELECT outcome, tier, COUNT(*)::int AS n FROM fact_relink_attempts
        WHERE source_id = ANY($1::text[])
          AND (outcome = 'no_subject' OR (outcome = 'linked' AND attempted_at >= now() - interval '7 days'))
        GROUP BY outcome, tier`, [sourceIds]);
}

/** Which unlinked conversation rows the fix targets: free relink has not tried them, tried them, or tried them and a paid re-extraction ran. */
export type ConversationFixKind = 'relink' | 'reextract' | 'manual';

/** unlinked_facts: the pages holding the targeted unlinked conversation rows of one source, most rows first. */
export async function listUnlinkedConversationSlugs(raw: EngineRawRead, opts: { sourceId: string; auditSources: string[]; windowPerSource: number; fix: ConversationFixKind; hasAttempts: boolean }): Promise<Array<{ slug: string }>> {
  const tried = relinkTriedSql(opts.hasAttempts);
  const paid = relinkPaidSql(opts.hasAttempts);
  const hit = opts.fix === 'relink' ? sqlFragment`NOT ${trustedSql(tried)}`
    : opts.fix === 'reextract' ? sqlFragment`${trustedSql(tried)} AND NOT ${trustedSql(paid)}`
      : sqlFragment`${trustedSql(tried)} AND ${trustedSql(paid)}`;
  const { text, params } = renderFragment(sqlFragment`SELECT w.slug FROM (SELECT f.source_markdown_slug AS slug, f.entity_slug IS NULL AND ${trustedSql(DERIVED)} AND ${hit} AS hit
           FROM facts f WHERE f.source_id = ${opts.sourceId} AND ${activeUnlinkedSql(opts.auditSources)} ORDER BY f.created_at DESC LIMIT ${opts.windowPerSource}) w
        WHERE w.hit AND w.slug IS NOT NULL GROUP BY w.slug ORDER BY COUNT(*) DESC, w.slug COLLATE "C"`);
  return raw<{ slug: string }>(text, params);
}

export interface FactEmbeddingCoverageRow { source_id: string; missing: number; stale: number; partial: number }

/**
 * fact_take_vectors: per source, the embeddable facts with no vector (`missing`), with a vector not current for `model` and
 * `dims` or the fact text (`stale`, which includes missing), and the current ones too long for the embedder (`partial`).
 * `$1` is the optional source id, `$2` the audit sources, `$3` the model and `$4` the width, as the shared fragments number them.
 */
export async function countFactEmbeddingCoverage(raw: EngineRawRead, opts: { sourceId?: string | null; model: string; dims: number }): Promise<FactEmbeddingCoverageRow[]> {
  const stale = staleFactEmbeddingSql();
  const { text } = renderFragment(sqlFragment`SELECT f.source_id, count(*) FILTER (WHERE f.embedding IS NULL)::int AS missing,
              count(*) FILTER (WHERE ${trustedSql(stale)})::int AS stale,
              count(*) FILTER (WHERE NOT ${trustedSql(stale)} AND ${trustedSql(partiallyEmbeddedFactSql())})::int AS partial
         FROM facts f WHERE ${trustedSql(factSourceScopeSql())} AND ${trustedSql(eligibleFactEmbeddingSql())}
        GROUP BY f.source_id`);
  return raw<FactEmbeddingCoverageRow>(text, [opts.sourceId ?? null, [...AUDIT_ROW_SOURCES], opts.model, opts.dims]);
}

/**
 * The embeddable facts whose vector is not current for `model` and `dims` or the fact text (the `stale` rows of
 * countFactEmbeddingCoverage), over every source or `sourceId`, with the sum of their lengths in characters. Numbered as
 * the shared fragments number them: `$1` source, `$2` audit sources, `$3` model, `$4` width.
 */
export async function countStaleFactEmbeddings(raw: EngineRawRead, opts: { model: string; dims: number; sourceId?: string | null }): Promise<{ count: number; chars: number }> {
  const { text } = renderFragment(sqlFragment`SELECT count(*)::int AS count,
    COALESCE(sum(length(f.fact)),0)::text AS chars FROM facts f
    WHERE ${trustedSql(factSourceScopeSql())} AND ${trustedSql(eligibleFactEmbeddingSql())} AND ${trustedSql(staleFactEmbeddingSql())}`);
  const [row] = await raw<{ count: number; chars: string }>(text, [opts.sourceId ?? null, [...AUDIT_ROW_SOURCES], opts.model, opts.dims]);
  return { count: Number(row.count), chars: Number(row.chars) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Doctor check statements (commands/doctor/checks/fence-integrity.ts, facts-pages.ts, unlinked-facts.ts)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * fence_integrity: how many live markdown pages of `sourceIds` are stored in segments and have no checkout file walked (no
 * `source_path`, or a source outside `checkedOutSourceIds`): the census judges a stored page by its body columns, which are NULL
 * on such a page. Null when no row answers; the caller treats a refused read as none skipped.
 */
export async function countSegmentedCensusPages(raw: EngineRawRead, sourceIds: string[], checkedOutSourceIds: string[]): Promise<{ n: number } | null> {
  const [row] = await raw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages
    WHERE deleted_at IS NULL AND page_kind = 'markdown' AND body_storage = 'segmented' AND source_id = ANY($1::text[])
      AND (source_path IS NULL OR NOT (source_id = ANY($2::text[])))`, [sourceIds, checkedOutSourceIds]);
  return row ?? null;
}

export interface FactsPageBodyRow { slug: string; source_id: string; segmented: boolean; body: string | null }

/** facts_undated_lines: every live `type: facts` page with whether it is stored in segments and the bounded prefix of its body, by source and slug. */
export async function listFactsPageBodies(raw: EngineRawRead): Promise<FactsPageBodyRow[]> {
  const { text } = renderFragment(sqlFragment`SELECT p.slug, p.source_id, p.body_storage = 'segmented' AS segmented, ${trustedSql(boundedBodyPrefixSql('p'))} AS body
         FROM pages p WHERE p.type = 'facts' AND p.deleted_at IS NULL ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"`);
  return raw<FactsPageBodyRow>(text);
}

/** unlinked_facts: the `facts` and `fact_relink_attempts` table names the brain has (null for one it lacks), or null when no row answers. */
export async function readFactTableCatalog(raw: EngineRawRead): Promise<{ facts: string | null; attempts: string | null } | null> {
  const [tables] = await raw<{ facts: string | null; attempts: string | null }>(
    `SELECT to_regclass('facts')::text AS facts, to_regclass('fact_relink_attempts')::text AS attempts`);
  return tables ?? null;
}
