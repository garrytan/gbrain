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
import { privateProvenanceFilterUnderPolicy, privatePagesFilterFragment, remoteProvenanceFloorSql } from '../search/private-visibility.ts';
import type { FactAttribution, FactRow } from '../engine.ts';
import type { FenceRowInput, UnfencedFactRow } from '../facts/unfenced-facts.ts';
import { holdingSlugSql } from '../facts-fence.ts';
import { extractedFromPageSql } from '../facts/gone-page-facts.ts';
import { CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';
import { derivationAfterSql, type DerivationKey } from '../page-body/segment-derive.ts';
import { derivationClaimCandidateSql, derivationHoldsClaimSql, derivationSweepScopeSql, liveStagingSql } from '../page-body/schema.ts';
import { escapeFenceCell } from '../fence-shared.ts';
import type { IntentRedactionTarget } from '../persistence/intent-redaction.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { carriesClaimSql } from '../facts/claim-match-sql.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';
export type { UnfencedFactRow } from '../facts/unfenced-facts.ts';
export type { IntentRedactionTarget } from '../persistence/intent-redaction.ts';
export type { DerivationKey } from '../page-body/segment-derive.ts';

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

/** doctor: the due pages holding a fence (or fence rows) with whether the latest attempt marked them invalid, in (source, slug) byte order, and the due segmented pages with no fence rows (0 when the count cannot run). */
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

/** A reconcile attempt's outcome: `complete`, `deferred` (retried next run), `invalid` (retried after the page changes) or `cancelled`. */
export type FactsReconcileOutcome = 'complete' | 'deferred' | 'invalid' | 'cancelled';
/** Upper bound on pages one drain settles in bulk as having no fence and no fence rows. */
export const FACTLESS_SETTLE_LIMIT = 10_000;
/** `p`'s latest attempt did not mark its current revision invalid. */
export const RETRYABLE = `NOT COALESCE(r.outcome = 'invalid' AND r.attempted_revision IS NOT DISTINCT FROM p.knowledge_revision, false)`;

/** extract_facts: records one live page's reconcile outcome at `revision` (`undefined`: at the current revision); a moved-on page records nothing. Moved from facts/reconcile-watermark.ts settleFactsReconcile unchanged. */
export async function settleFactsReconcile(
  raw: EngineRawRead, sourceId: string, slug: string, outcome: FactsReconcileOutcome, revision?: string | null,
): Promise<void> {
  await raw(
    `INSERT INTO page_facts_reconcile AS r (page_id, reconciled_revision, reconciled_at, outcome, attempted_revision, attempted_at)
     SELECT p.id, CASE WHEN $3 = 'complete' THEN p.knowledge_revision END, CASE WHEN $3 = 'complete' THEN now() END,
            $3, p.knowledge_revision, now()
       FROM pages p
      WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
        AND ($5::boolean OR p.knowledge_revision IS NOT DISTINCT FROM $4::uuid)
     ON CONFLICT (page_id) DO UPDATE SET
       reconciled_revision = CASE WHEN EXCLUDED.outcome = 'complete' THEN EXCLUDED.reconciled_revision ELSE r.reconciled_revision END,
       reconciled_at = CASE WHEN EXCLUDED.outcome = 'complete' THEN EXCLUDED.reconciled_at ELSE r.reconciled_at END,
       outcome = EXCLUDED.outcome,
       attempted_revision = EXCLUDED.attempted_revision,
       attempted_at = EXCLUDED.attempted_at`,
    [sourceId, slug, outcome, revision ?? null, revision === undefined],
  );
}

/** extract_facts' commit step: locks the live page row `FOR SHARE` for the rest of the caller's transaction and reports whether its `knowledge_revision` is still `revision`. Fires no trigger and changes nothing. Moved from facts/reconcile-watermark.ts lockReconcileRevision unchanged. */
export async function lockReconcileRevision(raw: EngineRawRead, sourceId: string, slug: string, revision: string | null): Promise<boolean> {
  const rows = await raw<{ knowledge_revision: string | null }>(
    `SELECT knowledge_revision FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR SHARE`,
    [sourceId, slug],
  );
  return rows.length === 1 && (rows[0]!.knowledge_revision ?? null) === revision;
}

/** extract_facts: settles up to FACTLESS_SETTLE_LIMIT due fenceless pages of the source as complete, then returns up to `pageLimit` due retryable slugs, never-attempted first, then oldest attempt, then page id. Moved from facts/reconcile-watermark.ts selectFactsReconcileDrain; `sqlFragment` numbers the placeholders, the predicates are the same. */
export async function selectFactsReconcileDrain(raw: EngineRawRead, sourceId: string, pageLimit: number): Promise<string[]> {
  const marker = `%${FACTS_FENCE_BEGIN}%`;
  const settle = renderFragment(sqlFragment`INSERT INTO page_facts_reconcile AS r (page_id, reconciled_revision, reconciled_at, outcome, attempted_revision, attempted_at)
     SELECT p.id, p.knowledge_revision, now(), 'complete', p.knowledge_revision, now()
       FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
      WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL AND ${trustedSql(DUE)}
        AND p.compiled_truth NOT LIKE ${marker} AND p.timeline NOT LIKE ${marker}
        AND NOT ${trustedSql(OWNS_FENCE_ROWS)}
      ORDER BY p.id
      LIMIT ${FACTLESS_SETTLE_LIMIT}
     ON CONFLICT (page_id) DO UPDATE SET
       reconciled_revision = EXCLUDED.reconciled_revision, reconciled_at = EXCLUDED.reconciled_at,
       outcome = EXCLUDED.outcome, attempted_revision = EXCLUDED.attempted_revision, attempted_at = EXCLUDED.attempted_at`);
  await raw(settle.text, settle.params);
  const due = renderFragment(sqlFragment`SELECT p.slug FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
      WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL AND ${trustedSql(DUE)} AND ${trustedSql(RETRYABLE)}
      ORDER BY r.attempted_at ASC NULLS FIRST, p.id ASC
      LIMIT ${pageLimit}`);
  const rows = await raw<{ slug: string }>(due.text, due.params);
  return rows.map(r => r.slug);
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
 * `remoteFloor` adds the remote provenance floor (a remote caller's own reads). `newest` answers the highest id instead
 * (remember linking the unlinked copy of a claim).
 */
export async function findActiveSingleFact(raw: EngineRawRead, opts: { sourceId: string; entitySlug: string | null; visibility: string; fact: string; attributedTo: string | null; pageSlug: string | null; remoteFloor: boolean; newest?: boolean }): Promise<ExactFactRow | null> {
  const floor = trustedSql(opts.remoteFloor ? ` AND ${remoteProvenanceFloorSql('facts')}` : '');
  const page = opts.pageSlug ? sqlFragment`source_markdown_slug=${opts.pageSlug}`
    : sqlFragment`(${opts.pageSlug}::text IS NULL AND NOT ${trustedSql(onOwnedMemoryPageSql('facts'))})`;
  const { text, params } = renderFragment(sqlFragment`SELECT * FROM facts WHERE source_id=${opts.sourceId}
    AND entity_slug IS NOT DISTINCT FROM ${opts.entitySlug}::text AND visibility=${opts.visibility} AND expired_at IS NULL
    AND (valid_until IS NULL OR valid_until>now()) AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint(${opts.fact})
    AND (${opts.attributedTo}::text IS NULL OR attributed_to IS NULL OR attributed_to=${opts.attributedTo}::text)${floor}
    AND ${page}
    ORDER BY id${trustedSql(opts.newest ? ' DESC' : '')} LIMIT 1`);
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

/** Whether the entity a fact row names has a live page in the row's source. */
const LIVE_ENTITY_PAGE = trustedSql('EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)');

/** planUnfencedFacts (#10005): one group of the active unfenced rows (no fence row, no ontology dimension), by source, whether the row names an entity and whether that entity has a live page of the source. */
export interface UnfencedFactGroup { source_id: string; has_entity: boolean; page_exists: boolean; n: number }

/** planUnfencedFacts (#10005): the counts of the active unfenced rows of one source or every source per (source, has an entity, entity page is live), so the rows that can never be fenced are counted on the server and not transferred. */
export async function countUnfencedFactGroups(raw: EngineRawRead, opts: { sourceId?: string }): Promise<UnfencedFactGroup[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT source_id, has_entity, page_exists, COUNT(*) AS n
       FROM (SELECT f.source_id, f.entity_slug IS NOT NULL AS has_entity, ${LIVE_ENTITY_PAGE} AS page_exists
               FROM facts f WHERE row_num IS NULL AND expired_at IS NULL AND dimension IS NULL${opts.sourceId !== undefined ? sqlFragment` AND source_id = ${opts.sourceId}` : sqlFragment``}) c
      GROUP BY source_id, has_entity, page_exists`);
  return (await raw<{ source_id: string; has_entity: boolean; page_exists: boolean; n: number | string }>(text, params))
    .map(row => ({ ...row, n: Number(row.n) }));
}

/**
 * planUnfencedFacts: the active unfenced rows (no fence row, no ontology dimension) of one source or every source, with whether the entity has a live page, in byte order of source and entity (COLLATE "C", whatever the server locale), then id.
 * With `fenceableSourceIds` (#10005) only the rows that name an entity with a live page, in those sources, come back (all with `page_exists` true).
 */
export async function listUnfencedFactRows(raw: EngineRawRead, opts: { sourceId?: string; fenceableSourceIds?: string[] }): Promise<UnfencedFactRow[]> {
  const fenceable = opts.fenceableSourceIds;
  if (fenceable !== undefined && fenceable.length === 0) return [];
  const pageExists = fenceable !== undefined ? trustedSql('TRUE') : LIVE_ENTITY_PAGE;
  const { text, params } = renderFragment(sqlFragment`SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
            context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to,
            ${pageExists} AS page_exists
       FROM facts f
      WHERE row_num IS NULL AND expired_at IS NULL AND dimension IS NULL
        ${opts.sourceId !== undefined ? sqlFragment`AND source_id = ${opts.sourceId}` : sqlFragment``}
        ${fenceable !== undefined ? sqlFragment`AND source_id = ANY(${fenceable}::text[]) AND entity_slug IS NOT NULL AND ${LIVE_ENTITY_PAGE}` : sqlFragment``}
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

/** One hop of the derivation walk (facts/derivation-inputs.ts derivedRowsFrom): the rows a `derivation_inputs` edge
 * derives from a frontier row, distinct, in (table, id) order, at most `limit`. */
export async function listDerivedRows(raw: EngineRawRead, frontier: ReadonlyArray<{ table: string; id: string }>, limit: number):
  Promise<Array<{ derived_table: string; derived_id: string }>> {
  return raw<{ derived_table: string; derived_id: string }>(`SELECT DISTINCT d.derived_table,d.derived_id
      FROM derivation_inputs d JOIN jsonb_to_recordset($1::text::jsonb) AS f(input_table text,input_id text)
        ON d.input_table=f.input_table AND d.input_id=f.input_id
      ORDER BY d.derived_table,d.derived_id LIMIT $2`, [JSON.stringify(frontier.map(f => ({ input_table: f.table, input_id: f.id }))), limit]);
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

/** A page purge's content-hash tombstones, the rows the page purge sweep writes into `page_purges`. */
export interface PagePurgeUpsert { sourceId: string; contentHashes: string[]; slug: string; requestId: string | null }

/** tombstonePage: records each content hash under the slug; a hash already tombstoned takes the new slug, request and time. */
export async function upsertPagePurges(raw: EngineRawRead, row: PagePurgeUpsert): Promise<void> {
  await raw(`INSERT INTO page_purges(source_id,content_hash,slug,request_id) SELECT $1,h,$3,$4::uuid FROM unnest($2::text[]) AS h
    ON CONFLICT (source_id,content_hash) DO UPDATE SET slug=EXCLUDED.slug,request_id=EXCLUDED.request_id,purged_at=now()`, [row.sourceId, row.contentHashes, row.slug, row.requestId]);
}

/**
 * The one writer of `take_purges`, in two forms. `claimHash` is one tombstone (purge_fact, and the belief purge replay,
 * one per replayed hash); `pageId` tombstones the fingerprint of every take claim of that page (the page purge), under
 * the same subject. `requestId` is the purge request the tombstones answer to, or null.
 */
export type TakePurgeInsert = { sourceId: string; subject: string; requestId: string | null }
  & ({ claimHash: string; pageId?: undefined } | { pageId: number; claimHash?: undefined });

/** The take tombstone writer: stores it (or one per distinct take claim of the page); false when every one already exists, or the page has no takes. */
export async function insertTakePurge(raw: EngineRawRead, row: TakePurgeInsert): Promise<boolean> {
  const rows = row.pageId === undefined
    ? await raw<{ inserted: number }>(`INSERT INTO take_purges(source_id,subject,claim_hash,request_id) VALUES ($1,$2,$3,$4::uuid) ON CONFLICT DO NOTHING RETURNING 1 AS inserted`,
      [row.sourceId, row.subject, row.claimHash, row.requestId])
    : await raw<{ inserted: number }>(`INSERT INTO take_purges(source_id,subject,claim_hash,request_id)
      SELECT DISTINCT $1,$2,gbrain_fact_fingerprint(claim),$4::uuid FROM takes WHERE page_id=$3 ON CONFLICT DO NOTHING RETURNING 1 AS inserted`,
    [row.sourceId, row.subject, row.pageId, row.requestId]);
  return rows.length > 0;
}

export async function expireFactsByWithdrawal(raw: EngineRawRead, sourceId: string, visibility: string, fact: string, subject: string): Promise<Array<{ id: number }>> {
  const { text, params } = renderFragment(sqlFragment`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now()) FROM ${subjectOf(subject)}
    WHERE facts.source_id=${sourceId} AND facts.visibility=${visibility} AND gbrain_fact_fingerprint(facts.fact)=gbrain_fact_fingerprint(${fact})
      AND (q.subject='*' OR facts.entity_slug=q.subject OR (${trustedSql(unbackedEntitySql('facts'))} AND NOT ${trustedSql(ownedMemorySubjectSql('q.subject'))}) OR (${trustedSql(onOwnedMemoryPageSql('facts'))} AND facts.source_markdown_slug=q.subject)) AND facts.expired_at IS NULL RETURNING facts.id`);
  return raw<{ id: number }>(text, params);
}

/** Hand-numbered placeholders spliced into statements that also carry a vetted builder, so the rendered text keeps the caller's own `$N`. */
const P = { p1: '$1', p2: '$2', p3: '$3', p4: '$4', p5: '$5', p6: '$6', p7: '$7', p8: '$8' } as const;

// ---------------------------------------------------------------------------------------------------------------------
// gone-page-facts.ts: the facts a retention purge expires with their pages
// ---------------------------------------------------------------------------------------------------------------------

/** `$1` source ids and `$2` slugs, paired by position. */
const GONE = 'unnest($1::text[], $2::text[]) AS g(source_id, slug)';
const EXPIRE_FILED_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.source_markdown_slug = g.slug AND f.expired_at IS NULL AND f.dimension IS NULL`;
const EXPIRE_FILED_SLOT_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL, dimension = NULL, value = NULL, value_hash = NULL, dim_status = NULL
  FROM ${GONE} WHERE f.source_id = g.source_id AND f.source_markdown_slug = g.slug AND f.expired_at IS NULL AND f.dimension IS NOT NULL AND f.row_num IS NOT NULL AND ${CONVERSATION_SLOT_SQL}`;
const EXPIRE_EXTRACTED_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.expired_at IS NULL AND ${extractedFromPageSql('f', 'g.slug')}`;
const EXPIRE_ABOUT_SQL = `UPDATE facts f SET expired_at = now(), row_num = NULL FROM ${GONE}
  WHERE f.source_id = g.source_id AND f.entity_slug = g.slug AND f.expired_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM pages hp WHERE hp.source_id = f.source_id AND hp.slug = f.source_markdown_slug AND hp.slug <> g.slug)`;

/**
 * expireGonePageFacts: the four updates a purge runs after it deletes the page rows, in order, each on the same pairs of
 * source ids (`$1`) and slugs (`$2`): the facts filed on the pages, their conversation slots, the facts extracted from them,
 * and the facts about them that no page holds. Each is its own update, so each uses its slug index.
 */
export async function expireFactsOfGonePages(raw: EngineRawRead, sourceIds: string[], slugs: string[]): Promise<void> {
  const params = [sourceIds, slugs];
  await raw(EXPIRE_FILED_SQL, params);
  await raw(EXPIRE_FILED_SLOT_SQL, params);
  await raw(EXPIRE_EXTRACTED_SQL, params);
  await raw(EXPIRE_ABOUT_SQL, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// purge-reasons.ts: the change reasons a purge redacts and tombstones
// ---------------------------------------------------------------------------------------------------------------------

/** A Git effect row with the request that queued it, locked `FOR UPDATE OF e` by the reads below. */
export interface PurgeGitEffectRow { id: string; state: string; request_id: string; data: Record<string, unknown> }

/** scanPurgeTrailers: the checkout of the source, null for none or a source without one. */
export async function readPurgeSourceLocalPath(raw: EngineRawRead, sourceId: string): Promise<string | null> {
  const [source] = await raw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  return source?.local_path ?? null;
}

/**
 * redactGitEffectReasons: the source's Git effects whose data carries the claim in any of its three forms, locked for the
 * redaction; `foldedJson` is the folded needle as JSON text without its quotes.
 */
export async function listGitEffectsCarryingReason(raw: EngineRawRead, sourceId: string, needle: string, escaped: string, foldedJson: string): Promise<PurgeGitEffectRow[]> {
  return raw<PurgeGitEffectRow>(`SELECT e.id::text AS id, e.state, r.request_id::text AS request_id, e.data
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE e.source_id = $1 AND e.kind = 'git' AND (strpos(lower(e.data::text), $2) > 0 OR strpos(lower(e.data::text), $3) > 0 OR strpos(lower(e.data::text), $4) > 0)
    ORDER BY e.id FOR UPDATE OF e`, [sourceId, needle, escaped, foldedJson]);
}

/** stripPageGitNotes: every Git effect of the slug that carries a commit line or trailers, locked for the strip. */
export async function listPageGitEffectsForStrip(raw: EngineRawRead, sourceId: string, slug: string): Promise<PurgeGitEffectRow[]> {
  return raw<PurgeGitEffectRow>(`SELECT e.id::text AS id, e.state, r.request_id::text AS request_id, e.data
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE e.source_id = $1 AND e.kind = 'git' AND e.data->>'slug' = $2
      AND ((e.data->'commit_line') IS NOT NULL OR (e.data->'commit_trailers') IS NOT NULL OR (e.data->'commit_trailer') IS NOT NULL) ORDER BY e.id FOR UPDATE OF e`, [sourceId, slug]);
}

/** redactGitEffectReasons, stripPageGitNotes: replaces one effect's data (`effectId` is the bigint as text). */
export async function setPurgeEffectData(raw: EngineRawRead, effectId: string, data: Record<string, unknown>): Promise<void> {
  await raw('UPDATE persistence_effects SET data = $2::text::jsonb WHERE id = $1::bigint', [effectId, JSON.stringify(data)]);
}

/** pageChangeReasons: the reasons the page's snapshots and its requests (intent and outcome) recorded, each once. */
export async function listPageChangeReasons(raw: EngineRawRead, sourceId: string, slug: string, pageId: number): Promise<Array<{ reason: string | null }>> {
  return raw<{ reason: string | null }>(`SELECT change_reason AS reason FROM page_versions WHERE page_id = $1
    UNION SELECT intent->>'reason' FROM persistence_requests WHERE source_id = $2 AND slug = $3
    UNION SELECT outcome->'reason_recorded'->>'reason' FROM persistence_requests WHERE source_id = $2 AND slug = $3`, [pageId, sourceId, slug]);
}

/** requestsRecordingReasons: the slug's requests whose intent or outcome records a reason, oldest first, compacted ones included. */
export async function listRequestsRecordingReasons(raw: EngineRawRead, sourceId: string, slug: string): Promise<IntentRedactionTarget[]> {
  return raw<IntentRedactionTarget>(`SELECT id::text AS id, principal_kind, principal_id FROM persistence_requests
    WHERE source_id = $1 AND slug = $2 AND ((intent->>'reason') IS NOT NULL OR (outcome->'reason_recorded') IS NOT NULL) ORDER BY sequence LIMIT 10000`, [sourceId, slug]);
}

// ---------------------------------------------------------------------------------------------------------------------
// held-fact-move.ts: the facts a holding page keeps for an entity that has no page yet
// ---------------------------------------------------------------------------------------------------------------------

/** One held fact row with the holding page that carries it. */
export type HeldFactRow = UnfencedFactRow & { from_slug: string };
/** One struck held row: its holding page, entity, row number and claim. */
export interface StruckHeldRow { from_slug: string; entity_slug: string; row_num: number; fact: string }

/** The held rows on the holding pages of `$1`: a row with a row number and an entity that is no holding page, on a holding page. */
const onHolding = sqlFragment`f.source_id = ${trustedSql(P.p1)} AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = ${trustedSql(P.p1)} AND ${trustedSql(holdingSlugSql('hp.slug'))})
    AND f.row_num IS NOT NULL AND f.dimension IS NULL AND f.entity_slug IS NOT NULL AND NOT ${trustedSql(holdingSlugSql('f.entity_slug'))}`;

/** holdingHome: whether the entity's page exists and is soft-deleted, so its facts are not held. */
export async function heldEntityPageDeleted(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  return (await raw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL', [sourceId, slug])).length > 0;
}

/** The access state of `entity` as the holding-page decision reads it. */
export interface HeldAccessState { unreadable: boolean; page_rule: boolean; restricted: boolean }

/** holdingPageFor: whether the access state is readable, an exact page rule covers the entity, and a folder rule restricts it. */
export async function readHeldAccessState(raw: EngineRawRead, sourceId: string, entity: string): Promise<HeldAccessState[]> {
  return raw<HeldAccessState>(
    `SELECT gbrain_access_state_unreadable() AS unreadable,
       (EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id=$1 AND r.prefix=$2)
         OR EXISTS (SELECT 1 FROM access_pending_coverage c WHERE c.source_id=$1 AND c.prefix=$2)) AS page_rule,
       (gbrain_access_folder_rules($1, $2) IS NOT NULL OR gbrain_access_pending_covers($1, $2)) AS restricted`, [sourceId, entity]);
}

/** heldFactTarget: whether a live page holds the slug. */
export async function heldTargetPageLive(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  return (await raw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug])).length > 0;
}

/** planHeldMoves: every live held row on every holding page, in the order the move runs them. */
export async function listHeldMoveRows(raw: EngineRawRead, sourceId: string): Promise<HeldFactRow[]> {
  const { text } = renderFragment(sqlFragment`SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to, true AS page_exists, source_markdown_slug AS from_slug
       FROM facts f WHERE ${onHolding} AND f.expired_at IS NULL ORDER BY f.source_markdown_slug COLLATE "C", f.entity_slug COLLATE "C", f.id`);
  return raw<HeldFactRow>(text, [sourceId]);
}

/** planHeldMoves: the struck held rows, one per holding page and row number; a row an active fact reuses is not struck. */
export async function listStruckHeldRows(raw: EngineRawRead, sourceId: string): Promise<StruckHeldRow[]> {
  const { text } = renderFragment(sqlFragment`SELECT DISTINCT ON (f.source_markdown_slug COLLATE "C", f.row_num) f.source_markdown_slug AS from_slug, f.entity_slug, f.row_num, f.fact FROM facts f
      WHERE ${onHolding} AND f.expired_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM facts a WHERE a.source_id = f.source_id
        AND a.source_markdown_slug = f.source_markdown_slug AND a.row_num = f.row_num AND a.expired_at IS NULL)
      ORDER BY f.source_markdown_slug COLLATE "C", f.row_num, f.id DESC`);
  return raw<StruckHeldRow>(text, [sourceId]);
}

/** planHeldMoves: whether every reader of the source can read the live page; null for no live page. */
export async function readHeldRowVisibility(raw: EngineRawRead, sourceId: string, slug: string): Promise<{ visible: boolean } | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(privatePagesFilterFragment('p'))} AS visible FROM pages p WHERE p.source_id=${sourceId} AND p.slug=${slug} AND p.deleted_at IS NULL`);
  const [page] = await raw<{ visible: boolean }>(text, params);
  return page ?? null;
}

