/**
 * Group 5 facts statements, search relevance and trust reads (docs/research/rust-cli-contract-map.md, "Facts queries, purge and unlinked-fact
 * checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on
 * the engine's own `executeRaw`; only its home moved. The facts read-policy builders the search pool shares with its
 * remaining raw reads (`poolWhere`, `FactPoolScope`, `FactPoolFilters`) live here too: search/fact-relevance.ts renders them.
 */
import type { TrustTier } from '../trust/tier.ts';
import { TRUST_TIER_RANK, trustRankSql } from '../trust/tier.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { claimBucketSql } from '../facts/typed-claim.ts';
import { CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';
import { PAGE_EXTRACTION_SOURCE_LIST, contextHeadSql } from '../facts/gone-page-facts.ts';
import { factsFtsDocument, getFtsLanguage, headStemsSql } from '../fts-language.ts';
import { ownerReadPolicyFragment, privateFactFilterForCaller, privateFactFilterForReader, privateProvenanceFilterUnderPolicy, readPolicyFragment, remoteProvenanceFloorSql, remoteReadFloorSql } from '../search/private-visibility.ts';
import { factVisibilitySql, grantedPrivateFactSql, onOwnedMemoryPageSql, withdrawalCoversFactSql, withdrawalReachedFactSql } from '../access/member-facts.ts';
import { retiredPageSql } from '../entities/resolve.ts';
import { MARK_NEEDS_REDERIVE_SQL } from '../facts/derivation-inputs.ts';
import { eligibleFactEmbedding, OVERSIZED_SCAN_CAP, staleFactEmbedding } from '../facts/embedding-identity.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import type { FactCandidate as ReplacementFact } from '../facts/single-prepare.ts';
import { quarantinedProvenanceFilterFragment } from '../quarantine.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { claimPendingSql } from '../trust/claim-state.ts';
import { escapeLikePattern } from '../cjk.ts';
import { SAVED_FACT_COLLAPSE_COLUMNS, type CollapseColumns } from '../search/saved-fact-collapse.ts';
import type { SavedFactMatch } from '../search/saved-facts-match.ts';
import type { EntityFact } from '../search/entity-facts.ts';
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
function oversizedEligibleSql(): string { return eligibleFactEmbedding; }
function oversizedStaleSql(): string { return staleFactEmbedding; }
function oversizedScanCapSql(): string { return String(OVERSIZED_SCAN_CAP); }

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
  if (filters?.since) clauses.push(sqlFragment`f.valid_from IS NOT NULL AND COALESCE(f.valid_from, f.created_at) >= ${filters.since.toISOString()}::text::timestamptz`);
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
  valid_from: Date | string | null; valid_until: Date | string | null; created_at: Date | string | null;
  claim_metric: string | null; claim_period: string | null; source_markdown_slug: string | null; visibility: string;
  attributed_to: unknown; dimension: string | null; value_hash: string | null;
  similarity: number | null;
}

export function relevanceSimilarity(vector: RelevanceVector | null): SqlFragment {
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
 * first, under a custom plan), the named entity's active facts, or that entity's ended facts (history), newest first
 * (a future-dated fact as of when it was written).
 * Every arm reads under the caller's read policy and filters, and `similarity` is the row's cosine to `vector` when
 * the row's embedding is comparable with it.
 */
export async function listFactsForRelevance(raw: EngineRawRead, transaction: EngineRawTransaction, q: FactRelevanceQuery): Promise<FactRelevanceRow[]> {
  const sim = relevanceSimilarity(q.vector);
  if (q.arm === 'keyword') {
    const doc = trustedSql(factsFtsDocument('f'));
    const tsq = sqlFragment`NULLIF(replace(plainto_tsquery('${trustedSql(getFtsLanguage())}'::regconfig, ${q.terms ?? ''})::text, ' & ', ' | '), '')::tsquery`;
    return customPlan<FactRelevanceRow>(transaction, sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)}, ${sim} FROM facts f WHERE ${poolWhere(q.scope, q.filters)} AND ${doc} @@ ${tsq}
       ORDER BY ts_rank_cd(${doc}, ${tsq}) DESC, f.valid_from DESC, f.id DESC LIMIT ${q.limit}`);
  }
  const named = q.entity!;
  // GST-3170: a future-dated fact ranks as of when it was written, and #10288 an undated one as of when it was saved;
  // each active branch keeps an index-ordered scan.
  const ranked = trustedSql('(CASE WHEN f.valid_from IS NULL OR f.valid_from > now() THEN f.created_at ELSE f.valid_from END) DESC, f.id DESC');
  const branch = (order: ReturnType<typeof trustedSql>, from: ReturnType<typeof trustedSql>) => sqlFragment`(SELECT ${trustedSql(FACT_POOL_COLUMNS)}, ${sim} FROM facts f WHERE ${poolWhere(q.scope, q.filters)}
       AND f.source_id = ${named.sourceId} AND f.entity_slug = ${named.slug} AND ${from} ORDER BY ${order} DESC, f.id DESC LIMIT ${q.limit})`;
  const { text, params } = renderFragment(q.arm === 'entity'
    ? sqlFragment`SELECT * FROM (${branch(trustedSql('f.valid_from'), trustedSql('f.valid_from <= now()'))} UNION ALL ${branch(trustedSql('f.created_at'), trustedSql('(f.valid_from > now() OR f.valid_from IS NULL)'))}) f
       ORDER BY ${ranked} LIMIT ${q.limit}`
    : sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)}, ${sim} FROM facts f WHERE ${poolWhere(q.scope, { ...q.filters, includeExpired: true })} AND ${endedFactSql()} AND f.source_id = ${named.sourceId} AND f.entity_slug = ${named.slug}
       ORDER BY ${ranked} LIMIT ${q.limit}`);
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
  & { at: unknown; matched: unknown[]; need: unknown; cue: boolean; trust_rank: unknown; pool_rank: unknown; dimension: string | null };

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
         SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source, f.valid_from AS at, f.dimension, ${trustedSql(savedFactCollapseColumns())},
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

