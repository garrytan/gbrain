/**
 * Group 5 facts statements, search relevance and trust reads (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved. The facts read-policy builders the search pool shares with its
 * remaining raw reads (`poolWhere`, `FactPoolScope`, `FactPoolFilters`) live here too: search/fact-relevance.ts renders them.
 */
import type { TrustTier } from '../trust/tier.ts';
import { TRUST_TIER_RANK, trustRankSql } from '../trust/tier.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';
import { PAGE_EXTRACTION_SOURCE_LIST, contextHeadSql } from '../facts/gone-page-facts.ts';
import { factsFtsDocument, getFtsLanguage } from '../fts-language.ts';
import { privateFactFilterForReader, privateProvenanceFilterUnderPolicy } from '../search/private-visibility.ts';
import { factVisibilitySql, grantedPrivateFactSql, onOwnedMemoryPageSql, withdrawalCoversFactSql } from '../access/member-facts.ts';
import { quarantinedProvenanceFilterFragment } from '../quarantine.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { claimPendingSql } from '../trust/claim-state.ts';
import { escapeLikePattern } from '../cjk.ts';
import { SAVED_FACT_COLLAPSE_COLUMNS, type CollapseColumns } from '../search/saved-fact-collapse.ts';
import type { SavedFactMatch } from '../search/saved-facts-match.ts';
import { renderFragment, sqlFragment, trustedSql, joinFragments, type SqlFragment } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** Runs `fn` in one transaction on the engine's own executeRaw (the keyword arm pins a custom plan inside it). */
export type EngineRawTransaction = <T>(fn: (raw: EngineRawRead) => Promise<T>) => Promise<T>;

export interface FactPoolScope {
  sourceId?: string; sourceIds?: string[];
  /** World-only facts: worldOnlyFacts(remote) for the caller (private facts only for the local CLI and the brain owner). */
  worldOnly: boolean;
  /** #5575 read floor and activation control, applied in the pool SQL like every retrieval arm. */
  minTrust?: TrustTier; suppressFlagged?: boolean;
  /** Hide facts whose provenance page is private (resolveExcludePrivatePages for the caller). */
  excludePrivate: boolean;
}

/** recall's fact filters, applied inside every arm before its LIMIT. */
export interface FactPoolFilters {
  /** (source_id, entity_slug) pairs the entity resolved to, one per source. */
  entities?: Array<{ sourceId: string; slug: string }>;
  sessionId?: string;
  /** Event time, COALESCE(valid_from, created_at). */
  since?: Date;
  grep?: string;
  /** Also pool expired, superseded and lapsed facts (recall's `include_expired`). */
  includeExpired?: boolean;
}

// The vetted builders below are named in scripts/check-engine-sql-dynamic.ts: each wraps one constant fragment.
function pageExtractionSources(): readonly string[] { return PAGE_EXTRACTION_SOURCE_LIST; }
function conversationSlotSql(): string { return CONVERSATION_SLOT_SQL; }
function savedFactCollapseColumns(): string { return SAVED_FACT_COLLAPSE_COLUMNS; }
function factsAuditSources(): string[] { return [...AUDIT_ROW_SOURCES]; }

/** The columns every pool arm returns, in this order. */
export const FACT_POOL_COLUMNS = 'f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period, f.source_markdown_slug, f.visibility, f.attributed_to, f.dimension, f.value_hash';

/**
 * The pool's WHERE clause as one fragment: the caller's read policy plus the filters. `search/fact-relevance.ts`
 * renders it (`poolPredicate`) for its arms that still run through executeRaw; the placeholders number the same way.
 */