/** moveRuledSharedHeld: whether a rule now narrows a held row's entity below its holding page's readers. */
export async function heldMoveDue(raw: EngineRawRead, sourceId: string): Promise<boolean> {
  const { text } = renderFragment(sqlFragment`SELECT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = ${trustedSql(P.p1)}
      AND f.source_markdown_slug IN (SELECT hp.slug FROM pages hp WHERE hp.source_id = ${trustedSql(P.p1)} AND ${trustedSql(holdingSlugSql('hp.slug'))})
      AND f.row_num IS NOT NULL AND f.dimension IS NULL AND f.entity_slug IS NOT NULL AND NOT ${trustedSql(holdingSlugSql('f.entity_slug'))}
      AND (NOT COALESCE(gbrain_access_folder_rules(f.source_id, f.entity_slug), '{}') <@ COALESCE(gbrain_access_folder_rules(f.source_id, f.source_markdown_slug), '{}')
        OR (gbrain_access_pending_covers(f.source_id, f.entity_slug) AND NOT gbrain_access_pending_covers(f.source_id, f.source_markdown_slug)))) AS due`);
  const [row] = await raw<{ due: boolean }>(text, [sourceId]);
  return Boolean(row?.due);
}

/** planningView's getConfig: one config row's value, null when unset. */
export async function readHeldConfigValue(raw: EngineRawRead, name: string): Promise<string | null> {
  const [row] = await raw<{ value: string }>('SELECT value FROM config WHERE key = $1', [name]);
  return row?.value ?? null;
}

