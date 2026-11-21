/**
 * Group 5 facts statements, purge, withdrawal, relink and fence repair (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved. A statement that spliced a vetted builder next to hand-numbered
 * placeholders is written with `sqlFragment`, which numbers them itself; the SQL it renders is the same predicate.
 */
import { FACTS_FENCE_BEGIN } from '../facts-fence.ts';
import { outcomeMarkerSql } from '../facts/audit-sources.ts';
import { ownedMemorySubjectSql, unbackedEntitySql } from '../facts/withdrawal-schema.ts';
import { onOwnedMemoryPageSql } from '../access/member-facts.ts';
import { privateProvenanceFilterUnderPolicy, remoteProvenanceFloorSql } from '../search/private-visibility.ts';
import type { FactAttribution, FactRow } from '../engine.ts';
import type { FenceRowInput, UnfencedFactRow } from '../facts/unfenced-facts.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';
export type { UnfencedFactRow } from '../facts/unfenced-facts.ts';

/** `p` is due: no reconcile row, or one for another revision (facts/reconcile-watermark.ts reads it too). */
export const DUE = `(r.page_id IS NULL OR r.reconciled_revision IS DISTINCT FROM p.knowledge_revision)`;
/** `p` owns fence rows in `facts`. */
export const OWNS_FENCE_ROWS = `EXISTS (SELECT 1 FROM facts f
  WHERE f.source_id = p.source_id AND f.source_markdown_slug = p.slug AND f.row_num IS NOT NULL)`;

/** The one-row subject relation the withdrawal statements read, so `ownedMemorySubjectSql` has a column to test. */
const subjectOf = (subject: string) => sqlFragment`(SELECT ${subject}::text AS subject) q`;

export interface PurgeTargetRow {
  id: number; source_id: string; visibility: 'private' | 'world'; fact: string; entity_slug: string | null;
  source_markdown_slug: string | null; fact_hash: string; embedding: string | null; embedding_model: string | null;
}

/** verifyFactPurge: the rows of the claim's fingerprint the purge's scope leaves, outcome markers apart. */
export async function countFactFingerprintLeftovers(raw: EngineRawRead, sourceId: string, factHash: string, visibility: string, subject: string): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM facts WHERE source_id=${sourceId} AND gbrain_fact_fingerprint(fact)=${factHash}
    AND NOT (visibility=${visibility} AND (${subject}::text='*' OR entity_slug=${subject}::text)) AND NOT ${trustedSql(outcomeMarkerSql('facts'))}`);
  const [other] = await raw<{ n: number }>(text, params);
  return Number(other?.n ?? 0);
}

/** purge_fact: the live fact row `id` of the source (a checkpoint row is not a fact), with its fingerprint and stored vector text. */
export async function loadPurgeTarget(raw: EngineRawRead, id: number, sourceId: string): Promise<PurgeTargetRow | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT id,source_id,visibility,fact,entity_slug,source_markdown_slug,
      gbrain_fact_fingerprint(fact) AS fact_hash,embedding::text AS embedding,embedding_model
    FROM facts WHERE id=${id} AND source_id=${sourceId} AND NOT ${trustedSql(outcomeMarkerSql('facts'))}`);
  const [row] = await raw<PurgeTargetRow>(text, params);
  return row ? { ...row, id: Number(row.id) } : null;
}

