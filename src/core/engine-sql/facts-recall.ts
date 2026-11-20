/**
 * Group 5 facts statements, recall's candidate-pool reads (docs/research/rust-cli-contract-map.md, "Facts queries, purge and
 * unlinked-fact checks"). Each function runs the statement `search/fact-relevance.ts` and `facts/question-recall.ts` ran through
 * `executeRaw`, on the engine's own `executeRaw`; only its home moved. They read under the pool's read policy
 * (`poolWhere` in facts-trust.ts), so a row the caller cannot see never shapes what a caller sees.
 *
 * Six are byte-identical to the statement the caller sent (the placeholders were each used once, in order, so the renderer
 * numbers them as the caller did). `listNearestFacts` is not: the caller hand-numbered the query vector, the model and the
 * dimensions and used each twice; the renderer binds each once per use, so those three values are sent twice and the
 * placeholders after the pool's own are numbered in the order they appear. The same rows come back (test/facts-rest-sites-sql-pin.test.ts
 * pins the new text; test/engine-parity/facts-rest-sites.test.ts pins the rows).
 */
import { CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';
import type { SlotRow } from '../facts/slots.ts';
import type { FactCandidate } from '../search/fact-relevance.ts';
import type { HnswIterativeScanMode } from '../search/hnsw-iterative-scan.ts';
import { RETRACTION } from '../search/saved-facts-match.ts';
import { VECTOR_EXTENSION_VERSION_SQL } from '../search/vector-statement.ts';
import { withVectorSettings } from '../search/vector-settings.ts';
import { supportsHnswIterativeScan } from '../vector-index.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import {
  FACT_POOL_COLUMNS, poolWhere, relevanceSimilarity,
  type EngineRawRead, type EngineRawTransaction, type FactPoolFilters, type FactPoolScope, type RelevanceVector,
} from './facts-trust.ts';
import type { FactRowSqlShape } from './facts.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { isTrustTier, trustRankSql, TRUST_TIER_RANK, type TrustTier } from '../trust/tier.ts';
import type { PageReadScope } from '../types.ts';

// The vetted builder below is named in scripts/check-engine-sql-dynamic.ts: it wraps one constant fragment.
function conversationSlotSql(): string { return CONVERSATION_SLOT_SQL; }

/** GBRA-574 B5: plain cancellation words the call-off cue adds to saved-facts-match.ts's RETRACTION. Fixed, never configurable. */
export const CALLED_OFF = String.raw`rumour|rumor|called off|cancelled|canceled|fell through|not happening|never happened|no longer planned`;
/** The Postgres regex a call-off cue fact matches (`\m...\M` word bounds). */
export const CALL_OFF_SQL = String.raw`\m(${RETRACTION}|${CALLED_OFF})\M`;
/** Cue facts read per entity at most, the newest first. */
export const CALL_OFF_DEPTH = 50;

/** The type and declared dimensions of the facts embedding column (`atttypmod`; 0 or less when undeclared), or null when there is none. */
export async function readFactsEmbeddingColumn(raw: EngineRawRead): Promise<{ type: string; dims: number } | null> {
  const [row] = await raw<{ type: string; dims: number }>(
    `SELECT t.typname AS type, a.atttypmod AS dims FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
     WHERE a.attrelid = to_regclass('facts') AND a.attname = 'embedding' AND NOT a.attisdropped`);
  return row ?? null;
}

export type SlotFactRow = SlotRow & Omit<FactCandidate, 'entity'>;
export type CueFactRow = FactCandidate;
export type { FactRowSqlShape };
export type PoolFactRow = FactCandidate & { similarity?: number | null };

export interface NearestFactsQuery {
  scope: FactPoolScope;
  filters?: FactPoolFilters;
  /** The query embedding, its column type, and the model and dimensions a row must carry. */
  vector: RelevanceVector;
  /** Whether the facts embedding column declares its dimensions (when it does not, rows are also matched on `vector_dims`). */
  declared: boolean;
  limit: number;
  /** Set: the read runs in a transaction that sets the HNSW iterative-scan settings first (`off` leaves them as the server has them). */
  hnswIterativeScan?: HnswIterativeScanMode;
}

/**
 * The pool facts nearest `vector.literal` by cosine distance under the pool's read policy, closest first, with `similarity` on rows
 * whose embedding is comparable. With `hnswIterativeScan` the read is wrapped in the iterative-scan settings of
 * search/vector-settings.ts on one connection.
 */