export function poolWhere(scope: FactPoolScope, filters: FactPoolFilters | undefined): SqlFragment {
  const sources = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'];
  const clauses: SqlFragment[] = [
    filters?.includeExpired
      ? sqlFragment`f.source_id = ANY(${sources}::text[])`
      : sqlFragment`f.source_id = ANY(${sources}::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL`,
    filters?.includeExpired
      ? sqlFragment`f.source != ALL(${factsAuditSources()}::text[])`
      : sqlFragment`(f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL(${factsAuditSources()}::text[])`,
    sqlFragment`${trustedSql(quarantinedProvenanceFilterFragment('f'))}`,
    ...(scope.worldOnly ? [sqlFragment`${trustedSql(factVisibilitySql('f', ['world']))}`] : []),
    ...(scope.excludePrivate ? [sqlFragment`${trustedSql(privateProvenanceFilterUnderPolicy('f'))}`] : []),
    sqlFragment`${trustedSql(projectionEligibleSql('facts', 'f', { floor: scope.minTrust, suppressFlagged: scope.suppressFlagged }))}`,
  ];
  if (filters?.entities) {
    clauses.push(sqlFragment`(f.source_id, f.entity_slug) IN (SELECT * FROM unnest(${filters.entities.map(e => e.sourceId)}::text[], ${filters.entities.map(e => e.slug)}::text[]))`);
  }
  if (filters?.sessionId) clauses.push(sqlFragment`f.source_session = ${filters.sessionId}`);
  if (filters?.since) clauses.push(sqlFragment`COALESCE(f.valid_from, f.created_at) >= ${filters.since.toISOString()}::text::timestamptz`);
  if (filters?.grep?.trim()) clauses.push(sqlFragment`f.fact ILIKE ${`%${escapeLikePattern(filters.grep.trim())}%`} ESCAPE '\\'`);
  return joinFragments(clauses, ' AND ');
}

/**
 * An ended fact a history read may show: superseded by a successor, or closed by a valid_until in the past while still
 * unexpired. A fact expired with no successor (forgotten or withdrawn) never matches, nor does any fact whose claim the
 * withdrawal ledger covers, nor one whose page a purge removed: a purge expires only the page's unexpired facts
 * (gone-page-facts.ts), so a superseded fact filed on or extracted from that page would otherwise come back. Only an
 * ontology observation's page is provenance; a conversation fact's slot (GBRA-574 B2) is filed on its page.
 */
function endedFactSql(): SqlFragment {
  return sqlFragment`(f.superseded_by IS NOT NULL OR (f.expired_at IS NULL AND f.valid_until <= now()))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
    AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact)) AND ${trustedSql(withdrawalCoversFactSql('w', 'f'))})
  AND (f.source_markdown_slug IS NULL OR (f.dimension IS NOT NULL AND NOT ${trustedSql(conversationSlotSql())})
    OR EXISTS (SELECT 1 FROM pages hp WHERE hp.source_id = f.source_id AND hp.slug = f.source_markdown_slug))
  AND (f.source_markdown_slug IS NOT NULL OR f.source <> ALL(${[...pageExtractionSources()]}::text[])
    OR EXISTS (SELECT 1 FROM pages hp WHERE hp.source_id = f.source_id AND hp.slug = ${trustedSql(contextHeadSql('f'))}))`;
}

/** The comparable-embedding predicate: same model, current text hash, same dimensions. */
function comparable(model: string, dims: number | null): SqlFragment {
  return sqlFragment`f.embedding IS NOT NULL AND f.embedding_model = ${model} AND f.embedded_text_hash = md5(f.fact)${dims === null ? sqlFragment`` : sqlFragment` AND vector_dims(f.embedding) = ${dims}`}`;
}

/** The query embedding a relevance read scores every row against: its literal, its column type and the model and dimensions it must match. */
export interface RelevanceVector { literal: string; type: 'vector' | 'halfvec'; model: string; dims: number }

/** Which pool arm a `listFactsForRelevance` read runs. */
export type RelevanceArm = 'keyword' | 'entity' | 'entity_ended';

export interface FactRelevanceQuery {
  arm: RelevanceArm;
  scope: FactPoolScope;
  filters?: FactPoolFilters;
  /** Set to score every row's cosine (recall and the reserve); null leaves `similarity` NULL. */
  vector: RelevanceVector | null;
  /** The keyword arm's search terms, space separated. */
  terms?: string;
  /** The entity arms' named entity. */
  entity?: { sourceId: string; slug: string };
  limit: number;
}

