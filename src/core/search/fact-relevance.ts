/**
 * Question relevance for saved facts, shared by recall's `question` ranking
 * (src/core/facts/question-recall.ts) and the temporal fact reserve
 * (facts-arm.ts `applyTemporalFactReserve`); the `query` facts arm reads the
 * same candidate pool and keeps its own match rule.
 *
 * Candidates: one bounded pool per call under the caller's read policy
 * (source scope, active rows, audit rows excluded, quarantine and rederive
 * hiding, the trust floor, remote world-only plus the private-provenance
 * filter), optionally narrowed by recall's filters (entity pairs, session,
 * event-time since, escaped grep) inside the SQL. Three arms fill it: keyword
 * (FTS over fact text and entity), cosine (nearest by the question embedding,
 * cast to the facts column type) and the facts of the one entity page the
 * question names, constrained to that page's source.
 *
 * Score: cosine + term share + DATED_BONUS when the writer supplied the date.
 * Term share counts whole words, and its denominator grows with a long fact's
 * own term count, so a fact stuffed with common words cannot match most
 * questions. Order: score, then newest valid_from, then id.
 *
 * Errors: a missing embedding column or a dimension mismatch skips the cosine
 * arm (expected on old or migrating brains); any other database error throws,
 * and each caller picks its policy.
 */
import type { BrainEngine } from '../engine.ts';
import type { TrustTier } from '../trust/tier.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { factsFtsDocument, getFtsLanguage } from '../fts-language.ts';
import { getEmbeddingModel } from '../ai/gateway.ts';
import { privateProvenanceFilterFragment } from './private-visibility.ts';
import { quarantinedProvenanceFilterFragment } from '../quarantine.ts';
import { namedEntity } from './entity-anchor.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { escapeLikePattern } from '../cjk.ts';
import { supportsHnswIterativeScan } from '../vector-index.ts';
import { VECTOR_EXTENSION_VERSION_SQL } from './vector-statement.ts';
import { withVectorSettings } from './vector-settings.ts';
import type { HnswIterativeScanMode } from './hnsw-iterative-scan.ts';

const STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'our', 'your', 'their',
  'now', 'current', 'currently', 'should', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'next', 'use', 'uses', 'tell']);
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'-]+/gu;

/** The question's content terms: distinct words of 3+ characters, stopwords dropped, at most 12. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(WORD_RE) ?? [])].filter(t => t.length >= 3 && !STOPWORDS.has(t)).slice(0, 12);
}

export const DATED_BONUS = 0.1;
/** valid_from this far from created_at means the writer supplied the date. */
const DATED_MIN_MS = 24 * 60 * 60 * 1000;
/** A fact with more content terms than this many times the question's has its term share scaled down (term stuffing). */
export const TERM_STUFFING_RATIO = 3;

/** The two preregistered admission rules; dev picks one (`recall.question_admission`). */
export const QUESTION_ADMISSION_RULES = ['reserve', 'facts_arm'] as const;
export type QuestionAdmissionRule = (typeof QUESTION_ADMISSION_RULES)[number];
const RESERVE_COSINE_MIN = 0.5;
const RESERVE_TERM_SHARE_MIN = 0.34;
const FACTS_ARM_COSINE_MIN = 0.6;

export interface FactPoolScope {
  sourceId?: string; sourceIds?: string[]; remote: boolean;
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
}

export interface FactPoolOpts {
  depth: { keyword: number; cosine: number; entity: number };
  filters?: FactPoolFilters;
  /** Score every candidate's cosine, whichever arm found it (recall and the reserve); the facts arm keeps cosine-arm-only similarity. */
  cosineForAll?: boolean;
  /** Set for filtered recall pools: hnsw.ef_search sized to the depth plus pgvector's iterative scan when supported. */
  hnswIterativeScan?: HnswIterativeScanMode;
}

export interface FactCandidate {
  id: number; fact: string; kind: string; entity_slug: string | null; source_id: string; source: string;
  valid_from: Date | string; valid_until: Date | string | null; created_at?: Date | string | null; claim_metric: string | null; claim_period: string | null;
  similarity?: number;
  /** Found by the named-entity arm. */
  entity: boolean;
}