/** Rows `readEntityNewestFacts` reads, so copies of one claim collapse before the caller's cap (#7043). */
const COLLAPSE_WINDOW_SQL = '50';
export const SAVED_FACTS_COLLAPSE_WINDOW = Number(COLLAPSE_WINDOW_SQL);

/** What `readEntityNewestFacts` reads: one source's entity slugs and the read policy the caller resolved. */
export interface EntityNewestFactsQuery {
  sourceId: string;
  slugs: string[];
  /** A remote caller: the private-provenance filter applies, and `worldOnly` (worldOnlyFacts) adds the visibility rule. */
  remote: boolean;
  worldOnly: boolean;
  minTrust?: TrustTier;
}

export type EntityNewestFactRow = EntityFact & CollapseColumns;

/**
 * A named entity's newest active facts under the caller's read policy, with the collapse columns, newest first
 * (search/entity-facts.ts): at most SAVED_FACTS_COLLAPSE_WINDOW rows, which the caller collapses and caps.
 */
export async function readEntityNewestFacts(raw: EngineRawRead, q: EntityNewestFactsQuery): Promise<EntityNewestFactRow[]> {
  const visibility = q.remote ? `${q.worldOnly ? `AND (f.visibility = 'world' OR ${grantedPrivateFactSql('f')})` : ''} AND ${privateFactFilterForReader('f')}` : '';
  const { text, params } = renderFragment(sqlFragment`SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source, ${trustedSql(savedFactCollapseColumns())}
       FROM facts f
      WHERE f.source_id = ${q.sourceId} AND f.entity_slug = ANY(${q.slugs}::text[])
        AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
        AND f.source != ALL(${factsAuditSources()}::text[])
        ${trustedSql(visibility)}
        AND ${trustedSql(projectionEligibleSql('facts', 'f', { floor: q.minTrust }))}
      ORDER BY (CASE WHEN f.valid_from IS NULL OR f.valid_from > now() THEN f.created_at ELSE f.valid_from END) DESC, f.id DESC
      LIMIT ${trustedSql(COLLAPSE_WINDOW_SQL)}`);
  return raw<EntityNewestFactRow>(text, params);
}

/** One name head and the 1-based indexes of the query terms it matches (`matchHeadStems`). */
export interface HeadStemRow { h: string; i: number[] }

/**
 * Which query terms each name head matches after stemming with the brain's full-text language, as the keyword scan
 * matches words: one row per head, in `heads` order, each with the 1-based indexes of the matching terms in `terms`
 * order. A term the language drops as a stopword matches nothing.
 */