export interface FactRelevanceRow {
  id: number; fact: string; kind: string; entity_slug: string | null; source_id: string; source: string;
  valid_from: Date | string; valid_until: Date | string | null; created_at: Date | string | null;
  claim_metric: string | null; claim_period: string | null; source_markdown_slug: string | null; visibility: string;
  attributed_to: unknown; dimension: string | null; value_hash: string | null;
  similarity: number | null;
}

function similarity(vector: RelevanceVector | null): SqlFragment {
  if (!vector) return sqlFragment`NULL::float8 AS similarity`;
  const cast = vector.type === 'halfvec' ? '::halfvec' : '::vector';
  return sqlFragment`CASE WHEN ${comparable(vector.model, vector.dims)} THEN 1 - (f.embedding <=> ${vector.literal}${trustedSql(cast)}) END AS similarity`;
}

/**
 * Run with a custom plan per call. A cached generic plan (PGLite reuses named
 * statements) cannot see the source arrays, estimates one matching fact and
 * nests the policy anti-joins over every match: about 9x slower at 100k facts.
 */
function customPlan<T>(transaction: EngineRawTransaction, fragment: SqlFragment): Promise<T[]> {
  const { text, params } = renderFragment(fragment);
  return transaction(async raw => {
    await raw('SET LOCAL plan_cache_mode = force_custom_plan');
    return raw<T>(text, params);
  });
}

/**
 * The pool's candidate rows of one arm: the keyword arm (full-text over the fact and its entity name, best rank
 * first, under a custom plan), the named entity's active facts, or that entity's ended facts (history), newest first.
 * Every arm reads under the caller's read policy and filters, and `similarity` is the row's cosine to `vector` when
 * the row's embedding is comparable with it.
 */