export interface FactPool {
  candidates: FactCandidate[];
  /** Whether the cosine arm ran (an embedding was given and the facts column can be compared with it). */
  cosine: boolean;
  /** Whether the facts table has an embedding column (probed only when an embedding was given). */
  column: boolean;
}

const COLS = 'f.id, f.fact, f.kind, f.entity_slug, f.source_id, f.source, f.valid_from, f.valid_until, f.created_at, f.claim_metric, f.claim_period';

/** The facts embedding column's type and declared dimensions, or null when there is none. */
async function factsEmbeddingColumn(engine: BrainEngine): Promise<{ type: string; dims: number } | null> {
  const [row] = await engine.executeRaw<{ type: string; dims: number }>(
    `SELECT t.typname AS type, a.atttypmod AS dims FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
     WHERE a.attrelid = to_regclass('facts') AND a.attname = 'embedding' AND NOT a.attisdropped`);
  return row && (row.type === 'vector' || row.type === 'halfvec') ? { type: row.type, dims: Number(row.dims) } : null;
}

/**
 * The pool's WHERE clause and its bound params ($1.. in order): the caller's
 * read policy plus the filters. Arms append their own params after these.
 */
function poolPredicate(scope: FactPoolScope, filters: FactPoolFilters | undefined): { where: string; params: unknown[] } {
  const params: unknown[] = [scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'], [...AUDIT_ROW_SOURCES]];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const clauses = [
    'f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL',
    '(f.valid_until IS NULL OR f.valid_until > now()) AND f.source != ALL($2::text[])',
    quarantinedProvenanceFilterFragment('f'),
    ...(scope.remote ? [`f.visibility = 'world'`] : []),
    ...(scope.excludePrivate ? [privateProvenanceFilterFragment('f')] : []),
    projectionEligibleSql('facts', 'f', { floor: scope.minTrust, suppressFlagged: scope.suppressFlagged }),
  ];
  if (filters?.entities) {
    clauses.push(`(f.source_id, f.entity_slug) IN (SELECT * FROM unnest(${bind(filters.entities.map(e => e.sourceId))}::text[], ${bind(filters.entities.map(e => e.slug))}::text[]))`);
  }
  if (filters?.sessionId) clauses.push(`f.source_session = ${bind(filters.sessionId)}`);
  if (filters?.since) clauses.push(`COALESCE(f.valid_from, f.created_at) >= ${bind(filters.since.toISOString())}::text::timestamptz`);
  if (filters?.grep?.trim()) clauses.push(`f.fact ILIKE ${bind(`%${escapeLikePattern(filters.grep.trim())}%`)} ESCAPE '\\'`);
  return { where: clauses.join(' AND '), params };
}

/** The comparable-embedding predicate: same model, current text hash, same dimensions (`dims` null when the column declares the query's). */
const comparable = (model: string, dims: string | null) =>
  `f.embedding IS NOT NULL AND f.embedding_model = ${model} AND f.embedded_text_hash = md5(f.fact)${dims ? ` AND vector_dims(f.embedding) = ${dims}` : ''}`;

/**
 * Run with a custom plan per call. A cached generic plan (PGLite reuses named
 * statements) cannot see the source arrays, estimates one matching fact and
 * nests the policy anti-joins over every match: about 9x slower at 100k facts.
 */
function customPlan<T>(engine: BrainEngine, sql: string, params: unknown[]): Promise<T[]> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL plan_cache_mode = force_custom_plan');
    return tx.executeRaw<T>(sql, params);
  });
}

/**
 * The bounded candidate pool for `question`. Throws on a database error
 * (callers choose fail-open or `unavailable`).
 */