export async function matchHeadStems(raw: EngineRawRead, heads: readonly string[], terms: readonly string[]): Promise<HeadStemRow[]> {
  const rows = await raw<{ h: string; i: unknown[] }>(headStemsSql(), [[...heads], [...terms]]);
  return rows.map(r => ({ h: r.h, i: r.i.map(Number) }));
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

/**
 * Of `ids`, the facts taken from a page whose type is one of `pageTypes`, in the fact's own source: the page that holds
 * the fact (`source_markdown_slug`), a page recorded as its derivation input, or the page a backstop fact's
 * `source_session` names (`backstop`: each `[source, session prefix]` pair, the slug after the prefix). Any page row
 * counts, a soft-deleted one too.
 */
export async function listFactsFromQuotedPages(raw: EngineRawRead,
  opts: { ids: readonly number[]; pageTypes: readonly string[]; backstop: readonly [readonly [string, string], readonly [string, string]] }): Promise<number[]> {
  if (!opts.ids.length) return [];
  const [[syncSource, syncPrefix], [putSource, putPrefix]] = opts.backstop;
  const rows = await raw<{ id: number | string }>(
    `SELECT f.id FROM facts f WHERE f.id = ANY($1::bigint[]) AND (
       EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM derivation_inputs d JOIN pages p ON p.id = (CASE WHEN d.input_id ~ '^[0-9]{1,18}$' THEN d.input_id::bigint END)
         WHERE d.derived_table = 'facts' AND d.derived_id = f.id::text AND d.input_table = 'pages' AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.type = ANY($2::text[]) AND p.slug = (CASE
         WHEN f.source = $3::text AND left(f.source_session, length($4::text)) = $4::text THEN substr(f.source_session, length($4::text) + 1)
         WHEN f.source = $5::text AND left(f.source_session, length($6::text)) = $6::text THEN substr(f.source_session, length($6::text) + 1) END)))`,
    [[...new Set(opts.ids.map(Number))], [...opts.pageTypes], syncSource, syncPrefix, putSource, putPrefix]);
  return rows.map(r => Number(r.id));
}

/** Of `ids`, the facts whose stored tier ranks at or above `floor`; an id with no row is not among them. */
export async function listOwnerTierFacts(raw: EngineRawRead, opts: { ids: readonly number[]; floor: TrustTier }): Promise<number[]> {
  if (!opts.ids.length) return [];
  const ids = [...new Set(opts.ids.map(Number))];
  const { text, params } = renderFragment(sqlFragment`SELECT id FROM facts WHERE id = ANY(${ids}::bigint[]) AND ${trustedSql(trustRankSql('trust_tier'))} >= ${TRUST_TIER_RANK[opts.floor]}::int`);
  const rows = await raw<{ id: number | string }>(text, params);
  return rows.map(r => Number(r.id));
}

/** How many facts carry `taint_inputs` in their write origin, and how many of those are stamped external_untrusted. */
export async function countDerivedFactTaint(raw: EngineRawRead): Promise<{ derived: number; external: number }> {
  const [row] = await raw<{ derived: number | string; external: number | string }>(
    `SELECT count(*) FILTER (WHERE write_origin ? 'taint_inputs') AS derived,
            count(*) FILTER (WHERE write_origin ? 'taint_inputs' AND trust_tier = 'external_untrusted') AS external FROM facts`);
  return { derived: Number(row?.derived ?? 0), external: Number(row?.external ?? 0) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Write-path and capture statements (facts/write-single.ts, capture-dedup.ts, claim-conflicts.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The `entity_slug` a stored fact reads back with; null when it has none or no fact has the id. */
export async function readFactEntitySlugById(raw: EngineRawRead, id: number): Promise<string | null> {
  const [row] = await raw<{ entity_slug: string | null }>('SELECT entity_slug FROM facts WHERE id=$1', [id]);
  return row?.entity_slug ?? null;
}

export interface SupersessionReplacementRow {
  row_num: number | null; same_page: boolean; valid_from: Date | string | null; old_from: Date | string | null; old_until: Date | string | null;
}

/** The replacement fact's fence row, whether both facts sit on one page, and both validity starts and the old end; null when either id is gone. */
export async function readSupersessionReplacement(raw: EngineRawRead, newId: number, oldId: number): Promise<SupersessionReplacementRow | null> {
  const [replacement] = await raw<SupersessionReplacementRow>(
    `SELECT n.row_num, n.source_markdown_slug IS NOT DISTINCT FROM o.source_markdown_slug AS same_page, n.valid_from, o.valid_from AS old_from, o.valid_until AS old_until
         FROM facts n, facts o WHERE n.id = $1 AND o.id = $2`, [newId, oldId]);
  return replacement ?? null;
}

/** Links the old fact to the fact that replaced it (`superseded_by`). Runs in the caller's maintenance transaction. */
export async function linkSupersededFact(raw: EngineRawRead, oldId: number, newId: number): Promise<void> {
  await raw('UPDATE facts SET superseded_by = $1 WHERE id = $2', [newId, oldId]);
}

/** The slug and title of each named live page of the source. */
export async function listLivePageTitles(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null }>> {
  return raw<{ slug: string; title: string | null }>(
    'SELECT slug,title FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL', [sourceId, slugs]);
}

/** The normalized aliases of the named pages of the source. Throws on a brain older than v110 (no `page_aliases` table); the caller keeps titles only. */
export async function listPageAliasNames(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<Array<{ slug: string; alias_norm: string }>> {
  return raw<{ slug: string; alias_norm: string }>(
    'SELECT slug,alias_norm FROM page_aliases WHERE source_id=$1 AND slug=ANY($2::text[])', [sourceId, slugs]);
}

export interface CaptureDuplicateCandidateRow {
  id: number; entity_slug: string | null; source: string; source_session: string | null; created_at: Date | string;
}

const CAPTURE_DUP_HEAD = `SELECT id,entity_slug,source,source_session,created_at FROM facts WHERE source_id=$1 AND visibility=ANY($2::text[])
      AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3) AND expired_at IS NULL AND (valid_until IS NULL OR valid_until>now())
      AND ($4::text IS NULL OR attributed_to IS NULL OR attributed_to=$4)
      AND ($5::text IS NULL OR source_markdown_slug IS DISTINCT FROM $5 OR source NOT LIKE 'cli:extract-conversation-facts%')
      AND NOT `;
const CAPTURE_DUP_ORDER = `
      ORDER BY created_at DESC, id DESC LIMIT `;

/**
 * Newest first, at most `scanLimit`: the live facts of the source whose fingerprint equals the candidate's, in these visibilities,
 * spoken by nobody else (`attributedTo` null skips the filter), leaving out a page's own conversation-extractor rows while
 * `replacingPage` names it, and any fact on a member's owned page. The hand-numbered `$1..$5` are the statement's own.
 */
export async function listCaptureDuplicateCandidates(raw: EngineRawRead,
  opts: { sourceId: string; visibilities: string[]; fact: string; attributedTo: string | null; replacingPage: string | null; scanLimit: number }): Promise<CaptureDuplicateCandidateRow[]> {
  if (!Number.isFinite(opts.scanLimit)) throw new Error('listCaptureDuplicateCandidates: scanLimit must be a number');
  const limit = `${opts.scanLimit}`;
  const { text } = renderFragment(sqlFragment`${trustedSql(CAPTURE_DUP_HEAD)}${trustedSql(onOwnedMemoryPageSql('facts'))}${trustedSql(CAPTURE_DUP_ORDER)}${trustedSql(limit)}`);
  return raw<CaptureDuplicateCandidateRow>(text, [opts.sourceId, opts.visibilities, opts.fact, opts.attributedTo ?? null, opts.replacingPage ?? null]);
}

/** The fingerprint of each text, in order (`gbrain_fact_fingerprint`, the SQL function the dedup rule matches on). */
export async function computeFactFingerprints(raw: EngineRawRead, texts: string[]): Promise<string[]> {
  return (await raw<{ fp: string }>(
    'SELECT gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n', [texts])).map(r => r.fp);
}

const ACTIVE_CLAIMS_HEAD = `WITH f AS (
  SELECT id, entity_slug, visibility, claim_metric, claim_value, claim_unit, claim_period, valid_from, source_markdown_slug, `;
const ACTIVE_CLAIMS_TAIL = ` AS bucket
    FROM facts
   WHERE source_id = $1 AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())
     AND entity_slug IS NOT NULL AND claim_metric IS NOT NULL AND claim_value IS NOT NULL AND source <> ALL($2::text[]))
SELECT `;
const PAIR_JOIN_HEAD = `
FROM f n JOIN f o
    ON o.entity_slug = n.entity_slug AND o.visibility = n.visibility AND o.claim_metric = n.claim_metric
   AND o.claim_unit IS NOT DISTINCT FROM n.claim_unit AND o.claim_period IS NOT DISTINCT FROM n.claim_period
   AND o.bucket = n.bucket AND o.claim_value <> n.claim_value
   AND (NOT (`;
const PAIR_JOIN_TAIL = `) OR o.source_markdown_slug = n.source_markdown_slug)
   AND (o.valid_from < n.valid_from OR (o.valid_from = n.valid_from AND o.id < n.id))
 WHERE NOT EXISTS (SELECT 1 FROM decide_proposals p WHERE p.source_id = $1
         AND LEAST(p.new_fact_id, p.old_fact_id) = LEAST(n.id, o.id) AND GREATEST(p.new_fact_id, p.old_fact_id) = GREATEST(n.id, o.id))
   AND NOT EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'supersede_fact'
         AND tp.target_table = 'facts' AND tp.related_table = 'facts'
         AND ((tp.target_id = o.id AND tp.related_id = n.id) OR (tp.target_id = n.id AND tp.related_id = o.id)))`;
const CLAIM_PAIR_COLUMNS = 'n.id AS new_fact_id, o.id AS old_fact_id, n.entity_slug, n.visibility, n.claim_metric, n.claim_unit, n.claim_period, n.bucket, n.claim_value AS new_value, o.claim_value AS old_value';
const CLAIM_PAIR_ORDER = `
 ORDER BY n.id, o.id
 LIMIT $3`;

/** The shared conflict-pair statement: the active typed claims of the source, joined to every older same-bucket different-value pair no proposal covers. */
function claimPairs(select: SqlFragment, tail: SqlFragment): string {
  return renderFragment(sqlFragment`${trustedSql(ACTIVE_CLAIMS_HEAD)}${trustedSql(claimBucketSql('facts'))}${trustedSql(ACTIVE_CLAIMS_TAIL)}${select}${trustedSql(PAIR_JOIN_HEAD)}${trustedSql(onOwnedMemoryPageSql('n'))} OR ${trustedSql(onOwnedMemoryPageSql('o'))}${trustedSql(PAIR_JOIN_TAIL)}${tail}`).text;
}

/**
 * Unproposed same-bucket claim conflicts in the source, ordered by (new id, old id), at most `cap` rows (`$1` source, `$2` the audit
 * sources the lane never compares, `$3` the cap; the caller asks for one more than it keeps to learn whether any were left).
 */
export async function listClaimConflictPairs(raw: EngineRawRead, sourceId: string, auditSources: string[], cap: number): Promise<Array<Record<string, unknown>>> {
  const text = claimPairs(sqlFragment`${trustedSql(CLAIM_PAIR_COLUMNS)}`, sqlFragment`${trustedSql(CLAIM_PAIR_ORDER)}`);
  return raw<Record<string, unknown>>(text, [sourceId, auditSources, cap]);
}

/** How many unproposed claim conflicts the source holds (the same statement as listClaimConflictPairs, counted, `$1` source and `$2` audit sources). */
export async function countClaimConflictPairs(raw: EngineRawRead, sourceId: string, auditSources: string[]): Promise<{ n: number | string } | null> {
  const [count] = await raw<{ n: number | string }>(claimPairs(sqlFragment`${trustedSql('COUNT(*) AS n')}`, sqlFragment``), [sourceId, auditSources]);
  return count ?? null;
}

/** The ids of every source that is not archived, in id order (the claim-conflict sweep's default scope). */
export async function listUnarchivedSourceRows(raw: EngineRawRead): Promise<Array<{ id: string }>> {
  return raw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id COLLATE "C"');
}

/** The ids of every source that is not archived, in byte order of the id (the same read as `listUnarchivedSourceRows`). */
export async function listAllUnarchivedSourceIds(raw: EngineRawRead): Promise<Array<{ id: string }>> {
  return raw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id COLLATE "C"');
}

// ---------------------------------------------------------------------------
// Write-path and caller-side reads of the facts module (batch G, "facts rest sites"): each runs the statement its caller ran
// through `executeRaw`, with the same text and parameters. The ones that write run in the caller's own transaction, as the
// member is called on the transaction's engine handle.
// ---------------------------------------------------------------------------

/** The durable receipt of a write still queued, running or recovering, or null (a `write_pending` error's request). */
export async function readPendingWriteReceipt(raw: EngineRawRead, principalKind: string, principalId: string, requestId: string): Promise<{ request_id: string; state: string } | null> {
  const [row] = await raw<{ request_id: string; state: string }>(
    `SELECT request_id::text AS request_id, state FROM persistence_requests
        WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid AND state IN ('queued','running','recovering')`,
    [principalKind, principalId, requestId]);
  return row ?? null;
}

/** Takes a shared row lock on the source for the rest of the caller's transaction. */
export async function lockSourceShared(raw: EngineRawRead, sourceId: string): Promise<void> {
  await raw('SELECT id FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
}

export interface OversizedStaleFactRow { id: string; source_id: string; slug: string | null; fact: string }

const OVERSIZED_HEAD = `SELECT f.id::text, f.source_id, f.source_markdown_slug AS slug, f.fact FROM facts f
      WHERE ($1::text IS NULL OR f.source_id = $1) AND `;
const OVERSIZED_TAIL = `
        AND octet_length(f.fact) > $5::int ORDER BY f.id LIMIT `;

/** The stale, embeddable facts for `model` and `dims` longer than `maxTokens` bytes, at most OVERSIZED_SCAN_CAP, in id order (`sourceId` narrows to one source). */
export async function listOversizedStaleFacts(raw: EngineRawRead, opts: { sourceId?: string; model: string; dims: number; maxTokens: number }): Promise<OversizedStaleFactRow[]> {
  const { text } = renderFragment(sqlFragment`${trustedSql(OVERSIZED_HEAD)}${trustedSql(oversizedEligibleSql())} AND ${trustedSql(oversizedStaleSql())}${trustedSql(OVERSIZED_TAIL)}${trustedSql(oversizedScanCapSql())}`);
  return raw<OversizedStaleFactRow>(text, [opts.sourceId ?? null, [...AUDIT_ROW_SOURCES], opts.model, opts.dims, opts.maxTokens]);
}

const LIVE_PERSON_TITLES = `SELECT slug, title FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND type = 'person' AND slug = ANY($2::text[]) AND NOT `;

/** The slug and title of each named live, non-retired person page of the source. */
export async function listLivePersonTitles(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null }>> {
  const { text } = renderFragment(sqlFragment`${trustedSql(LIVE_PERSON_TITLES)}${trustedSql(retiredPageSql('pages'))}`);
  return raw<{ slug: string; title: string | null }>(text, [sourceId, slugs]);
}

const LIVE_ENTITY_PAGE = 'SELECT p.slug, p.type FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL ';

/** The live page `slug` of the source (`excludePrivate` also applies the remote read floor), or null. */
export async function readLiveFactEntityPage(raw: EngineRawRead, sourceId: string, slug: string, excludePrivate?: boolean): Promise<{ slug: string; type: string | null } | null> {
  const privacy = excludePrivate ? sqlFragment`AND ${trustedSql(remoteReadFloorSql('p'))}` : sqlFragment``;
  const { text } = renderFragment(sqlFragment`${trustedSql(LIVE_ENTITY_PAGE)}${privacy} LIMIT 1`);
  const [row] = await raw<{ slug: string; type: string | null }>(text, [sourceId, slug]);
  return row ?? null;
}

/** Takes the advisory lock that serializes changes to one memory setting for the rest of the caller's transaction. */
export async function lockAgentWritebackSetting(raw: EngineRawRead, key: string): Promise<void> {
  await raw('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

export interface RetireFactRow { id: number; row_num: number | null; source_markdown_slug: string | null; entity_slug: string | null }

/** The active facts of the source extracted under `session`, or whose context is `slug` or matches `pattern` (a LIKE pattern), in id order. */
export async function listFactsToRetireFromPage(raw: EngineRawRead, sourceId: string, session: string, slug: string, pattern: string): Promise<RetireFactRow[]> {
  return raw<RetireFactRow>(`SELECT id,row_num,source_markdown_slug,entity_slug FROM facts
    WHERE source_id=$1 AND expired_at IS NULL AND (source_session=$2 OR context=$3 OR context LIKE $4)
    ORDER BY id`, [sourceId, session, slug, pattern]);
}

/** What a contested lookup may read: remote callers see world facts, `excludePrivate` hides private provenance, `eligibility` is the trust floor. */
export interface ContestedReadPolicy { remote: boolean; excludePrivate: boolean; eligibility?: ReadEligibility }

export interface ContestedProposalPairRow { id: number | string; delivered: number | string; new_fact_id: number | string; old_fact_id: number | string }

function contestedReadableSql(alias: string, policy: ContestedReadPolicy): string {
  return [
    `${alias}.expired_at IS NULL AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > now())`,
    ...(policy.remote ? [`${alias}.visibility = 'world'`] : []),
    ...(policy.excludePrivate ? [privateFactFilterForCaller(alias)] : []),
    projectionEligibleSql('facts', alias, policy.eligibility),
  ].join(' AND ');
}

const CONTESTED_HEAD = `SELECT p.id, x.id AS delivered, p.new_fact_id, p.old_fact_id FROM unnest($1::bigint[]) AS x(id)
  JOIN decide_proposals p ON p.status = 'pending' AND (p.new_fact_id = x.id OR p.old_fact_id = x.id)
  JOIN facts n ON n.id = p.new_fact_id AND n.source_id = p.source_id
  JOIN facts o ON o.id = p.old_fact_id AND o.source_id = p.source_id
 WHERE `;
const CONTESTED_TAIL = `
 ORDER BY p.id`;

/** The pending decide proposals that name any of `ids` as their new or old fact, both facts readable under `policy`, in proposal order. Throws when the read fails. */
export async function listContestedProposalPairs(raw: EngineRawRead, ids: number[], policy: ContestedReadPolicy): Promise<ContestedProposalPairRow[]> {
  const { text } = renderFragment(sqlFragment`${trustedSql(CONTESTED_HEAD)}${trustedSql(contestedReadableSql('n', policy))} AND ${trustedSql(contestedReadableSql('o', policy))}${trustedSql(CONTESTED_TAIL)}`);
  return raw<ContestedProposalPairRow>(text, [ids]);
}

/** The stored provenance (`facts.source`) of these facts of the source. */
export async function listFactProvenance(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<Array<{ id: number | string; source: string | null }>> {
  return raw<{ id: number | string; source: string | null }>('SELECT id, source FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[])', [sourceId, ids]);
}

/** A row reference in the derivation graph: the owning table's name and the row's primary key (stringified). */
export interface DerivationEdgeRef { table: string; id: string }

/** Records every input of one derived row (idempotent). Runs in the transaction that writes the derived row. */
export async function recordDerivationEdges(raw: EngineRawRead, derived: DerivationEdgeRef, sourceId: string | null, edges: readonly DerivationEdgeRef[]): Promise<void> {
  await raw(`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
    SELECT $1,$2,e.input_table,e.input_id,$3 FROM jsonb_to_recordset($4::text::jsonb) AS e(input_table text,input_id text)
    ON CONFLICT DO NOTHING`, [derived.table, derived.id, sourceId, JSON.stringify(edges.map(e => ({ input_table: e.table, input_id: e.id })))]);
}

/** Expires these facts of the source (those already expired keep their time); returns how many rows it touched. Runs in the caller's transaction. */
export async function expireDerivedFacts(raw: EngineRawRead, ids: number[], sourceId: string): Promise<number> {
  return (await raw(`UPDATE facts SET expired_at=COALESCE(expired_at,now()) WHERE id=ANY($1::bigint[]) AND source_id=$2 RETURNING id`, [ids, sourceId])).length;
}

/** Deactivates these takes on pages of the source; returns how many rows it touched. Runs in the caller's transaction. */
export async function deactivateDerivedTakes(raw: EngineRawRead, ids: number[], sourceId: string): Promise<number> {
  return (await raw(`UPDATE takes k SET active=false FROM pages p WHERE k.id=ANY($1::bigint[]) AND p.id=k.page_id AND p.source_id=$2 RETURNING k.id`, [ids, sourceId])).length;
}

/**
 * Soft-deletes these pages of the source (#9653: only a page not already deleted keeps a fresh `deleted_at`); returns one row per page of
 * the source that is now hidden, `now` true when this call hid it. Runs in the caller's transaction.
 */
export async function softDeleteDerivedPages(raw: EngineRawRead, ids: number[], sourceId: string): Promise<Array<{ id: number; now: boolean }>> {
  return raw<{ id: number; now: boolean }>(`WITH gone AS (SELECT id FROM pages WHERE id=ANY($1::integer[]) AND source_id=$2 AND deleted_at IS NOT NULL),
        hid AS (UPDATE pages SET deleted_at=now() WHERE id=ANY($1::integer[]) AND source_id=$2 AND deleted_at IS NULL RETURNING id)
        SELECT id, true AS now FROM hid UNION ALL SELECT id, false AS now FROM gone`, [ids, sourceId]);
}

/**
 * Marks each derived row of `table` as needing re-derivation (a later mark replaces the reason and request). `hiddenNow` names the pages
 * this transaction just hid: their `marked_at` is their `deleted_at`; any other mark keeps that moment or is stamped now (MARK_NEEDS_REDERIVE_SQL,
 * #9653). Runs in the caller's transaction.
 */
export async function markNeedsRederive(raw: EngineRawRead, table: string, ids: string[], sourceId: string, requestId: string | null, reason: string, hiddenNow: string[]): Promise<void> {
  await raw(MARK_NEEDS_REDERIVE_SQL, [table, ids, sourceId, requestId, reason, hiddenNow]);
}

export interface MemberPageWithdrawalQuery {
  sourceId: string; visibility: string; fact: string; entitySlug: string | null | undefined;
  /** The member page the save lands on. */
  page: string;
  /** The page's member is the enabled brain owner (owner read rule), and the identity and satisfied rule ids it reads under. */
  owner: boolean; identity: readonly string[]; satisfied: readonly string[];
}
export interface WithdrawalRow { subject: string; withdrawn_at: string; visibility: 'world' | 'private' }

function memberReadsSql(alias: string, q: Pick<MemberPageWithdrawalQuery, 'owner' | 'identity' | 'satisfied'>): string {
  return q.owner ? ownerReadPolicyFragment(alias, q.identity, q.satisfied) : readPolicyFragment(alias, q.identity, true, q.satisfied);
}

const MEMBER_WITHDRAWAL_HEAD = `SELECT w.subject,w.visibility,w.withdrawn_at::text AS withdrawn_at FROM fact_withdrawals w
    WHERE w.source_id=$1 AND w.visibility=$2 AND w.fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v1($3))
      AND (w.subject=$5::text OR ((w.subject='*' OR w.subject=$4::text) AND EXISTS (SELECT 1 FROM facts f
        WHERE f.source_id=w.source_id AND f.visibility=w.visibility AND f.expired_at IS NOT NULL
          AND gbrain_fact_fingerprint(f.fact)=gbrain_fact_fingerprint($3) AND `;
const MEMBER_READABLE_HEAD = ` AND (f.source_markdown_slug = $5::text OR (`;
const MEMBER_READABLE_OWNER = 'TRUE';
const MEMBER_READABLE_WORLD = `f.visibility = 'world'`;
const MEMBER_READABLE_PAGE = `
    AND NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id = f.source_id AND pp.slug = f.source_markdown_slug AND NOT `;
const MEMBER_READABLE_ENTITY = `)
    AND NOT EXISTS (SELECT 1 FROM pages ep WHERE ep.source_id = f.source_id AND ep.slug = f.entity_slug AND NOT `;
const MEMBER_WITHDRAWAL_TAIL = `))))))
    ORDER BY (w.subject<>'*') DESC, w.withdrawn_at DESC LIMIT 1`;

/**
 * GST-2346: the withdrawal a remote save onto member page `page` meets, or null: the page's own withdrawals, and a withdrawal of
 * another subject only when a row it withdrew is one the page's member reads (a row on the page, or on pages it reads; for the
 * enabled brain owner any one).
 */
export async function readMemberPageWithdrawal(raw: EngineRawRead, q: MemberPageWithdrawalQuery): Promise<WithdrawalRow | null> {
  const { text } = renderFragment(sqlFragment`${trustedSql(MEMBER_WITHDRAWAL_HEAD)}${trustedSql(withdrawalReachedFactSql('w', 'f'))}${trustedSql(MEMBER_READABLE_HEAD)}${trustedSql(q.owner ? MEMBER_READABLE_OWNER : MEMBER_READABLE_WORLD)}${trustedSql(MEMBER_READABLE_PAGE)}${trustedSql(memberReadsSql('pp', q))}${trustedSql(MEMBER_READABLE_ENTITY)}${trustedSql(memberReadsSql('ep', q))}${trustedSql(MEMBER_WITHDRAWAL_TAIL)}`);
  const [row] = await raw<WithdrawalRow>(text, [q.sourceId, q.visibility, q.fact, q.entitySlug, q.page]);
  return row ?? null;
}

/** The visibility of one fact of the source, or null. */
export async function readFactVisibility(raw: EngineRawRead, id: number, sourceId: string): Promise<{ visibility: string } | null> {
  const [row] = await raw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1 AND source_id=$2', [id, sourceId]);
  return row ?? null;
}

const REPLACEMENT_HEAD = `SELECT f.*,
      EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v1(f.fact))
        AND `;
const REPLACEMENT_FROM = `) AS withdrawn
    FROM facts f WHERE f.id=$1 AND f.source_id=$2`;
const REPLACEMENT_OWN_PAGE = ' AND (f.source_markdown_slug = $3 OR ';

export interface ReplacementTargetQuery {
  targetId: number; sourceId: string;
  /** A remote caller: the target must pass the remote provenance floor. */
  excludePrivate?: boolean;
  /** The member page this write goes to, which the caller may replace private rows of; only read with `excludePrivate`. */
  ownPage: string | null;
  /** Takes the target row lock (`FOR UPDATE OF f`) inside the publishing transaction. */
  lock?: boolean;
}

export type ReplacementTargetRow = ReplacementFact & { withdrawn: boolean };

/** The fact a `remember.replaces` names, with whether the withdrawal ledger covers it, or null. */
export async function readReplacementTarget(raw: EngineRawRead, q: ReplacementTargetQuery): Promise<ReplacementTargetRow | null> {
  const floor = trustedSql(remoteProvenanceFloorSql('f'));
  const privacy = !q.excludePrivate ? sqlFragment``
    : q.ownPage ? sqlFragment`${trustedSql(REPLACEMENT_OWN_PAGE)}${floor})` : sqlFragment` AND ${floor}`;
  const { text } = renderFragment(sqlFragment`${trustedSql(REPLACEMENT_HEAD)}${trustedSql(withdrawalCoversFactSql('w', 'f'))}${trustedSql(REPLACEMENT_FROM)}${privacy}${q.lock ? sqlFragment` FOR UPDATE OF f` : sqlFragment``}`);
  const [row] = await raw<ReplacementTargetRow>(text, q.excludePrivate && q.ownPage ? [q.targetId, q.sourceId, q.ownPage] : [q.targetId, q.sourceId]);
  return row ?? null;
}

const PAIR_FACT_SQL = `SELECT id, source_id, entity_slug, visibility, fact, expired_at, valid_from, valid_until, superseded_by, row_num, source_markdown_slug
       FROM facts WHERE id = $1`;
const PAIR_FACT_LOCKED_SQL = `SELECT id, source_id, entity_slug, visibility, fact, expired_at, valid_from, valid_until, superseded_by, row_num, source_markdown_slug
       FROM facts WHERE id = $1 FOR UPDATE`;

/** One fact of a supersede pair by id (any source), `lock` taking the row lock; the raw row, or null. */
export async function readPairFactRow(raw: EngineRawRead, id: number, lock = false): Promise<Record<string, unknown> | null> {
  const [row] = await raw<Record<string, unknown>>(lock ? PAIR_FACT_LOCKED_SQL : PAIR_FACT_SQL, [id]);
  return row ?? null;
}

/** Expires the old fact of an accepted supersede pair and links it to the new one (`until` null ends it now); returns how many rows it touched. Runs in the caller's transaction. */
export async function expireSupersededFact(raw: EngineRawRead, q: { oldId: number; sourceId: string; newId: number; until: string | null }): Promise<number> {
  return (await raw(
    `UPDATE facts SET expired_at = now(), valid_until = COALESCE($4::timestamptz, GREATEST(valid_from, LEAST(COALESCE(valid_until, now()), now()))), superseded_by = $3
      WHERE id = $1 AND source_id = $2 AND expired_at IS NULL RETURNING id`,
    [q.oldId, q.sourceId, q.newId, q.until])).length;
}

/** Puts the old fact of an undone supersede pair back as it was (only while it still points at `expectedSupersededBy`); returns how many rows it touched. Runs in the caller's transaction. */
export async function restoreSupersededFact(raw: EngineRawRead, q: { oldId: number; sourceId: string; expiredAt: string | null; validUntil: string | null; supersededBy: number | null; expectedSupersededBy: number | null }): Promise<number> {
  return (await raw(
    `UPDATE facts SET expired_at = $3::timestamptz, valid_until = $4::timestamptz, superseded_by = $5
      WHERE id = $1 AND source_id = $2 AND superseded_by IS NOT DISTINCT FROM $6 RETURNING id`,
    [q.oldId, q.sourceId, q.expiredAt, q.validUntil, q.supersededBy, q.expectedSupersededBy])).length;
}

export interface ForgetFactRow {
  id: string; source_id: string; entity_slug: string | null; row_num: number | null;
  source_markdown_slug: string | null; expired_at: Date | null; visibility: string;
}

/** The columns a forget decides on, for one fact by id (any source), or null. */
export async function readFactForForget(raw: EngineRawRead, id: number): Promise<ForgetFactRow | null> {
  const [row] = await raw<ForgetFactRow>(
    `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at, visibility
       FROM facts WHERE id = $1`, [id]);
  return row ?? null;
}

/** Expires an active fact for a supersession or retirement: `validUntil` (or now, never before it began) ends it. Runs in the caller's transaction. */
export async function expireFactSuperseded(raw: EngineRawRead, factId: number, validUntil: string | null): Promise<void> {
  await raw(`UPDATE facts SET valid_until = COALESCE($2::timestamptz, GREATEST(valid_from, LEAST(COALESCE(valid_until, now()), now()))), expired_at = now()
      WHERE id = $1 AND expired_at IS NULL`, [factId, validUntil]);
}

/**
 * Ends an active fact on `today` (a date) and expires it, as master's forget file-mirror stamp did. Runs in the caller's
 * transaction. PGLite casts the day text to midnight in the session TimeZone; postgres.js turns it into a Date
 * (`new Date(text)`), so Postgres stores UTC midnight; the Rust store stores UTC midnight.
 */
export async function expireFactAtDate(raw: EngineRawRead, factId: number, today: string): Promise<void> {
  await raw(`UPDATE facts SET valid_until = $1, expired_at = now()
         WHERE id = $2 AND expired_at IS NULL`, [today, factId]);
}

/** Whether the withdrawal ledger covers this fact of the source, or null when the fact is not there. */
export async function readWithdrawalAnchor(raw: EngineRawRead, factId: number, sourceId: string): Promise<{ withdrawn: boolean } | null> {
  const { text } = renderFragment(sqlFragment`SELECT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
        AND ${trustedSql(withdrawalCoversFactSql('w', 'f'))}) AS withdrawn
       FROM facts f WHERE f.id = ${factId} AND f.source_id = ${sourceId}`);
  const [row] = await raw<{ withdrawn: boolean }>(text, [factId, sourceId]);
  return row ?? null;
}

/** Whether this fact of the source is active, and the md5 of its text, or null when it is not there. */
export async function readFactActivity(raw: EngineRawRead, id: number, sourceId: string): Promise<{ active: boolean; text_hash: string } | null> {
  const [row] = await raw<{ active: boolean; text_hash: string }>(
    `SELECT (expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())) AS active, md5(fact) AS text_hash
       FROM facts WHERE id = $1 AND source_id = $2`, [id, sourceId]);
  return row ?? null;
}

/** The fact, when it is expired and its context carries `mark` (a review's accept already forgot it), or null. */
export async function readReviewAcceptedMark(raw: EngineRawRead, id: number, sourceId: string, mark: string): Promise<{ id: number } | null> {
  const [row] = await raw<{ id: number }>(`SELECT id FROM facts WHERE id = $1 AND source_id = $2 AND expired_at IS NOT NULL
      AND strpos(COALESCE(context, ''), $3) > 0`, [id, sourceId, mark]);
  return row ?? null;
}

/** Whether index `name` is valid, and its definition; null when there is no such index. */
export async function readFactsFtsIndexState(raw: EngineRawRead, name: string): Promise<{ valid: boolean; def: string } | null> {
  const [row] = await raw<{ valid: boolean; def: string }>(
    'SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = to_regclass($1)', [name]);
  return row ?? null;
}

/**
 * Swaps the freshly built `idx_facts_fts_next` into place: renames the live `idx_facts_fts` to `idx_facts_fts_old`, then the next one
 * to `idx_facts_fts` (a rename takes no lock that blocks reads or writes). The index names are those of facts/fts-index.ts. Runs
 * in the caller's transaction, so a failure of the second rename restores the first.
 */
export async function swapFactsFtsIndex(raw: EngineRawRead): Promise<void> {
  await raw('ALTER INDEX IF EXISTS idx_facts_fts RENAME TO idx_facts_fts_old');
  await raw('ALTER INDEX idx_facts_fts_next RENAME TO idx_facts_fts');
}

/**
 * The provenance (`source_markdown_slug`) of each open stint of an entity's dimension: every unexpired, unclosed row
 * that is not a conversation slot (belief/writers.ts `ontologyStreamSlugs`, the streams an observation can change).
 * `dimension` is already normalised. Each slug once, in code-unit order; a row with no provenance adds nothing.
 * The conversation test is chronicle/ontology.ts NOT_CONVERSATION_SLOT_SQL written out (both texts are pinned).
 */
export async function listOntologyStreamSlugs(raw: EngineRawRead, sourceId: string, entitySlug: string, dimension: string): Promise<string[]> {
  const rows = await raw<{ slug: string | null }>(`SELECT DISTINCT source_markdown_slug AS slug FROM facts
    WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND expired_at IS NULL AND valid_until IS NULL AND COALESCE(source, '') NOT LIKE 'cli:extract-conversation-facts%'`, [sourceId, entitySlug, dimension]);
  return rows.map(r => r.slug).filter((slug): slug is string => slug !== null).sort();
}

/**
 * The stint an ontology observation `excludeId` left open (trust/supersede-handlers.ts `contestOntologySupersession`):
 * the newest open, active, non-conversation row of the entity's dimension other than `excludeId`, with its stored
 * `trust_tier` (the caller reads it through storedTrustTier). `dimension` is already normalised. Null: no such row.
 */
export async function readOntologyRival(raw: EngineRawRead, sourceId: string, entitySlug: string, dimension: string, excludeId: number): Promise<{ id: number; trust_tier: string } | null> {
  const [row] = await raw<{ id: number | string; trust_tier: string }>(
    `SELECT id, trust_tier FROM facts WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND id <> $4
       AND expired_at IS NULL AND valid_until IS NULL AND (dim_status IS NULL OR dim_status = 'active') AND COALESCE(source, '') NOT LIKE 'cli:extract-conversation-facts%'
     ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC LIMIT 1`, [sourceId, entitySlug, dimension, excludeId]);
  return row ? { id: Number(row.id), trust_tier: row.trust_tier } : null;
}

/**
 * The ledger stream slug of each listed row (belief/writers.ts `beliefStreamSlugs`): a fact's fence page else its
 * entity, a take's page, a page's own slug; deleted pages included. One entry per row found, null where the row has
 * none, in no promised order: the caller drops the invalid ones, removes repeats and sorts.
 */
export async function listBeliefStreamSlugs(raw: EngineRawRead, table: 'facts' | 'takes' | 'pages', ids: readonly number[]): Promise<Array<string | null>> {
  if (ids.length === 0) return [];
  const sql = table === 'facts' ? 'SELECT COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = ANY($1::bigint[])'
    : table === 'takes' ? 'SELECT p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = ANY($1::bigint[])'
      : 'SELECT slug FROM pages WHERE id = ANY($1::int[])';
  const rows = await raw<{ slug: string | null }>(sql, [[...ids]]);
  return rows.map(r => r.slug ?? null);
}