export async function listNearestFacts(raw: EngineRawRead, transaction: EngineRawTransaction, q: NearestFactsQuery): Promise<PoolFactRow[]> {
  const v = q.vector;
  const cast = v.type === 'halfvec' ? '::halfvec' : '::vector';
  const dimsMatch = q.declared ? sqlFragment`` : sqlFragment` AND vector_dims(f.embedding) = ${v.dims}`;
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)}, ${relevanceSimilarity(v)} FROM facts f WHERE ${poolWhere(q.scope, q.filters)} AND f.embedding IS NOT NULL AND f.embedding_model = ${v.model}${dimsMatch}
       ORDER BY f.embedding <=> ${v.literal}${trustedSql(cast)} LIMIT ${q.limit}`);
  if (!q.hnswIterativeScan) return raw<PoolFactRow>(text, params);
  const mode = q.hnswIterativeScan;
  return transaction(async tx => {
    const iterative = mode !== 'off' && supportsHnswIterativeScan((await tx<{ extversion: string }>(VECTOR_EXTENSION_VERSION_SQL))[0]?.extversion);
    return withVectorSettings((s, vals) => tx(s, vals), iterative, q.limit, 20_000, () => tx<PoolFactRow>(text, params), undefined, mode);
  });
}

/**
 * GBRA-574 B2: every active conversation slot row (dim_status active; ontology observations never shape a window) of the given
 * (source, entity, dimension) slots under exactly the pool's read policy; ordered by valid_from, id. A row whose stored valid_until
 * has passed still ends the value before it; withdrawn and superseded rows never do.
 */
export async function listSlotRows(raw: EngineRawRead, scope: FactPoolScope,
  slots: ReadonlyArray<{ source_id: string; entity_slug: string; dimension: string }>): Promise<SlotFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)} FROM facts f
     WHERE ${poolWhere(scope, { includeExpired: true })} AND f.expired_at IS NULL AND f.superseded_by IS NULL AND f.dimension IS NOT NULL AND f.value_hash IS NOT NULL AND COALESCE(f.dim_status, 'active') = 'active' AND ${trustedSql(conversationSlotSql())}
       AND (f.source_id, f.entity_slug, f.dimension) IN (SELECT * FROM unnest(${slots.map(s => s.source_id)}::text[], ${slots.map(s => s.entity_slug)}::text[], ${slots.map(s => s.dimension)}::text[]))
     ORDER BY f.valid_from, f.id`);
  return raw<SlotFactRow>(text, params);
}

/**
 * GBRA-574 F (D1): the distinct (source_id, entity_slug) pairs among `keys` that hold an active fact in the pool under its read
 * policy and have no live page at that slug (an unbacked name key), at most `limit`, by source then slug.
 */
export async function listPoolUnbackedKeys(raw: EngineRawRead, scope: FactPoolScope, keys: readonly string[], limit: number): Promise<Array<{ source_id: string; entity_slug: string }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT f.source_id, f.entity_slug FROM facts f WHERE ${poolWhere(scope, undefined)} AND f.entity_slug = ANY(${[...keys]}::text[])
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     ORDER BY f.source_id, f.entity_slug LIMIT ${limit}`);
  return raw<{ source_id: string; entity_slug: string }>(text, params);
}

/**
 * GBRA-574 B5: the cue facts that retract or call off a fact: for each (source, entity) pair, the newest CALL_OFF_DEPTH active pool
 * facts whose text matches the call-off words, under exactly the pool's read policy.
 */
export async function listCallOffCueFacts(raw: EngineRawRead, scope: FactPoolScope, pairs: ReadonlyArray<{ source_id: string; entity_slug: string }>): Promise<CueFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(FACT_POOL_COLUMNS)} FROM (SELECT f.*, row_number() OVER (PARTITION BY f.source_id, f.entity_slug ORDER BY f.valid_from DESC, f.id DESC) AS call_off_rank
       FROM facts f WHERE ${poolWhere(scope, undefined)} AND f.fact ~* ${CALL_OFF_SQL}
         AND (f.source_id, f.entity_slug) IN (SELECT * FROM unnest(${pairs.map(p => p.source_id)}::text[], ${pairs.map(p => p.entity_slug)}::text[]))) f
     WHERE f.call_off_rank <= ${CALL_OFF_DEPTH}`);
  return raw<FactCandidate>(text, params);
}