/** planFactPurge: the ids a purge of the fingerprint removes, in id order; `subject` '*' is every subject, an unbacked name key always matches. */
export async function planFactPurgeIds(raw: EngineRawRead, sourceId: string, visibility: string, factHash: string, subject: string): Promise<Array<{ id: number }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT id FROM facts WHERE source_id=${sourceId} AND visibility=${visibility}
    AND gbrain_fact_fingerprint(fact)=${factHash} AND (${subject}::text='*' OR entity_slug=${subject}::text OR ${trustedSql(unbackedEntitySql('facts'))})
    AND NOT ${trustedSql(outcomeMarkerSql('facts'))} ORDER BY id`);
  return raw<{ id: number }>(text, params);
}

export interface FactsReconcileBacklogRows { rows: Array<{ source_id: string; slug: string; invalid: boolean }>; segmented: number }

/** doctor: the due pages holding a fence (or fence rows) with whether the latest attempt marked them invalid, and the due segmented pages with no fence rows (0 when the count cannot run). */
export async function listFactsReconcileBacklog(raw: EngineRawRead): Promise<FactsReconcileBacklogRows> {
  const pattern = `%${FACTS_FENCE_BEGIN}%`;
  const backlog = renderFragment(sqlFragment`WITH due AS MATERIALIZED (
       SELECT p.id, p.source_id, p.slug, p.knowledge_revision, r.outcome, r.attempted_revision
         FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
        WHERE p.deleted_at IS NULL AND ${trustedSql(DUE)}
     )
     SELECT d.source_id, d.slug,
            COALESCE(d.outcome = 'invalid' AND d.attempted_revision IS NOT DISTINCT FROM d.knowledge_revision, false) AS invalid
       FROM due d JOIN pages p ON p.id = d.id
      WHERE p.compiled_truth LIKE ${pattern} OR p.timeline LIKE ${pattern} OR ${trustedSql(OWNS_FENCE_ROWS)}
      ORDER BY d.source_id COLLATE "C", d.slug COLLATE "C"`);
  const rows = await raw<{ source_id: string; slug: string; invalid: boolean }>(backlog.text, backlog.params);
  const count = renderFragment(sqlFragment`SELECT COUNT(*)::int AS n FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
      WHERE p.deleted_at IS NULL AND ${trustedSql(DUE)} AND p.body_storage = 'segmented' AND NOT ${trustedSql(OWNS_FENCE_ROWS)}`);
  const [segmented] = await raw<{ n: number }>(count.text, count.params).catch(() => []);
  return { rows, segmented: Number(segmented?.n ?? 0) };
}

export interface RelinkCandidateRow { id: number | string; fact: string; visibility: 'private' | 'world'; context: string | null; source: string | null; attributed_to: FactAttribution | null }

/** relink: the loose active facts of the source after `afterId` (and from `since` when set), in id order, at most `limit`. */
export async function listRelinkCandidateRows(raw: EngineRawRead, opts: { sourceId: string; afterId: number; since: Date | null; limit: number }): Promise<RelinkCandidateRow[]> {
  return raw<RelinkCandidateRow>(
    `SELECT id, fact, visibility, context, source, attributed_to FROM facts
      WHERE source_id = $1 AND entity_slug IS NULL AND expired_at IS NULL
        AND row_num IS NULL AND source_markdown_slug IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND id > $2 AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
      ORDER BY id LIMIT $4`,
    [opts.sourceId, opts.afterId, opts.since ? opts.since.toISOString() : null, opts.limit],
  );
}

/** relink: the entity-less active facts of the source a fence or page owns (relink never touches them). */
export async function countRelinkCandidates(raw: EngineRawRead, sourceId: string): Promise<number> {
  const [owned] = await raw<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM facts WHERE source_id = $1 AND entity_slug IS NULL AND expired_at IS NULL
       AND (row_num IS NOT NULL OR source_markdown_slug IS NOT NULL)`, [sourceId]);
  return Number(owned?.n ?? 0);
}

export interface SimilarActiveFacts {
  anchor: { has_embedding: boolean; entity_slug: string | null } | null;
  rows: Array<{ id: number | string; similarity: number | string }>;
}

/**
 * similarActiveAfterForget: the withdrawn fact's embedding flag and entity, then, when it has an embedding, the other
 * active facts of that entity and visibility whose same-model vector is within `minCosine` of it, nearest first.
 */