export async function listFactsForRelevance(raw: EngineRawRead, transaction: EngineRawTransaction, q: FactRelevanceQuery): Promise<FactRelevanceRow[]> {
  const sim = similarity(q.vector);
  if (q.arm === 'keyword') {
    const doc = trustedSql(factsFtsDocument('f'));
    const tsq = sqlFragment`NULLIF(replace(plainto_tsquery('${trustedSql(getFtsLanguage())}'::regconfig, ${q.terms ?? ''})::text, ' & ', ' | '), '')::tsquery`;
    return customPlan<FactRelevanceRow>(transaction, sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)}, ${sim} FROM facts f WHERE ${poolWhere(q.scope, q.filters)} AND ${doc} @@ ${tsq}
       ORDER BY ts_rank_cd(${doc}, ${tsq}) DESC, f.valid_from DESC, f.id DESC LIMIT ${q.limit}`);
  }
  const named = q.entity!;
  const { text, params } = renderFragment(q.arm === 'entity'
    ? sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)}, ${sim} FROM facts f WHERE ${poolWhere(q.scope, q.filters)} AND f.source_id = ${named.sourceId} AND f.entity_slug = ${named.slug}
       ORDER BY f.valid_from DESC, f.id DESC LIMIT ${q.limit}`
    : sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)}, ${sim} FROM facts f WHERE ${poolWhere(q.scope, { ...q.filters, includeExpired: true })} AND ${endedFactSql()} AND f.source_id = ${named.sourceId} AND f.entity_slug = ${named.slug}
       ORDER BY f.valid_from DESC, f.id DESC LIMIT ${q.limit}`);
  return raw<FactRelevanceRow>(text, params);
}

export interface UncomparableFactsQuery {
  scope: FactPoolScope;
  filters?: FactPoolFilters;
  /** The query embedding's dimensions, and the model its rows must carry. */
  dims: number;
  model: string;
  /** Whether the facts embedding column declares exactly `dims`. */
  declared: boolean;
}

/**
 * Facts in the same authorized, filtered pool that the cosine arm cannot compare (no vector, another model, a stale
 * text hash or other dimensions), per source, the most first. Cheap candidates first (idx_facts_unembedded,
 * idx_facts_embedding_model), then the read policy on those rows only.
 */
export async function countUncomparableFacts(raw: EngineRawRead, transaction: EngineRawTransaction, q: UncomparableFactsQuery): Promise<Array<{ source_id: string; n: number }>> {
  const sources = q.scope.sourceIds?.length ? q.scope.sourceIds : [q.scope.sourceId ?? 'default'];
  const active = trustedSql(q.filters?.includeExpired ? '' : ' AND f.expired_at IS NULL');
  const uncomparable = q.declared
    ? sqlFragment`SELECT f.id FROM facts f WHERE f.source_id = ANY(${sources}::text[])${active} AND (f.embedding IS NULL OR f.embedded_text_hash IS DISTINCT FROM md5(f.fact))
       UNION SELECT f.id FROM facts f WHERE f.source_id = ANY(${sources}::text[])${active} AND (f.embedding_model IS NULL OR f.embedding_model < ${q.model} OR f.embedding_model > ${q.model})`
    : sqlFragment`SELECT f.id FROM facts f WHERE f.source_id = ANY(${sources}::text[])${active} AND NOT (${comparable(q.model, q.dims)})`;
  const rows = await customPlan<{ source_id: string; n: number | string }>(transaction,
    sqlFragment`WITH u AS MATERIALIZED (${uncomparable})
     SELECT f.source_id, count(*) AS n FROM facts f WHERE f.id IN (SELECT id FROM u) AND ${poolWhere(q.scope, q.filters)}
     GROUP BY f.source_id ORDER BY count(*) DESC, f.source_id COLLATE "C"`);
  return rows.map(r => ({ source_id: r.source_id, n: Number(r.n) }));
}

/** What `matchSavedFacts` reads, decided by the caller: its words, the CJK substring patterns, and the read policy it already resolved. */
export interface SavedFactsMatchQuery {
  sources: string[];
  terms: string[];
  /** One LIKE pattern per term, null for a term that is not CJK. */
  pats: Array<string | null>;
  /** The correction-cue regex (saved-facts-match.ts CORRECTION_CUE). */
  cue: string;
  supersede: boolean;
  excludePrivate: boolean;
  worldOnly: boolean;
  minTrust?: TrustTier;
}

export type SavedFactMatchRow = SavedFactMatch & CollapseColumns
  & { at: unknown; matched: unknown[]; need: unknown; cue: boolean; trust_rank: unknown; pool_rank: unknown };

/**
 * The keyword scan behind a `search` / `query` saved-facts block: active facts that share the query's words, matched as
 * stemmed whole words (CJK words as substrings), with the match count, the matched word indexes, the trust rank and the
 * correction-cue flag the caller orders and decides corrections on. The threshold is applied before the cut so a fact
 * matching every word is never crowded out by newer facts that match fewer; cue rows below it rank in a pool of their own.
 */
export async function matchSavedFacts(raw: EngineRawRead, q: SavedFactsMatchQuery): Promise<SavedFactMatchRow[]> {
  const lang = trustedSql(getFtsLanguage());
  const doc = trustedSql(factsFtsDocument('f'));
  const active = sqlFragment`f.source_id = ANY(${q.sources}::text[])
         AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
         AND f.source != ALL(${factsAuditSources()}::text[])
         ${q.worldOnly ? sqlFragment`AND (f.visibility = 'world' OR ${trustedSql(grantedPrivateFactSql('f'))})` : sqlFragment``}`;
  const eligible = sqlFragment`${q.excludePrivate ? sqlFragment`AND ${trustedSql(privateFactFilterForReader('f', true))}` : sqlFragment``}
         AND ${trustedSql(projectionEligibleSql('facts', 'f', { floor: q.minTrust }))}`;
  const keywordScan = q.pats.some(Boolean)
    ? sqlFragment`(${doc} @@ k.anyq OR lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) LIKE ANY(k.pats))`
    : sqlFragment`${doc} @@ k.anyq`;
  const { text, params } = renderFragment(sqlFragment`WITH w AS (
         SELECT t.i, t.pat, plainto_tsquery('${lang}'::regconfig, t.term) AS tq
         FROM unnest(${q.terms}::text[], ${q.pats}::text[]) WITH ORDINALITY AS t(term, pat, i)
         WHERE t.pat IS NOT NULL OR numnode(plainto_tsquery('${lang}'::regconfig, t.term)) > 0
       ), k AS (
         SELECT count(*)::int AS n,
           NULLIF(string_agg('(' || tq::text || ')', ' | ') FILTER (WHERE pat IS NULL), '')::tsquery AS anyq,
           COALESCE(array_agg(pat) FILTER (WHERE pat IS NOT NULL), '{}') AS pats
         FROM w
       )
       SELECT * FROM (SELECT m.*, row_number() OVER (PARTITION BY m.cue AND cardinality(m.matched) < m.need ORDER BY cardinality(m.matched) DESC, m.at DESC, m.id DESC) AS pool_rank FROM (
         SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source, f.valid_from AS at, ${trustedSql(savedFactCollapseColumns())},
           ARRAY(SELECT w.i FROM w, (SELECT ${doc} AS d OFFSET 0) x WHERE CASE WHEN w.pat IS NOT NULL THEN lower(f.fact || ' ' || COALESCE(f.entity_slug, '')) LIKE w.pat
             ELSE x.d @@ w.tq END ORDER BY w.i) AS matched,
           LEAST(4, GREATEST(LEAST(2, k.n), ceil(k.n * 0.75)::int)) AS need,
           (${q.supersede}::boolean AND f.fact ~* ${q.cue}) AS cue, ${trustedSql(trustRankSql('f.trust_tier'))} AS trust_rank
         FROM facts f, k
         WHERE ${active}
           ${eligible}
           AND ${keywordScan}
           AND EXISTS (SELECT 1 FROM facts f WHERE ${active} LIMIT 1)
       ) m
       WHERE cardinality(m.matched) >= CASE WHEN m.cue THEN LEAST(2, m.need) ELSE m.need END) p
       WHERE p.pool_rank <= 200
       ORDER BY cardinality(p.matched) DESC, p.at DESC, p.id DESC`);
  return raw<SavedFactMatchRow>(text, params);
}

/** One fact row as the owner-action preview binds it: the 16 columns the binding hashes, with its stored tier. */
export type OwnerActionFactRow = Record<string, unknown>;

/** The fact an owner action (confirm, release) targets, or null when no fact has the id. */
export async function readFactForOwnerAction(raw: EngineRawRead, id: number): Promise<OwnerActionFactRow | null> {
  const [row] = await raw<OwnerActionFactRow>(
    `SELECT id, source_id, trust_tier, fact, entity_slug, kind, claim_metric, claim_value, claim_unit, claim_period, value, event_type, dimension, context,
            expired_at, superseded_by FROM facts WHERE id = $1`, [id]);
  return row ?? null;
}

export interface StandingPreferenceRow { id: number; source_id: string; kind: string; fact: string; trust_tier: string; slug: string | null; created_at: string }

/**
 * The unconfirmed standing preferences and commitments awaiting the owner: active facts the write gate flagged as a
 * standing instruction (write_gate_receipts), at an agent, unknown or external tier, outside a claim still being lifted.
 * The caller probes that write_gate_receipts exists first.
 */
export async function listStandingPreferences(raw: EngineRawRead, opts: { sourceId?: string; since?: Date }): Promise<StandingPreferenceRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.id, f.source_id, f.kind, f.fact, f.trust_tier, f.source_markdown_slug AS slug, f.created_at FROM facts f
      WHERE f.kind IN ('preference', 'commitment') AND f.trust_tier IN ('agent_written', 'unknown', 'external_untrusted') AND f.expired_at IS NULL
        AND NOT (f.trust_tier = 'unknown' AND EXISTS (SELECT 1 FROM sources cs WHERE cs.id = f.source_id AND ${trustedSql(claimPendingSql('cs'))}))
        AND (${opts.sourceId ?? null}::text IS NULL OR f.source_id = ${opts.sourceId ?? null}) AND (${opts.since?.toISOString() ?? null}::timestamptz IS NULL OR f.created_at >= ${opts.since?.toISOString() ?? null})
        AND EXISTS (SELECT 1 FROM write_gate_receipts r WHERE r.target_table = 'facts' AND r.target_id = f.id::text
                      AND r.verdict = 'flag' AND 'standing_instruction' = ANY(r.reason_families))
      ORDER BY f.created_at, f.id LIMIT 1000`);
  return raw<StandingPreferenceRow>(text, params);
}