/** moveHeldFacts: a live page's file path and URI, null for none; `opts.timeoutMs` ends the read on the server. */
export async function readHeldPageLocation(raw: EngineRawRead, sourceId: string, slug: string, opts?: { timeoutMs?: number }): Promise<{ source_path: string | null; source_uri: string | null } | null> {
  const [page] = await raw<{ source_path: string | null; source_uri: string | null }>(
    'SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug], opts);
  return page ?? null;
}

/** moveHeldFacts: the segmented saved versions a held-fact request recorded as not edited; 0 when none. */
export async function readHeldVersionsEdited(raw: EngineRawRead, requestId: string): Promise<number> {
  const [edited] = await raw<{ n: number | null }>(`SELECT (outcome->'held_versions_edited'->>'segmented_versions_not_edited')::int AS n
        FROM persistence_requests WHERE request_id = $1::uuid`, [requestId]);
  return Number(edited?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// purge-verify.ts: the probes of a purge receipt
// ---------------------------------------------------------------------------------------------------------------------

/** segmentedProse: the live pages stored in segments, in id order, `limit` of them. */
export async function listSegmentedPageBodies(raw: EngineRawRead, sourceId: string, limit: number): Promise<Array<{ page_id: number; slug: string; generation: null; version_id: null }>> {
  return raw<{ page_id: number; slug: string; generation: null; version_id: null }>(`SELECT id AS page_id,slug,NULL AS generation,NULL AS version_id FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND body_storage='segmented' ORDER BY id LIMIT $2`, [sourceId, limit]);
}

/** segmentedProse: the retained versions stored in segments, in id order, `limit` of them. */
export async function listSegmentedVersionBodies(raw: EngineRawRead, sourceId: string, limit: number): Promise<Array<{ page_id: number; slug: string; generation: number; version_id: number }>> {
  return raw<{ page_id: number; slug: string; generation: number; version_id: number }>(`SELECT v.page_id,p.slug,v.body_generation AS generation,v.id AS version_id
      FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND v.body_storage='segmented' ORDER BY v.id LIMIT $2`, [sourceId, limit]);
}

/** The receipt's probes: bounds the statements of the transaction this runs in to `ms` milliseconds. */
export async function setPurgeProbeTimeout(raw: EngineRawRead, ms: number): Promise<void> {
  await raw("SELECT set_config('statement_timeout',$1,true)", [`${ms}ms`]);
}

/** One batch of the derivation probe: the rows scanned and the claim-candidate, swept and kept counts, and the last key walked. */
export interface PurgeDerivationProbeRow {
  scanned: number; normalized: number; swept: number; kept: number; last_page: number | null; last_pipeline: string | null; last_occurrence: string | null;
}

/**
 * derivationTextReport: one batch of the stored derivation results after `cursor` (page, pipeline, occurrence) that hold a
 * needle: `pageIds` are the pages the sweep covers, `patterns` the claim forms, `rows` the batch size.
 */
export async function probePurgeDerivations(raw: EngineRawRead, sourceId: string, needles: string[], pageIds: number[], patterns: string[],
  cursor: DerivationKey | null, rows: number): Promise<PurgeDerivationProbeRow> {
  const { text } = renderFragment(sqlFragment`WITH batch AS MATERIALIZED (
            SELECT d.page_id, d.pipeline, d.occurrence_id, ${trustedSql(derivationSweepScopeSql('d', 'p', P.p3))} AS swept FROM page_segment_derivations d
            JOIN pages p ON p.id=d.page_id WHERE p.source_id=${trustedSql(P.p1)} AND ${trustedSql(derivationAfterSql('d', [P.p5, P.p6, P.p7]))}
            ORDER BY d.page_id, d.pipeline, d.occurrence_id LIMIT ${trustedSql(P.p8)}
          ), checked AS MATERIALIZED (
            SELECT b.swept, c.candidate, CASE WHEN c.candidate THEN ${trustedSql(derivationHoldsClaimSql('d', P.p2, P.p4))} ELSE false END AS hit
            FROM batch b JOIN page_segment_derivations d ON d.page_id=b.page_id AND d.pipeline=b.pipeline AND d.occurrence_id=b.occurrence_id
            CROSS JOIN LATERAL (SELECT ${trustedSql(derivationClaimCandidateSql('d', P.p4))} AS candidate) c
          ), last AS (
            SELECT b.page_id, b.pipeline, b.occurrence_id::text AS occurrence_id FROM batch b ORDER BY b.page_id DESC, b.pipeline DESC, b.occurrence_id DESC LIMIT 1
          ) SELECT (SELECT count(*)::int FROM batch) AS scanned, count(*) FILTER (WHERE candidate)::int AS normalized,
            count(*) FILTER (WHERE hit AND swept)::int AS swept, count(*) FILTER (WHERE hit AND NOT swept)::int AS kept,
            (SELECT page_id FROM last) AS last_page, (SELECT pipeline FROM last) AS last_pipeline, (SELECT occurrence_id FROM last) AS last_occurrence
          FROM checked`);
  const [counted] = await raw<PurgeDerivationProbeRow>(text, [sourceId, needles, pageIds, patterns, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, rows]);
  return counted!;
}

/** ledgerReports: the next 1000 recorded values of the source's belief events after id `after`, in id order. */
export async function listBeliefEventsForPurgeProbe(raw: EngineRawRead, sourceId: string, after: number): Promise<Array<{ id: number; subject_kind: string; subject_key: string; value: unknown }>> {
  return raw<{ id: number; subject_kind: string; subject_key: string; value: unknown }>(`SELECT id, subject_kind, subject_key, value
      FROM belief_events WHERE source_id = $1 AND id > $2 AND value IS NOT NULL ORDER BY id LIMIT 1000`, [sourceId, after]);
}

/** ledgerReports: the next 1000 live facts of the source after id `after` that have a context, in id order. */
export async function listFactContextsForPurgeProbe(raw: EngineRawRead, sourceId: string, after: number): Promise<Array<{ id: number; context: string }>> {
  return raw<{ id: number; context: string }>(`SELECT id, context FROM facts WHERE source_id = $1 AND id > $2 AND expired_at IS NULL
      AND COALESCE(context, '') <> '' ORDER BY id LIMIT 1000`, [sourceId, after]);
}

/** pageFilePaths: the distinct relative file paths of the pages and their versions (64 at most), none absolute or climbing out. */
export async function listPageSourcePathsForPurge(raw: EngineRawRead, pageIds: number[]): Promise<Array<{ source_path: string }>> {
  return raw<{ source_path: string }>(`SELECT DISTINCT source_path FROM (
      SELECT source_path FROM pages WHERE id=ANY($1::int[]) UNION ALL SELECT source_path FROM page_versions WHERE page_id=ANY($1::int[])) s
    WHERE source_path IS NOT NULL AND source_path<>'' AND source_path NOT LIKE '/%' AND source_path NOT LIKE '%..%' LIMIT 64`, [pageIds]);
}

/** vectorProbe: the five same-model facts of the source nearest to `embedding`, and whether each contains the claim. */
export async function listNearestFactsForPurge(raw: EngineRawRead, embedding: string, sourceId: string, model: string, fact: string): Promise<Array<{ id: number; similarity: number; contains_claim: boolean }>> {
  return raw<{ id: number; similarity: number; contains_claim: boolean }>(`SELECT id, similarity, contains_claim FROM (
        SELECT id,(1-(embedding <=> $1::halfvec))::float8 AS similarity, embedding <=> $1::halfvec AS distance,
          strpos(gbrain_fact_normalize(fact),gbrain_fact_normalize($4))>0 AS contains_claim
        FROM facts WHERE source_id=$2 AND embedding_model=$3 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::halfvec LIMIT 5) nearest
      ORDER BY distance, id`, [embedding, sourceId, model, fact]);
}

/** verifyFactPurge: the live atom and dream pages of the source that no derivation edge explains. */
export async function countLegacyDerivedPages(raw: EngineRawRead, sourceId: string): Promise<number> {
  const [legacy] = await raw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
    AND (p.type='atom' OR p.frontmatter->>'dream_generated'='true')
    AND NOT EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table='pages' AND d.derived_id=p.id::text)`, [sourceId]);
  return Number(legacy?.n ?? 0);
}

/** verifyFactPurge, PGLite only: compacts the tables a purge touches (`query_cache` too when it exists); rejects when the VACUUM fails. */
export async function vacuumPurgedTables(raw: EngineRawRead, withQueryCache: boolean): Promise<void> {
  await raw(withQueryCache
    ? 'VACUUM facts, takes, pages, content_chunks, page_versions, persistence_requests, query_cache'
    : 'VACUUM facts, takes, pages, content_chunks, page_versions, persistence_requests');
}

/** The page text stores a page purge's receipt searches for the purged page's claims. */
export type PageProseStore = 'pages' | 'content_chunks' | 'page_versions' | 'timeline_entries';

/** `$1` the source, `$2` the lowered needles; each lists the live pages whose own text in that store states one. */
const PROSE_IN: Record<PageProseStore, string> = {
  pages: `SELECT * FROM (SELECT DISTINCT p.slug FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(p.compiled_truth),n)>0 OR strpos(lower(COALESCE(p.timeline,'')),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`,
  content_chunks: `SELECT * FROM (SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(c.chunk_text),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`,
  page_versions: `SELECT * FROM (SELECT DISTINCT p.slug FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(v.compiled_truth),n)>0 OR strpos(lower(COALESCE(v.timeline,'')),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`,
  timeline_entries: `SELECT * FROM (SELECT DISTINCT p.slug FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(t.summary),n)>0 OR strpos(lower(COALESCE(t.detail,'')),n)>0)) q ORDER BY slug COLLATE "C" LIMIT 20`,
};

/** purgePageReceipt: the first 20 slugs, in order, of the source's live pages whose text in `store` states one of the lowered needles. */
export async function listPageProseHits(raw: EngineRawRead, store: PageProseStore, sourceId: string, loweredNeedles: string[]): Promise<Array<{ slug: string }>> {
  return raw<{ slug: string }>(PROSE_IN[store], [sourceId, loweredNeedles]);
}

/** pageReceipt: the checkout of the source, null for none; the receipt's own read, spelled `id=$1`. */
export async function readPurgeReceiptSourcePath(raw: EngineRawRead, sourceId: string): Promise<string | null> {
  const [source] = await raw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  return source?.local_path ?? null;
}

/** pageReceipt: how many tombstones the page purge left for the slug. */
export async function countPagePurgeTombstones(raw: EngineRawRead, sourceId: string, slug: string): Promise<number> {
  const [tombstones] = await raw<{ n: number }>('SELECT count(*)::int AS n FROM page_purges WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return Number(tombstones?.n ?? 0);
}

/** The columns of a request the page purge receipt reads. */
export type DeletePageRequestRow = Pick<WriteRequest, 'id' | 'request_id' | 'state' | 'source_id' | 'outcome'>;

/** pageReceipt: the newest delete_page request with this request id (the lowest id among equal created_at), null for none. */
export async function readDeletePageRequest(raw: EngineRawRead, sourceId: string, requestId: string): Promise<DeletePageRequestRow | null> {
  const [row] = await raw<DeletePageRequestRow>(`SELECT id,request_id,state,source_id,outcome FROM persistence_requests
    WHERE source_id=$1 AND request_id=$2::uuid AND operation='delete_page' ORDER BY created_at DESC, id LIMIT 1`, [sourceId, requestId]);
  return row ?? null;
}

/** purgeCompletion: the request's effects in kind order, each with whether any target is parked. */
export async function listPurgeEffects(raw: EngineRawRead, requestId: string): Promise<Array<{ kind: string; state: string; error_code: string | null; parked: boolean }>> {
  return raw<{ kind: string; state: string; error_code: string | null; parked: boolean }>(`SELECT kind,state,error_code,
    jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 AS parked FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind COLLATE "C"`, [requestId]);
}

/** purgeCompletion: the facts and takes that still carry the purged claim's fingerprint under `subject` ('*' for any), outcome markers apart. */
export async function countPurgeFingerprintResidue(raw: EngineRawRead, sourceId: string, factHash: string, subject: string): Promise<{ facts: number; takes: number }> {
  const { text } = renderFragment(sqlFragment`SELECT
      (SELECT count(*)::int FROM facts WHERE source_id=${trustedSql(P.p1)} AND gbrain_fact_fingerprint(fact)=${trustedSql(P.p2)} AND (${trustedSql(P.p3)}='*' OR entity_slug=${trustedSql(P.p3)}) AND NOT ${trustedSql(outcomeMarkerSql('facts'))}) AS facts,
      (SELECT count(*)::int FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=${trustedSql(P.p1)} AND gbrain_fact_fingerprint(k.claim)=${trustedSql(P.p2)} AND (${trustedSql(P.p3)}='*' OR p.slug=${trustedSql(P.p3)})) AS takes`);
  const [probe] = await raw<{ facts: number; takes: number }>(text, [sourceId, factHash, subject]);
  return { facts: Number(probe?.facts ?? 0), takes: Number(probe?.takes ?? 0) };
}

// ---------------------------------------------------------------------------------------------------------------------
// facts/purge.ts: the plan, transaction and segment-storage statements of a fact purge
// ---------------------------------------------------------------------------------------------------------------------

/** One upload part of a live staging, with its first and last bytes. */
export interface StagingPartEdge { id: string; part_no: number; head: Uint8Array; tail: Uint8Array }
/** A page a purge touches: its slug, id and knowledge revision. */
export interface PurgePageRef { slug: string; page_id: number; revision: string }
/** How many review and decide rows of a source name the purged facts. */
export interface PurgeReviewCounts { decide_review_queue: number; decide_review_proposals: number; decide_proposals: number }
/** An unfinished write or withdrawal mirror that blocks a purge of the page. */
export interface PurgeBlockedPublication { request_id: string; slug: string; state: string }
/** A segmented saved version the purge may have to redact. */
export interface SegmentedVersionRow {
  id: number; page_id: number; generation: number | null; slug: string; title: string; type: string; frontmatter: Record<string, unknown>; tags: string[] | null;
}
/** A fact the purge's text match offers the caller, cut to 160 characters. */
export interface PurgeMatchRow { id: number; entity_slug: string | null; visibility: string; expired: boolean; fact: string }
/** The source row a purge transaction locks. */
export interface PurgeSourceLock { incarnation: string; archived: boolean }
/** A page after the purge, with the revision the receipt records. */
export interface PurgedPageRevision { id: number; slug: string; knowledge_revision: string }

/** A segmented version (`v`) whose generation's segment texts hold the lowered claim `$2`. */
const SEGMENTED_VERSION_CARRIES = `EXISTS (SELECT 1 FROM page_body_manifest m JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
  WHERE m.page_id=v.page_id AND m.staging_id IS NULL AND m.gen_from<=v.body_generation AND (m.gen_to IS NULL OR m.gen_to>v.body_generation)
    AND strpos(lower(convert_from(t.body,'UTF8')),$2)>0)`;

/** stagingsWithClaimAcrossParts: The next 1000 upload parts of the source's live stagings after the (staging, part) cursor, in order, each with its first and last `keep` bytes. Reads page_body_staging_parts and page_body_stagings. */
export async function listStagingPartEdges(raw: EngineRawRead, sourceId: string, keep: number, after: { id: string; part: number }): Promise<StagingPartEdge[]> {
  return raw<StagingPartEdge>(`SELECT pt.staging_id::text AS id,pt.part_no,
        substring(pt.body from 1 for $2) AS head,substring(pt.body from greatest(1,octet_length(pt.body)-$2+1)) AS tail
      FROM page_body_staging_parts pt JOIN page_body_stagings s ON s.id=pt.staging_id
      WHERE s.source_id=$1 AND s.state IN ('open','sealed','prepared') AND (pt.staging_id,pt.part_no)>($3::uuid,$4::int)
      ORDER BY pt.staging_id,pt.part_no LIMIT 1000`, [sourceId, keep, after.id, after.part]);
}

/** stagingsHoldingClaim: The ids of the source's live stagings whose staged segment texts or upload parts hold the claim, plain or as a fence cell stores it, in id order. Reads page_body_stagings, page_body_manifest, page_segment_texts, page_body_staging_parts, page_body_staging_texts and persistence_requests. */
export async function listStagingsHoldingClaim(raw: EngineRawRead, sourceId: string, claim: string): Promise<string[]> {
  const { text } = renderFragment(sqlFragment`SELECT s.id::text AS id FROM page_body_stagings s
    WHERE s.source_id=${trustedSql(P.p1)} AND ((s.state IN ('open','sealed','prepared') AND (EXISTS (SELECT 1 FROM page_body_manifest m
        JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256 WHERE m.staging_id=s.id AND strpos(lower(convert_from(t.body,'UTF8')),${trustedSql(P.p2)})>0)
      OR EXISTS (SELECT 1 FROM page_body_staging_parts pt WHERE pt.staging_id=s.id AND position(convert_to(${trustedSql(P.p3)}::text,'UTF8') in pt.body)>0)))
      OR (${trustedSql(liveStagingSql('s'))} AND EXISTS (SELECT 1 FROM page_body_staging_texts r JOIN page_segment_texts t ON t.source_id=r.source_id AND t.sha256=r.sha256
        WHERE r.staging_id=s.id AND (strpos(lower(convert_from(t.body,'UTF8')),${trustedSql(P.p2)})>0 OR strpos(lower(convert_from(t.body,'UTF8')),${trustedSql(P.p4)})>0))))
    ORDER BY s.id`);
  return (await raw<{ id: string }>(text, [sourceId, claim.toLowerCase(), claim, escapeFenceCell(claim).toLowerCase()])).map(row => row.id);
}

/** planFactPurge: Whether a live page of the source holds the slug (the one-row read that tells a purge the subject is an unbacked name key). Reads pages. */
export async function purgeSubjectPageLive(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  return (await raw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL LIMIT 1`, [sourceId, slug])).length > 0;
}

/** planFactPurge: The slug, id and knowledge revision of the source's pages with these ids. Reads pages. */
export async function listPurgePagesById(raw: EngineRawRead, sourceId: string, pageIds: number[]): Promise<PurgePageRef[]> {
  return raw<PurgePageRef>(`SELECT slug,id AS page_id,knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])`, [sourceId, pageIds]);
}

/** planFactPurge: How many saved versions of the source's pages carry the claim in their text, title, metadata or segments, or quote it in their change reason (`needle` lowered, `escaped` its JSON form, `reason` the folded reason form). Reads page_versions, pages, page_body_manifest and page_segment_texts. */
export async function countPurgeVersionsCarryingClaim(raw: EngineRawRead, sourceId: string, needle: string, escaped: string, reason: string): Promise<number> {
  const { text } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id
    WHERE p.source_id=${trustedSql(P.p1)} AND (${trustedSql(carriesClaimSql('v', 2))} OR strpos(lower(v.change_reason),${trustedSql(P.p2)})>0 OR strpos(lower(v.change_reason),${trustedSql(P.p4)})>0
      OR (v.body_storage='segmented' AND ${trustedSql(SEGMENTED_VERSION_CARRIES)}))`);
  const [versions] = await raw<{ n: number }>(text, [sourceId, needle, escaped, reason]);
  return Number(versions?.n ?? 0);
}

/** planFactPurge: How many review queue, review proposal and decide proposal rows of the source name the facts (`refs` are the ids as text). Reads decide_review_queue, decide_review_proposals and decide_proposals. */
export async function countPurgeReviewRows(raw: EngineRawRead, sourceId: string, refs: string[], factIds: number[]): Promise<PurgeReviewCounts> {
  const [counts] = await raw<{ q: number; rp: number; dp: number }>(`SELECT
    (SELECT count(*)::int FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS q,
    (SELECT count(*)::int FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[]))) AS rp,
    (SELECT count(*)::int FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($3::bigint[]) OR old_fact_id=ANY($3::bigint[]))) AS dp`, [sourceId, refs, factIds]);
  return { decide_review_queue: Number(counts?.q ?? 0), decide_review_proposals: Number(counts?.rp ?? 0), decide_proposals: Number(counts?.dp ?? 0) };
}

/** factPurgeStreams: The distinct belief stream slugs (holding page, else entity) of the facts. Reads facts; run it in the purge transaction. */
export async function listPurgeStreamSlugs(raw: EngineRawRead, factIds: number[]): Promise<string[]> {
  return (await raw<{ slug: string }>(`SELECT DISTINCT COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts
    WHERE id = ANY($1::bigint[]) AND COALESCE(source_markdown_slug, entity_slug) IS NOT NULL`, [factIds])).map(f => f.slug);
}

/** assertNoPendingPublication: One unfinished write or withdrawal mirror (not the request `ownRequest`) on one of the pages, null for none. Reads persistence_requests and persistence_effects. */
export async function findPurgeBlockedPublication(raw: EngineRawRead, sourceId: string, slugs: string[], ownRequest: string): Promise<PurgeBlockedPublication | null> {
  const [blocked] = await raw<PurgeBlockedPublication>(`SELECT r.request_id::text,r.slug,r.state FROM persistence_requests r
      WHERE r.source_id=$1 AND r.id<>$3::uuid AND r.slug=ANY($2::text[]) AND (r.recovery IS NOT NULL OR r.state IN ('queued','deferred','running','recovering'))
    UNION ALL SELECT r.request_id::text,COALESCE(t->>'slug',r.slug),e.state FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.data->'targets','[]'::jsonb)) t
      WHERE e.source_id=$1 AND e.request_id<>$3::uuid AND e.kind='withdrawal-mirror' AND (e.state<>'committed' OR e.recovery IS NOT NULL) AND t->>'slug'=ANY($2::text[])
    LIMIT 1`, [sourceId, slugs, ownRequest]);
  return blocked ?? null;
}

/** rewritePageBodies: The source's pages with these ids, whole rows, each with its tags as `purge_tags`, in slug order. Reads pages and tags. */
export async function listPagesForPurgeRewrite(raw: EngineRawRead, sourceId: string, pageIds: number[]): Promise<Array<Record<string, unknown>>> {
  return raw<Record<string, unknown>>(`SELECT p.*,COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS purge_tags
    FROM pages p WHERE p.source_id=$1 AND p.id=ANY($2::int[]) ORDER BY p.slug COLLATE "C"`, [sourceId, pageIds]);
}

/** rewritePageBodies: Stores a page's body with the purged fence rows dropped, its content hash, and voids its text projection and embedding signature. Writes pages; run it in the purge transaction. */
export async function updatePageBodyForPurge(raw: EngineRawRead, sourceId: string, pageId: number, compiled: string, timeline: string, hash: string): Promise<void> {
  await raw(`UPDATE pages SET compiled_truth=$3,timeline=$4,content_hash=$5,updated_at=now(),text_projection_revision=NULL,embedding_signature=NULL
      WHERE source_id=$1 AND id=$2`, [sourceId, pageId, compiled, timeline, hash]);
}

/** rewriteVersionBodies: Stores a saved version's two body parts after the purge edit (a null timeline stays null). Writes page_versions; run it in the purge transaction. */
export async function setPurgeVersionBody(raw: EngineRawRead, versionId: number, compiled: string, timeline: string | null): Promise<void> {
  await raw(`UPDATE page_versions SET compiled_truth=$2,timeline=$3 WHERE id=$1`, [versionId, compiled, timeline]);
}

/** redactPageVersions: Overwrites the change reason of every saved version of the source's pages that quotes the claim (lowered plain form or folded reason form) with `[purged]`; the ids redacted. Writes page_versions. */
export async function redactVersionChangeReasons(raw: EngineRawRead, sourceId: string, needle: string, reasonNeedle: string): Promise<number[]> {
  return (await raw<{ id: number }>(`UPDATE page_versions v SET change_reason = '[purged]' FROM pages p
    WHERE p.id = v.page_id AND p.source_id = $1 AND (strpos(lower(v.change_reason), $2) > 0 OR strpos(lower(v.change_reason), $3) > 0) RETURNING v.id`, [sourceId, needle, reasonNeedle])).map(row => Number(row.id));
}

/** redactPageVersions: The next 5000 segmented saved versions of the source after id `after` that belong to one of the pages or whose generation holds the lowered claim, in id order. Reads page_versions, pages, page_body_manifest and page_segment_texts. */
export async function listSegmentedVersionsForPurge(raw: EngineRawRead, sourceId: string, needle: string, pageIds: number[], after: number): Promise<SegmentedVersionRow[]> {
  const { text } = renderFragment(sqlFragment`SELECT v.id,v.page_id,v.body_generation AS generation,p.slug,v.title,v.type,v.frontmatter,v.tags
      FROM page_versions v JOIN pages p ON p.id=v.page_id
      WHERE p.source_id=${trustedSql(P.p1)} AND v.body_storage='segmented' AND v.id>${trustedSql(P.p4)} AND (v.page_id=ANY(${trustedSql(P.p3)}::int[]) OR ${trustedSql(SEGMENTED_VERSION_CARRIES)})
      ORDER BY v.id LIMIT 5000`);
  return raw<SegmentedVersionRow>(text, [sourceId, needle, pageIds, after]);
}

/** purgeSegmentStorage: Aborts the uncommitted stagings with these ids; the page ids they belonged to (none for a staging with no page). Writes page_body_stagings; run it in the purge transaction. */
export async function abortPurgedStagings(raw: EngineRawRead, stagingIds: string[]): Promise<number[]> {
  return (await raw<{ page_id: number | null }>(`UPDATE page_body_stagings SET state='aborted',updated_at=now()
      WHERE id=ANY($1::uuid[]) AND state<>'committed' RETURNING page_id`, [stagingIds])).flatMap(row => row.page_id === null ? [] : [Number(row.page_id)]);
}

/** purgeSegmentStorage: Deletes the upload parts of these stagings; how many. Writes page_body_staging_parts; run it in the purge transaction. */
export async function deletePurgedStagingParts(raw: EngineRawRead, stagingIds: string[]): Promise<number> {
  return (await raw(`DELETE FROM page_body_staging_parts WHERE staging_id=ANY($1::uuid[]) RETURNING 1`, [stagingIds])).length;
}

/** purgeSegmentStorage: Deletes the cached read-view digests of these pages. Writes page_view_digests; run it in the purge transaction. */
export async function deletePageViewDigests(raw: EngineRawRead, pageIds: number[]): Promise<void> {
  await raw(`DELETE FROM page_view_digests WHERE page_id=ANY($1::int[])`, [pageIds]);
}

/** purgeSegmentStorage: Deletes the source's segment texts that no manifest row references and that were replaced by the purge (`replaced` are their sha256 digests) or hold the claim, plain or as a fence cell stores it; how many. Writes page_segment_texts; run it in the purge transaction. */
export async function deleteUnreferencedPurgedTexts(raw: EngineRawRead, sourceId: string, replaced: Uint8Array[], claim: string): Promise<number> {
  return (await raw(`DELETE FROM page_segment_texts d WHERE (d.source_id,d.sha256) IN (SELECT t.source_id,t.sha256 FROM page_segment_texts t
      WHERE t.source_id=$1 AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) OFFSET 0)
    AND (d.sha256=ANY(SELECT decode(h,'hex') FROM unnest($2::text[]) AS h) OR strpos(lower(convert_from(d.body,'UTF8')),$3)>0
      OR strpos(lower(convert_from(d.body,'UTF8')),$4)>0) RETURNING 1`, [sourceId, replaced.map(sha => Buffer.from(sha).toString('hex')), claim.toLowerCase(), escapeFenceCell(claim).toLowerCase()])).length;
}

/** matchCandidates: The first 25 facts of the source whose text contains `text` (case folded), in id order, each cut to 160 characters. Reads facts. */
export async function listPurgeMatchCandidates(raw: EngineRawRead, sourceId: string, text: string): Promise<PurgeMatchRow[]> {
  return raw<PurgeMatchRow>(`SELECT id,entity_slug,visibility,
    expired_at IS NOT NULL AS expired,left(fact,160) AS fact FROM facts WHERE source_id=$1 AND strpos(lower(fact),lower($2))>0 ORDER BY id LIMIT 25`, [sourceId, text]);
}

/** submitPurgeFactMutation: Locks the source row for the purge transaction and returns its incarnation and archived flag, null for no such source. Reads sources; run it in the purge transaction. */
export async function lockPurgeSource(raw: EngineRawRead, sourceId: string): Promise<PurgeSourceLock | null> {
  const [source] = await raw<PurgeSourceLock>(`SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE`, [sourceId]);
  return source ?? null;
}

/** submitPurgeFactMutation: Stores a purge tombstone for each holding page that holds one of the facts about an entity with no page of its own, none twice. Writes fact_purges; run it in the purge transaction. */
export async function insertHoldingPagePurges(raw: EngineRawRead, sourceId: string, visibility: string, factHash: string, requestId: string, actor: string, reason: string | null, factIds: number[]): Promise<void> {
  const { text } = renderFragment(sqlFragment`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason)
        SELECT DISTINCT ${trustedSql(P.p1)}::text,${trustedSql(P.p2)}::text,f.source_markdown_slug,${trustedSql(P.p3)}::text,${trustedSql(P.p4)}::uuid,${trustedSql(P.p5)}::text,${trustedSql(P.p6)}::text FROM facts f
          WHERE f.id=ANY(${trustedSql(P.p7)}::bigint[]) AND f.source_id=${trustedSql(P.p1)} AND ${trustedSql(holdingSlugSql('f.source_markdown_slug'))} AND f.entity_slug IS NOT NULL ON CONFLICT DO NOTHING`);
  await raw(text, [sourceId, visibility, factHash, requestId, actor, reason, factIds]);
}

/** submitPurgeFactMutation: Deletes the takes with these ids; how many. Writes takes; run it in the purge transaction. */
export async function deletePurgedTakes(raw: EngineRawRead, takeIds: number[]): Promise<number> {
  return (await raw(`DELETE FROM takes WHERE id=ANY($1::bigint[]) RETURNING id`, [takeIds])).length;
}

/** submitPurgeFactMutation: Deletes the source's review queue rows naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_queue; run it in the purge transaction. */
export async function deletePurgeReviewQueue(raw: EngineRawRead, sourceId: string, refs: string[]): Promise<number> {
  return (await raw(`DELETE FROM decide_review_queue WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1`, [sourceId, refs])).length;
}

/** submitPurgeFactMutation: Deletes the source's review proposals naming one of the facts (`refs` are the ids as text); how many. Writes decide_review_proposals; run it in the purge transaction. */
export async function deletePurgeReviewProposals(raw: EngineRawRead, sourceId: string, refs: string[]): Promise<number> {
  return (await raw(`DELETE FROM decide_review_proposals WHERE source_id=$1 AND (a_ref=ANY($2::text[]) OR b_ref=ANY($2::text[])) RETURNING 1`, [sourceId, refs])).length;
}

/** submitPurgeFactMutation: Deletes the source's decide proposals that supersede or are superseded by one of the facts; how many. Writes decide_proposals; run it in the purge transaction. */
export async function deletePurgeDecideProposals(raw: EngineRawRead, sourceId: string, factIds: number[]): Promise<number> {
  return (await raw(`DELETE FROM decide_proposals WHERE source_id=$1 AND (new_fact_id=ANY($2::bigint[]) OR old_fact_id=ANY($2::bigint[])) RETURNING 1`, [sourceId, factIds])).length;
}

/** submitPurgeFactMutation: Deletes the source's trust proposals whose target or related row is one of the facts or takes; how many. Writes trust_proposals; run it in the purge transaction. */
export async function deletePurgeTrustProposals(raw: EngineRawRead, sourceId: string, factIds: number[], takeIds: number[]): Promise<number> {
  return (await raw(`DELETE FROM trust_proposals WHERE source_id=$1 AND ((target_table='facts' AND target_id=ANY($2::bigint[])) OR (related_table='facts' AND related_id=ANY($2::bigint[]))
            OR (target_table='takes' AND target_id=ANY($3::bigint[])) OR (related_table='takes' AND related_id=ANY($3::bigint[]))) RETURNING 1`, [sourceId, factIds, takeIds])).length;
}

/** submitPurgeFactMutation: Deletes the source's open loops on one of the facts; how many. Writes open_loops; run it in the purge transaction. */
export async function deletePurgeOpenLoops(raw: EngineRawRead, sourceId: string, factIds: number[]): Promise<number> {
  return (await raw(`DELETE FROM open_loops WHERE source_id=$1 AND fact_id=ANY($2::bigint[]) RETURNING 1`, [sourceId, factIds])).length;
}

/** submitPurgeFactMutation: Deletes the source's held writes whose fact or claim text has the fingerprint; the ids deleted. Writes write_gate_holds; run it in the purge transaction. */
export async function deletePurgeWriteGateHolds(raw: EngineRawRead, sourceId: string, factHash: string): Promise<string[]> {
  return (await raw<{ id: string }>(`DELETE FROM write_gate_holds WHERE source_id=$1
          AND gbrain_fact_fingerprint(COALESCE(payload->>'fact', payload->>'claim', ''))=$2 RETURNING id::text AS id`, [sourceId, factHash])).map(r => r.id);
}

/** submitPurgeFactMutation: Deletes the gate receipts that name one of the facts, takes or held writes (ids as text); how many. Writes write_gate_receipts; run it in the purge transaction. */
export async function deletePurgeWriteGateReceipts(raw: EngineRawRead, factIds: string[], takeIds: string[], holdIds: string[]): Promise<number> {
  return (await raw(`DELETE FROM write_gate_receipts WHERE (target_table='facts' AND target_id=ANY($1::text[]))
          OR (target_table='takes' AND target_id=ANY($2::text[])) OR (target_table='write_gate_holds' AND target_id=ANY($3::text[])) RETURNING 1`, [factIds, takeIds, holdIds])).length;
}

/** submitPurgeFactMutation: Deletes the source's take proposals whose claim text has the fingerprint; how many. Writes take_proposals; run it in the purge transaction. */
export async function deletePurgeTakeProposals(raw: EngineRawRead, sourceId: string, factHash: string): Promise<number> {
  return (await raw(`DELETE FROM take_proposals WHERE source_id=$1 AND gbrain_fact_fingerprint(claim_text)=$2 RETURNING 1`, [sourceId, factHash])).length;
}

/** submitPurgeFactMutation: Blanks the base text of the source's core edit notices that quote the lowered fact; how many. Writes core_edit_notices; run it in the purge transaction. */
export async function blankPurgeCoreEditNotices(raw: EngineRawRead, sourceId: string, loweredFact: string): Promise<number> {
  return (await raw(`UPDATE core_edit_notices SET base_text=NULL WHERE source_id=$1 AND strpos(lower(base_text),$2)>0 RETURNING 1`, [sourceId, loweredFact])).length;
}

/** submitPurgeFactMutation: Deletes the facts with these ids from the source; how many. Writes facts; run it in the purge transaction. */
export async function deletePurgedFacts(raw: EngineRawRead, factIds: number[], sourceId: string): Promise<number> {
  return (await raw(`DELETE FROM facts WHERE id=ANY($1::bigint[]) AND source_id=$2 RETURNING id`, [factIds, sourceId])).length;
}

/** submitPurgeFactMutation: Deletes the chunks of these pages and voids the text projection that certified them; how many pages had chunks deleted. Writes content_chunks and pages; run it in the purge transaction. */
export async function deletePurgedChunks(raw: EngineRawRead, pageIds: number[]): Promise<number> {
  return (await raw(`WITH gone AS (DELETE FROM content_chunks WHERE page_id=ANY($1::integer[]) RETURNING page_id),
        unsealed AS (UPDATE pages SET text_projection_revision=NULL WHERE id IN (SELECT page_id FROM gone) AND text_projection_revision IS NOT NULL)
        SELECT 1 FROM gone`, [pageIds])).length;
}

/** submitPurgeFactMutation: The id, slug and knowledge revision of the source's pages with these ids, in slug order. Reads pages. */
export async function listPurgedPageRevisions(raw: EngineRawRead, sourceId: string, pageIds: number[]): Promise<PurgedPageRevision[]> {
  return raw<PurgedPageRevision>(`SELECT id,slug,knowledge_revision::text AS knowledge_revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug COLLATE "C"`, [sourceId, pageIds]);
}

/** submitPurgeFactMutation: Queues the withdrawal-mirror, git and embedding effects of the purge request under the source's current incarnation and worktree binding, none twice; `data` is the effect payload. Writes persistence_effects; run it in the purge transaction. */
export async function insertPurgeEffects(raw: EngineRawRead, requestId: string, sourceId: string, data: unknown): Promise<void> {
  await raw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
        SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
        FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
        CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
        WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`, [requestId, sourceId, JSON.stringify(data)]);
}