export async function listSimilarActiveFacts(raw: EngineRawRead, opts: { sourceId: string; factId: number; remote: boolean; excludePrivate: boolean; minCosine: number; limit: number }): Promise<SimilarActiveFacts> {
  const [anchor] = await raw<{ has_embedding: boolean; entity_slug: string | null }>(
    `SELECT embedding IS NOT NULL AS has_embedding, entity_slug FROM facts WHERE id=$1 AND source_id=$2`, [opts.factId, opts.sourceId]);
  if (!anchor?.has_embedding) return { anchor: anchor ?? null, rows: [] };
  const provenance = trustedSql(opts.excludePrivate ? ` AND ${privateProvenanceFilterUnderPolicy('c')}` : '');
  const { text, params } = renderFragment(sqlFragment`SELECT c.id, (1 - (c.embedding <=> n.embedding))::float8 AS similarity
       FROM facts n JOIN facts c
         ON c.source_id = n.source_id AND c.entity_slug IS NOT DISTINCT FROM n.entity_slug AND c.visibility = n.visibility AND c.id <> n.id
      WHERE n.id = ${opts.factId} AND n.source_id = ${opts.sourceId}
        AND c.expired_at IS NULL AND (c.valid_until IS NULL OR c.valid_until > now())
        AND c.embedding IS NOT NULL AND c.embedding_model = n.embedding_model
        AND (${opts.remote}::boolean = false OR c.visibility = 'world')${provenance}
        AND (1 - (c.embedding <=> n.embedding)) >= ${opts.minCosine}
      ORDER BY c.embedding <=> n.embedding, c.id
      LIMIT ${opts.limit}`);
  return { anchor, rows: await raw<{ id: number | string; similarity: number | string }>(text, params) };
}

/** A `SELECT *` row of `facts`, as the single-fact decision reads it. */
export type ExactFactRow = FactRow & { source_markdown_slug: string | null; row_num: number | null };

/**
 * decideSingleFact: the first active fact (lowest id) with the same fingerprint, entity, visibility and speaker slot. With
 * `pageSlug` it is a fact on that page; without, one on no owned memory page (an empty `pageSlug` matches nothing).
 * `remoteFloor` adds the remote provenance floor (a remote caller's own reads).
 */
export async function findActiveSingleFact(raw: EngineRawRead, opts: { sourceId: string; entitySlug: string | null; visibility: string; fact: string; attributedTo: string | null; pageSlug: string | null; remoteFloor: boolean }): Promise<ExactFactRow | null> {
  const floor = trustedSql(opts.remoteFloor ? ` AND ${remoteProvenanceFloorSql('facts')}` : '');
  const page = opts.pageSlug ? sqlFragment`source_markdown_slug=${opts.pageSlug}`
    : sqlFragment`(${opts.pageSlug}::text IS NULL AND NOT ${trustedSql(onOwnedMemoryPageSql('facts'))})`;
  const { text, params } = renderFragment(sqlFragment`SELECT * FROM facts WHERE source_id=${opts.sourceId}
    AND entity_slug IS NOT DISTINCT FROM ${opts.entitySlug}::text AND visibility=${opts.visibility} AND expired_at IS NULL
    AND (valid_until IS NULL OR valid_until>now()) AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint(${opts.fact})
    AND (${opts.attributedTo}::text IS NULL OR attributed_to IS NULL OR attributed_to=${opts.attributedTo}::text)${floor}
    AND ${page}
    ORDER BY id LIMIT 1`);
  const [exact] = await raw<ExactFactRow>(text, params);
  return exact ?? null;
}

export interface SingleFactMetadataRow {
  id: number; source_markdown_slug: string | null; row_num: number | null; trust_tier: FactRow['trust_tier'];
  claim_metric: string | null; claim_unit: string | null; claim_period: string | null;
}

/** decideSingleFact: the fence position, trust tier and claim slot of the candidate facts `ids`. */
export async function listSingleFactMetadata(raw: EngineRawRead, opts: { sourceId: string; ids: number[]; remoteFloor: boolean }): Promise<SingleFactMetadataRow[]> {
  const floor = trustedSql(opts.remoteFloor ? ` AND ${remoteProvenanceFloorSql('facts')}` : '');
  const { text, params } = renderFragment(sqlFragment`SELECT id,source_markdown_slug,row_num,trust_tier,claim_metric,claim_unit,claim_period FROM facts WHERE source_id=${opts.sourceId} AND id=ANY(${opts.ids}::int[])${floor}`);
  return raw<SingleFactMetadataRow>(text, params);
}

