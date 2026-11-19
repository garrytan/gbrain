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
import { derivationClaimCandidateSql, derivationHoldsClaimSql, derivationSweepScopeSql } from '../page-body/schema.ts';
import type { IntentRedactionTarget } from '../persistence/intent-redaction.ts';
import type { WriteRequest } from '../persistence/model.ts';
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

/** recordReasonTombstones: records each (commit, path) pair, none twice; the number added. */
export async function insertReasonPurgeTombstones(raw: EngineRawRead, sourceId: string, commits: string[], paths: string[]): Promise<number> {
  return (await raw(`INSERT INTO reason_purge_tombstones(source_id, commit_sha, path)
    SELECT $1, t.c, t.p FROM unnest($2::text[], $3::text[]) AS t(c, p) ON CONFLICT DO NOTHING RETURNING 1`,
  [sourceId, commits, paths])).length;
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
export async function listHeldFactRows(raw: EngineRawRead, sourceId: string): Promise<HeldFactRow[]> {
  const { text } = renderFragment(sqlFragment`SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to, true AS page_exists, source_markdown_slug AS from_slug
       FROM facts f WHERE ${onHolding} AND f.expired_at IS NULL ORDER BY f.source_markdown_slug, f.entity_slug, f.id`);
  return raw<HeldFactRow>(text, [sourceId]);
}

/** planHeldMoves: the struck held rows, one per holding page and row number; a row an active fact reuses is not struck. */
export async function listStruckHeldRows(raw: EngineRawRead, sourceId: string): Promise<StruckHeldRow[]> {
  const { text } = renderFragment(sqlFragment`SELECT DISTINCT ON (f.source_markdown_slug, f.row_num) f.source_markdown_slug AS from_slug, f.entity_slug, f.row_num, f.fact FROM facts f
      WHERE ${onHolding} AND f.expired_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM facts a WHERE a.source_id = f.source_id
        AND a.source_markdown_slug = f.source_markdown_slug AND a.row_num = f.row_num AND a.expired_at IS NULL)
      ORDER BY f.source_markdown_slug, f.row_num, f.id DESC`);
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
  return raw<{ id: number; similarity: number; contains_claim: boolean }>(`SELECT id,(1-(embedding <=> $1::halfvec))::float8 AS similarity,
        strpos(gbrain_fact_normalize(fact),gbrain_fact_normalize($4))>0 AS contains_claim
      FROM facts WHERE source_id=$2 AND embedding_model=$3 AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::halfvec LIMIT 5`, [embedding, sourceId, model, fact]);
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
  pages: `SELECT DISTINCT p.slug FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(p.compiled_truth),n)>0 OR strpos(lower(COALESCE(p.timeline,'')),n)>0) ORDER BY 1 LIMIT 20`,
  content_chunks: `SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(c.chunk_text),n)>0) ORDER BY 1 LIMIT 20`,
  page_versions: `SELECT DISTINCT p.slug FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(v.compiled_truth),n)>0 OR strpos(lower(COALESCE(v.timeline,'')),n)>0) ORDER BY 1 LIMIT 20`,
  timeline_entries: `SELECT DISTINCT p.slug FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(t.summary),n)>0 OR strpos(lower(COALESCE(t.detail,'')),n)>0) ORDER BY 1 LIMIT 20`,
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

/** pageReceipt: the newest delete_page request with this request id, null for none. */
export async function readDeletePageRequest(raw: EngineRawRead, sourceId: string, requestId: string): Promise<DeletePageRequestRow | null> {
  const [row] = await raw<DeletePageRequestRow>(`SELECT id,request_id,state,source_id,outcome FROM persistence_requests
    WHERE source_id=$1 AND request_id=$2::uuid AND operation='delete_page' ORDER BY created_at DESC LIMIT 1`, [sourceId, requestId]);
  return row ?? null;
}

/** purgeCompletion: the request's effects in kind order, each with whether any target is parked. */
export async function listPurgeEffects(raw: EngineRawRead, requestId: string): Promise<Array<{ kind: string; state: string; error_code: string | null; parked: boolean }>> {
  return raw<{ kind: string; state: string; error_code: string | null; parked: boolean }>(`SELECT kind,state,error_code,
    jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 AS parked FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind`, [requestId]);
}

/** purgeCompletion: the facts and takes that still carry the purged claim's fingerprint under `subject` ('*' for any), outcome markers apart. */
export async function countPurgeFingerprintResidue(raw: EngineRawRead, sourceId: string, factHash: string, subject: string): Promise<{ facts: number; takes: number }> {
  const { text } = renderFragment(sqlFragment`SELECT
      (SELECT count(*)::int FROM facts WHERE source_id=${trustedSql(P.p1)} AND gbrain_fact_fingerprint(fact)=${trustedSql(P.p2)} AND (${trustedSql(P.p3)}='*' OR entity_slug=${trustedSql(P.p3)}) AND NOT ${trustedSql(outcomeMarkerSql('facts'))}) AS facts,
      (SELECT count(*)::int FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=${trustedSql(P.p1)} AND gbrain_fact_fingerprint(k.claim)=${trustedSql(P.p2)} AND (${trustedSql(P.p3)}='*' OR p.slug=${trustedSql(P.p3)})) AS takes`);
  const [probe] = await raw<{ facts: number; takes: number }>(text, [sourceId, factHash, subject]);
  return { facts: Number(probe?.facts ?? 0), takes: Number(probe?.takes ?? 0) };
}