export async function collectFactCandidates(engine: BrainEngine, question: string, scope: FactPoolScope, queryEmbedding: Float32Array | null | undefined,
  opts: FactPoolOpts): Promise<FactPool> {
  const terms = queryTerms(question);
  const { where, params } = poolPredicate(scope, opts.filters);
  const column = queryEmbedding?.length ? await factsEmbeddingColumn(engine) : null;
  const cosine = !!column && (column.dims <= 0 || column.dims === queryEmbedding!.length);
  const armParams = (extra: unknown[]) => [...params, ...extra];
  const vec = cosine ? { lit: `[${Array.from(queryEmbedding!).join(',')}]`, cast: column!.type === 'halfvec' ? '::halfvec' : '::vector' } : null;
  const n = params.length;
  const simParams = vec ? [vec.lit, getEmbeddingModel(), queryEmbedding!.length] : [];
  const simSql = vec ? `CASE WHEN ${comparable(`$${n + 2}`, `$${n + 3}`)} THEN 1 - (f.embedding <=> $${n + 1}${vec.cast}) END AS similarity` : 'NULL::float8 AS similarity';
  const allSim = vec && opts.cosineForAll;
  const found = new Map<number, FactCandidate>();
  const add = (rows: Array<FactCandidate & { similarity?: number | null }>, entity = false) => {
    for (const r of rows) {
      const prev = found.get(Number(r.id));
      const sim = r.similarity === null || r.similarity === undefined ? prev?.similarity : Number(r.similarity);
      found.set(Number(r.id), { ...r, id: Number(r.id), similarity: sim, entity: entity || !!prev?.entity });
    }
  };

  type Row = FactCandidate & { similarity?: number | null };
  const keyword = async (): Promise<Row[]> => {
    if (!terms.length) return [];
    const p = armParams(allSim ? simParams : []);
    const doc = factsFtsDocument('f');
    const tsq = `NULLIF(replace(plainto_tsquery('${getFtsLanguage()}'::regconfig, $${p.length + 1})::text, ' & ', ' | '), '')::tsquery`;
    return customPlan<Row>(engine,
      `SELECT ${COLS}, ${allSim ? simSql : 'NULL::float8 AS similarity'} FROM facts f WHERE ${where} AND ${doc} @@ ${tsq}
       ORDER BY ts_rank_cd(${doc}, ${tsq}) DESC, f.valid_from DESC, f.id DESC LIMIT $${p.length + 2}`,
      [...p, terms.join(' '), opts.depth.keyword]);
  };
  const nearest = async (): Promise<Row[]> => {
    if (!vec) return [];
    const p = armParams(simParams);
    const sql = `SELECT ${COLS}, ${simSql} FROM facts f WHERE ${where} AND f.embedding IS NOT NULL AND f.embedding_model = $${n + 2}${column!.dims > 0 ? '' : ` AND vector_dims(f.embedding) = $${n + 3}`}
       ORDER BY f.embedding <=> $${n + 1}${vec.cast} LIMIT $${p.length + 1}`;
    const bound = [...p, opts.depth.cosine];
    if (!opts.hnswIterativeScan) return engine.executeRaw<Row>(sql, bound);
    return engine.transaction(async tx => {
      const iterative = opts.hnswIterativeScan !== 'off'
        && supportsHnswIterativeScan((await tx.executeRaw<{ extversion: string }>(VECTOR_EXTENSION_VERSION_SQL))[0]?.extversion);
      return withVectorSettings((s, v) => tx.executeRaw(s, v), iterative, opts.depth.cosine, 20_000,
        () => tx.executeRaw<Row>(sql, bound), undefined, opts.hnswIterativeScan);
    });
  };
  const entityFacts = async (): Promise<Row[]> => {
    const sourceIds = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'];
    const named = await namedEntity(engine, question, { sourceIds, excludePrivate: scope.excludePrivate });
    if (!named) return [];
    const p = armParams(allSim ? simParams : []);
    return engine.executeRaw<Row>(
      `SELECT ${COLS}, ${allSim ? simSql : 'NULL::float8 AS similarity'} FROM facts f WHERE ${where} AND f.source_id = $${p.length + 1} AND f.entity_slug = $${p.length + 2}
       ORDER BY f.valid_from DESC, f.id DESC LIMIT $${p.length + 3}`,
      [...p, named.source_id, named.slug, opts.depth.entity]);
  };
  // Independent arms run concurrently (separate connections on Postgres); merged in a fixed order.
  const [byKeyword, byCosine, byEntity] = await Promise.all([keyword(), nearest(), entityFacts()]);
  add(byKeyword);
  add(byCosine);
  add(byEntity, true);
  return { candidates: [...found.values()], cosine, column: !!column };
}

/**
 * Facts in the same authorized, filtered pool that the cosine arm cannot
 * compare (no vector, another model, a stale text hash or other
 * dimensions), per source. Only meaningful when an embedding was compared.
 */