/** Candidates the keyless conflict slot compares: active facts about the entity, kind and visibility that are more trusted than the writer. */
export async function listLexicalContestCandidates(raw: EngineRawRead,
  opts: { sourceId: string; entitySlug: string; kind: string; visibility: string; pageSlug?: string; writer: TrustTier }): Promise<Array<{ id: number; fact: string; trust_tier: string }>> {
  // GST-359 C2: a member's fact contests only facts on its own member page; no other write contests one there.
  const page = opts.pageSlug
    ? sqlFragment`source_markdown_slug = ${opts.pageSlug}`
    : sqlFragment`(${null as string | null}::text IS NULL AND NOT ${trustedSql(onOwnedMemoryPageSql('facts'))})`;
  const { text, params } = renderFragment(sqlFragment`SELECT id, fact, trust_tier FROM facts WHERE source_id = ${opts.sourceId} AND entity_slug = ${opts.entitySlug} AND kind = ${opts.kind} AND visibility = ${opts.visibility}
       AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND ${trustedSql(trustRankSql('trust_tier'))} > ${TRUST_TIER_RANK[opts.writer] ?? 0}::int
       AND ${page}
     ORDER BY id DESC LIMIT 200`);
  return raw(text, params);
}

/**
 * The active non-world fact of `sourceId` on entity `entity` stating exactly `claim`, more trusted than `writer`, while no
 * active world fact on that entity states it (GST-2891: a world copy the writer saved on another entity does not lift the hold).
 */