/** The distinct (source_id, entity_slug) pairs with a fact in the authorized, filtered pool (the namesake check runs on these before any ranking). */
export async function listPoolEntityPairs(raw: EngineRawRead, scope: FactPoolScope, filters: FactPoolFilters): Promise<Array<{ source_id: string; entity_slug: string }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT f.source_id, f.entity_slug FROM facts f WHERE ${poolWhere(scope, filters)} AND f.entity_slug IS NOT NULL ORDER BY f.source_id, f.entity_slug`);
  return raw<{ source_id: string; entity_slug: string }>(text, params);
}

/** The whole fact rows of these ids within these sources (recall's final read; the caller strips the embedding). */
export async function listFactRowsByIds(raw: EngineRawRead, sourceIds: readonly string[], ids: readonly number[]): Promise<FactRowSqlShape[]> {
  return raw<FactRowSqlShape>('SELECT * FROM facts WHERE source_id = ANY($1::text[]) AND id = ANY($2::bigint[])', [[...sourceIds], [...ids]]);
}

/** The backstop provenance pairs `listFactsFromQuotedPages` reads: `[source, source_session prefix]` for a synced, then a written page. */
export type QuotedBackstopSessions = readonly [readonly [string, string], readonly [string, string]];

/**
 * Of `ids`, the facts taken from a page of one of `pageTypes`: the page holding the fact, a page recorded as its derivation
 * input, or the page a backstop fact's `source_session` names (search/transcript-quote.ts factsFromQuotedPages).
 */
export async function listFactsFromQuotedPages(raw: EngineRawRead, ids: readonly number[], pageTypes: readonly string[],
  backstopSessions: QuotedBackstopSessions): Promise<number[]> {
  if (!ids.length) return [];
  const [[syncSource, syncPrefix], [putSource, putPrefix]] = backstopSessions;
  const rows = await raw<{ id: number | string }>(
    `SELECT f.id FROM facts f WHERE f.id = ANY($1::bigint[]) AND (
       EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM derivation_inputs d JOIN pages p ON p.id = (CASE WHEN d.input_id ~ '^[0-9]{1,18}$' THEN d.input_id::bigint END)
         WHERE d.derived_table = 'facts' AND d.derived_id = f.id::text AND d.input_table = 'pages' AND p.type = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.type = ANY($2::text[]) AND p.slug = (CASE
         WHEN f.source = $3::text AND left(f.source_session, length($4::text)) = $4::text THEN substr(f.source_session, length($4::text) + 1)
         WHEN f.source = $5::text AND left(f.source_session, length($6::text)) = $6::text THEN substr(f.source_session, length($6::text) + 1) END)))`,
    [[...new Set(ids.map(Number))], [...pageTypes], syncSource, syncPrefix, putSource, putPrefix]);
  return rows.map(r => Number(r.id));
}

/** Of `ids`, the facts whose stored tier ranks at or above `floor` (an unknown stored tier ranks 0); an id with no row is absent. */
export async function listFactIdsAtTrustFloor(raw: EngineRawRead, ids: readonly number[], floor: TrustTier): Promise<number[]> {
  if (!ids.length) return [];
  if (!isTrustTier(floor)) throw new Error(`listFactIdsAtTrustFloor: unknown trust tier ${JSON.stringify(floor)}`);
  const { text, params } = renderFragment(sqlFragment`SELECT id FROM facts WHERE id = ANY(${[...new Set(ids.map(Number))]}::bigint[]) AND ${trustedSql(trustRankSql('trust_tier'))} >= ${TRUST_TIER_RANK[floor]}`);
  const rows = await raw<{ id: number | string }>(text, params);
  return rows.map(r => Number(r.id));
}

/** Each page id's stored type, deleted or not; an id with no page is absent. */
export async function readPageTypesByIds(raw: EngineRawRead, ids: readonly number[]): Promise<Array<{ id: number; type: string | null }>> {
  if (!ids.length) return [];
  const rows = await raw<{ id: number | string; type: string | null }>('SELECT id, type FROM pages WHERE id = ANY($1::bigint[])', [[...new Set(ids.map(Number))]]);
  return rows.map(r => ({ id: Number(r.id), type: r.type }));
}

const READABLE_PAGE_SLUGS_HEAD = 'SELECT p.slug FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND ';

/**
 * Of `slugs` in source `sourceId`, the live pages `scope`'s read policy admits (its source filter is not applied: the
 * source is `sourceId`), at most `limit` (search/slot-history.ts entityKeys).
 */
export async function listReadablePageSlugs(raw: EngineRawRead, sourceId: string, slugs: readonly string[], scope: PageReadScope,
  limit: number): Promise<string[]> {
  if (!Number.isFinite(limit)) throw new Error(`listReadablePageSlugs: limit must be a finite number, got ${limit}`);
  const params: unknown[] = [sourceId, [...slugs]];
  const filter = pageReadFilter('p', { ...scope, sourceId: undefined, sourceIds: undefined }, params, true);
  const rows = await raw<{ slug: string }>(`${READABLE_PAGE_SLUGS_HEAD}${filter} LIMIT ${limit}`, params);
  return rows.map(r => r.slug);
}