/** planUnfencedFacts: the active unfenced rows (no fence row, no ontology dimension) of one source or every source, with whether the entity has a live page, in byte order of source and entity (COLLATE "C", whatever the server locale), then id. */
export async function listUnfencedFactRows(raw: EngineRawRead, opts: { sourceId?: string }): Promise<UnfencedFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
            context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to,
            EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id
              AND p.slug = f.entity_slug AND p.deleted_at IS NULL) AS page_exists
       FROM facts f
      WHERE row_num IS NULL AND expired_at IS NULL AND dimension IS NULL
        ${opts.sourceId !== undefined ? sqlFragment`AND source_id = ${opts.sourceId}` : sqlFragment``}
      ORDER BY source_id COLLATE "C", entity_slug COLLATE "C", id`);
  return raw<UnfencedFactRow>(text, params);
}

export type HeldFenceFactRow = FenceRowInput & { id: number; row_num: number; fact: string; entity_slug: string | null };

/** heldFenceFactRows: the live fence rows of a page, in row order, a conversation extractor's own rows apart. */
export async function listHeldFenceFactRows(raw: EngineRawRead, sourceId: string, slug: string): Promise<HeldFenceFactRow[]> {
  return raw<HeldFenceFactRow>(`SELECT id, row_num, fact, kind, visibility, notability, context,
      valid_from, valid_until, source, confidence, claim_metric, claim_value, claim_unit, claim_period, attributed_to, entity_slug FROM facts
     WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL AND expired_at IS NULL
       AND COALESCE(source,'') NOT LIKE 'cli:extract-conversation-facts%' ORDER BY row_num, id`, [sourceId, slug]);
}

/** planFactWithdrawal: the page keys (the fence page, else the entity) of the live facts a withdrawal of the claim under `subject` expires; no order. */
export async function listWithdrawalSlugs(raw: EngineRawRead, sourceId: string, visibility: string, factHash: string, subject: string): Promise<Array<{ slug: string }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts CROSS JOIN ${subjectOf(subject)}
    WHERE source_id=${sourceId} AND visibility=${visibility} AND gbrain_fact_fingerprint(fact)=${factHash} AND (q.subject='*' OR entity_slug=q.subject OR (${trustedSql(unbackedEntitySql('facts'))} AND NOT ${trustedSql(ownedMemorySubjectSql('q.subject'))}) OR (${trustedSql(onOwnedMemoryPageSql('facts'))} AND source_markdown_slug=q.subject)) AND expired_at IS NULL
      AND COALESCE(source_markdown_slug, entity_slug) IS NOT NULL`);
  return raw<{ slug: string }>(text, params);
}

/** recordFactWithdrawal: expires every live fact of the claim under `subject` now, closing its valid time at now; the ids it expired. */
/** A fact purge tombstone, the row purge_fact writes into `fact_purges`. */
export interface FactPurgeInsert {
  sourceId: string; visibility: string; subject: string; factHash: string;
  requestId: string | null; actor: string | null; reason: string | null;
}

/** purge_fact: stores the tombstone; false when one already holds the same (source, visibility, subject, fingerprint). */
export async function insertFactPurge(raw: EngineRawRead, row: FactPurgeInsert): Promise<boolean> {
  const rows = await raw<{ inserted: number }>(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason) VALUES ($1,$2,$3,$4,$5::uuid,$6,$7) ON CONFLICT DO NOTHING RETURNING 1 AS inserted`,
    [row.sourceId, row.visibility, row.subject, row.factHash, row.requestId, row.actor, row.reason]);
  return rows.length > 0;
}

export async function expireFactsByWithdrawal(raw: EngineRawRead, sourceId: string, visibility: string, fact: string, subject: string): Promise<Array<{ id: number }>> {
  const { text, params } = renderFragment(sqlFragment`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now()) FROM ${subjectOf(subject)}
    WHERE facts.source_id=${sourceId} AND facts.visibility=${visibility} AND gbrain_fact_fingerprint(facts.fact)=gbrain_fact_fingerprint(${fact})
      AND (q.subject='*' OR facts.entity_slug=q.subject OR (${trustedSql(unbackedEntitySql('facts'))} AND NOT ${trustedSql(ownedMemorySubjectSql('q.subject'))}) OR (${trustedSql(onOwnedMemoryPageSql('facts'))} AND facts.source_markdown_slug=q.subject)) AND facts.expired_at IS NULL RETURNING facts.id`);
  return raw<{ id: number }>(text, params);
}