export async function listRestatedPrivateCopies(raw: EngineRawRead,
  opts: { sourceId: string; claim: string; entity: string | null; writer: TrustTier }): Promise<Array<{ id: number; visibility: string; trust_tier: string }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.id, f.visibility, f.trust_tier FROM facts f WHERE f.source_id = ${opts.sourceId} AND f.fact = ${opts.claim} AND f.visibility <> 'world'
       AND f.entity_slug IS NOT DISTINCT FROM ${opts.entity}::text AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND ${trustedSql(trustRankSql('f.trust_tier'))} > ${TRUST_TIER_RANK[opts.writer] ?? 0}::int
       AND NOT EXISTS (SELECT 1 FROM facts w WHERE w.source_id = ${opts.sourceId} AND w.fact = ${opts.claim} AND w.visibility = 'world' AND w.expired_at IS NULL
         AND w.entity_slug IS NOT DISTINCT FROM ${opts.entity}::text
         AND (w.valid_until IS NULL OR w.valid_until > now()))
     ORDER BY f.id LIMIT 1`);
  return raw(text, params);
}

/** How many facts carry `taint_inputs` in their write origin, and how many of those are stamped external_untrusted. */
export async function countDerivedFactTaint(raw: EngineRawRead): Promise<{ derived: number; external: number }> {
  const [row] = await raw<{ derived: number | string; external: number | string }>(
    `SELECT count(*) FILTER (WHERE write_origin ? 'taint_inputs') AS derived,
            count(*) FILTER (WHERE write_origin ? 'taint_inputs' AND trust_tier = 'external_untrusted') AS external FROM facts`);
  return { derived: Number(row?.derived ?? 0), external: Number(row?.external ?? 0) };
}

/**
 * The stored provenance (`facts.source`) of each fact of `sourceId` whose id is in `ids`: what context_pack and delta
 * attach to the facts they deliver (ops/facts.ts `withProvenance`). A repeated id answers once and an id no row of the
 * source has answers nothing; the statement has no `ORDER BY`.
 */
export async function listFactProvenance(raw: EngineRawRead, opts: { sourceId: string; ids: readonly number[] }): Promise<Array<{ id: number; source: string }>> {
  const rows = await raw<{ id: number | string; source: string }>(
    'SELECT id, source FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[])', [opts.sourceId, [...opts.ids]],
  );
  return rows.map((r) => ({ id: Number(r.id), source: r.source }));
}