export async function countUncomparableFacts(engine: BrainEngine, scope: FactPoolScope, filters: FactPoolFilters | undefined, dims: number): Promise<Array<{ source_id: string; n: number }>> {
  const { where, params } = poolPredicate(scope, filters);
  const model = `$${params.length + 1}`;
  const column = await factsEmbeddingColumn(engine);
  if (!column) return [];
  const declared = column.dims === dims;
  // Cheap candidates first (idx_facts_unembedded, idx_facts_embedding_model), then the read policy on those rows only.
  const uncomparable = declared
    ? `SELECT f.id FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND (f.embedding IS NULL OR f.embedded_text_hash IS DISTINCT FROM md5(f.fact))
       UNION SELECT f.id FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND (f.embedding_model IS NULL OR f.embedding_model < ${model} OR f.embedding_model > ${model})`
    : `SELECT f.id FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND NOT (${comparable(model, `$${params.length + 2}`)})`;
  const rows = await customPlan<{ source_id: string; n: number | string }>(engine,
    `WITH u AS MATERIALIZED (${uncomparable})
     SELECT f.source_id, count(*) AS n FROM facts f WHERE f.id IN (SELECT id FROM u) AND ${where}
     GROUP BY f.source_id ORDER BY count(*) DESC, f.source_id`, [...params, getEmbeddingModel(), ...(declared ? [] : [dims])]);
  return rows.map(r => ({ source_id: r.source_id, n: Number(r.n) }));
}

/** The distinct (source_id, entity_slug) pairs with a fact in the authorized, filtered pool (the namesake check runs on these before any ranking). */
export async function poolEntityPairs(engine: BrainEngine, scope: FactPoolScope, filters: FactPoolFilters): Promise<Array<{ source_id: string; entity_slug: string }>> {
  const { where, params } = poolPredicate(scope, filters);
  return engine.executeRaw<{ source_id: string; entity_slug: string }>(
    `SELECT DISTINCT f.source_id, f.entity_slug FROM facts f WHERE ${where} AND f.entity_slug IS NOT NULL ORDER BY f.source_id, f.entity_slug`, params);
}

export interface ScoredFact {
  candidate: FactCandidate;
  cosine: number;
  /** Whole-word content terms of the question the fact holds. */
  matched: number;
  /** The question's content-term count. */
  terms: number;
  termShare: number;
  score: number;
}

const wordsOf = (c: FactCandidate) => {
  const slug = c.entity_slug ?? '';
  return new Set(`${c.fact} ${slug} ${slug.replace(/-/g, ' ')}`.toLowerCase().match(WORD_RE) ?? []);
};

export const isDatedFact = (f: Pick<FactCandidate, 'valid_from' | 'created_at'>) =>
  !!f.created_at && Math.abs(new Date(f.valid_from).getTime() - new Date(f.created_at).getTime()) > DATED_MIN_MS;

/** Score every candidate (cosine + term share + DATED_BONUS when dated), ordered by score, newest valid_from, then id. */
export function scoreFactCandidates(question: string, candidates: FactCandidate[]): ScoredFact[] {
  const terms = queryTerms(question);
  return candidates.map(c => {
    const words = wordsOf(c);
    const matched = terms.filter(t => words.has(t)).length;
    const factTerms = [...words].filter(w => w.length >= 3 && !STOPWORDS.has(w)).length;
    const termShare = terms.length ? matched / Math.max(terms.length, Math.ceil(factTerms / TERM_STUFFING_RATIO)) : 0;
    const cosine = c.similarity ?? 0;
    return { candidate: c, cosine, matched, terms: terms.length, termShare, score: cosine + termShare + (isDatedFact(c) ? DATED_BONUS : 0) };
  }).sort((a, b) => b.score - a.score
    || new Date(b.candidate.valid_from).getTime() - new Date(a.candidate.valid_from).getTime()
    || b.candidate.id - a.candidate.id);
}

/** Whether a scored fact passes the admission rule. */
export function admitted(s: ScoredFact, rule: QuestionAdmissionRule): boolean {
  if (rule === 'reserve') return s.cosine >= RESERVE_COSINE_MIN || s.termShare >= RESERVE_TERM_SHARE_MIN;
  return s.candidate.entity || s.cosine >= FACTS_ARM_COSINE_MIN
    || (s.terms > 0 && s.matched >= Math.max(Math.min(2, s.terms), Math.ceil(s.terms / 2)));
}
